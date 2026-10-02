import createDebug from 'debug';
import type {
  AllocatedDevice,
  AllocationCriteria,
  AppInfo,
  Bounds,
  ConnectionConfig,
  DeviceInfo,
  DeviceSettings,
  DeviceType,
  FoldState,
  Geolocation,
  GestureSequence,
  HardwareButton,
  LaunchOptions,
  ListDevicesOptions,
  MobilewrightDriver,
  Orientation,
  Platform,
  RecordingOptions,
  RecordingResult,
  ScreenSize,
  ScreenshotOptions,
  Session,
  SwipeDirection,
  SwipeOptions,
  ViewNode,
  WebViewBridge,
} from '@mobilewright/protocol';
import { NoDeviceAvailableError, osVersionSatisfies } from '@mobilewright/protocol';
import { DEFAULT_REGION, GATEWAY_RETRY_DELAYS_MS, RestClient, SauceApiError, sauceJobUrl, type ArtifactToggles, type Region } from './rest-client.js';
import { currentPlaywrightTest, type CurrentTest } from './playwright-test-info.js';
import { HostedAppiumWebViews } from './webview.js';
import { parseXmlTree } from './xml.js';
import { DeviceControlSocket } from './device-control-socket.js';
import { CompanionSocket } from './companion-socket.js';
import { WdaClient } from './wda-client.js';
import { SauceConnect, stopSauceConnectTunnels, type SauceConnectOptions } from './sauce-connect.js';
import { redact, sleep } from './util.js';

const debug = createDebug('mw:mobilewright-driver');

/** A custom WebDriverAgent runner zip, like `iosWdaStorageRef`. */
const CUSTOM_WDA_URL = process.env['SAUCE_IOS_WDA_URL'];

/** WebDriverAgent runner launched when the one on the device doesn't answer. */
const DEFAULT_WDA_URL =
  CUSTOM_WDA_URL ??
  'https://github.com/appium/WebDriverAgent/releases/download/v15.0.0/WebDriverAgentRunner-Runner.zip';

/** `SAUCE_LIVE_VIEW=1` prints each session's live-view URL. */
const SHOW_LIVE_VIEW = process.env['SAUCE_LIVE_VIEW'] === '1';

export interface SauceLabsDriverOptions {
  /** Falls back to SAUCE_USERNAME env var when omitted. */
  username?: string;
  /** Falls back to SAUCE_ACCESS_KEY env var when omitted. */
  accessKey?: string;
  region?: Region;
  /** ms to wait for a session to become ACTIVE. Default: 300000. */
  allocationTimeout?: number;
  /**
   * Maximum session length, ISO-8601 (e.g. `PT1H`). Limits:
   * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/#session-duration
   */
  sessionDuration?: string;
  /** iOS, private devices: bundle id of a custom WebDriverAgent to launch instead of the one on the device. */
  iosWdaBundleId?: string;
  /**
   * iOS, private devices: a custom WebDriverAgent runner to install and launch instead of the one on the
   * device, as a `storage:<id>` ref or an `https://` zip URL. `SAUCE_IOS_WDA_URL` does the same.
   */
  iosWdaStorageRef?: string;
  /**
   * Report each Playwright test to the Sauce Labs Test Results page. Default: true.
   * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/
   */
  reportTests?: boolean;
  /** Build name the reported tests are grouped under in Sauce Labs. */
  build?: string;
  /** Tags attached to every reported test. */
  tags?: string[];
  /** What Sauce Labs captures per reported test. Video, screenshots and device logs are on by default. */
  artifacts?: Pick<ArtifactToggles, 'video' | 'screenshots' | 'deviceLogs' | 'networkCapture'>;
  /** Hosted Appium version used for webviews. */
  appiumVersion?: string;
  /** Starts a Sauce Connect tunnel for the run, so devices can reach hosts only this machine reaches. */
  sauceConnect?: boolean;
  /** Options for the tunnel `sauceConnect` starts. */
  sauceConnectOpts?: SauceConnectOptions;
  /** Name of a Sauce Connect tunnel already running, for sessions to use (when `sauceConnect` is off). */
  tunnelName?: string;
  /**
   * Owner of `tunnelName`, when another user of the organization shares it.
   * https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/sharing-tunnel/
   */
  tunnelOwner?: string;
  /** @internal Test hook replacing Playwright's test.info(). */
  _currentTest?: () => CurrentTest | undefined;
}

// ─── Hardware buttons ─────────────────────────────────────────────────────────

// Socket keys can arrive after a following REST call (a HOME after launchApp() sent the app away), so buttons
// go through adb (Android) or WDA (iOS) when they can; the socket is the fallback.
const BUTTON_KEY: Partial<Record<HardwareButton, string>> = {
  HOME: 'Sauce_Home_Key',
  BACK: 'Sauce_Back_Key',
  APP_SWITCH: 'Sauce_Menu_Key',
};

// Android key events used by clearText(). `input keycombination` needs Android 13 (API 33) or later.
const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_A = 29;
const KEYCODE_DEL = 67;
const KEYCODE_MOVE_END = 123;
const ANDROID_13_SDK = 33;

// Android key events for `input keyevent`
const BUTTON_KEYEVENT: Partial<Record<HardwareButton, number>> = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  LOCK: 26,
  ENTER: 66,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
};

// WDA button names
const BUTTON_WDA: Partial<Record<HardwareButton, string>> = {
  HOME: 'home',
  VOLUME_UP: 'volumeUp',
  VOLUME_DOWN: 'volumeDown',
  POWER: 'power',
  LOCK: 'power',
};

// ─── Session state ────────────────────────────────────────────────────────────

interface ActiveSession {
  sauceSessionId: string;
  /** True if this driver created the session and deletes it on disconnect; false for a pool session. */
  ownsSession: boolean;
  platform: Platform;
  deviceId: string;
  resolutionWidth: number;
  resolutionHeight: number;
  pixelsPerPoint: number;
  currentOrientation: 'PORTRAIT' | 'LANDSCAPE';
  ioSocket: DeviceControlSocket;
  companionSocket: CompanionSocket;
  wdaClient: WdaClient | null;
  /** What this driver did to the focused text field since the last tap. See `androidFieldValues()`. */
  textInput: TextInputState;
  /** Android launcher activities resolved by launchApp(), by package. */
  launcherActivities: Map<string, string>;
  /** The Sauce Labs test started for the running Playwright test, ended on disconnect(). */
  reportedTest?: { name: string; jobId?: string };
  /** Webview access through hosted Appium, created on first use of webViewBridge. */
  webViews?: HostedAppiumWebViews;
  /** Android API level, read once by clearText(). */
  androidSdk?: number;
}

/** What the driver did to the focused text field since the last tap; `typed` is null after keys with unknown effect. */
interface TextInputState {
  cleared: boolean;
  typed: string | null;
  /** iOS: rect of the field clearText() cleared (WDA's page source doesn't mark the focused field). */
  clearedBounds?: Bounds;
}

/** Android classes whose `text` is user-editable content rather than a label. */
const ANDROID_EDITABLE_CLASS = /(?:EditText|AutoCompleteTextView)$/;

/**
 * Sets `value` on Android text fields. `uiautomator dump` reports an empty field's hint as its text, so:
 *   - Android 16+ (`hint` attribute): text equal to the hint means empty, unless the driver just typed it.
 *   - Older: the focused field is empty after clearText() until something is typed or tapped.
 */
export function androidFieldValues(nodes: ViewNode[], state: TextInputState): ViewNode[] {
  for (const node of nodes) {
    if (ANDROID_EDITABLE_CLASS.test(node.type)) {
      const text = node.text ?? '';
      const hint = typeof node.raw?.['hint'] === 'string' ? node.raw['hint'] : '';
      let empty: boolean;
      if (hint) {
        node.placeholder = hint;
        empty = text === hint && !(node.isFocused && state.typed === text);
      } else {
        empty = text === '' || (node.isFocused === true && state.cleared);
      }
      node.value = empty ? undefined : text;
    }
    androidFieldValues(node.children ?? [], state);
  }
  return nodes;
}

/**
 * Sauce Labs matches `deviceName` against the whole device id or name, while a Mobilewright pattern only has
 * to occur in it. Anchors inside still work, since `.*` can match nothing.
 */
export function toSauceDeviceNameQuery(pattern: string): string {
  return `.*(?:${pattern}).*`;
}

/** iOS element types whose `value` is user-editable text. */
const IOS_TEXT_FIELD_TYPE = /^XCUIElementType(?:TextField|SecureTextField|SearchField|TextView)$/;

const centerInside = (a: Bounds, b: Bounds) => {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
};
/**
 * The same field from two sources: WDA's rect of the cleared element can differ from the page source's by a few
 * points (seen on iOS 26.7), so each center must lie inside the other rect. A neighboring field or a container
 * doesn't pass both ways.
 */
const sameField = (a: Bounds, b: Bounds) => centerInside(a, b) && centerInside(b, a);

/**
 * Clears `value` on iOS text fields showing their placeholder, which WDA reports as the value:
 *   - with `placeholderValue`: a value equal to it means empty, unless the driver just typed it.
 *   - without: the field clearText() cleared (found by its rect) is empty until something is typed or tapped.
 */
export function iosFieldValues(nodes: ViewNode[], state: TextInputState): ViewNode[] {
  for (const node of nodes) {
    if (IOS_TEXT_FIELD_TYPE.test(node.type)) {
      const showingPlaceholder = !!node.placeholder && node.value === node.placeholder && state.typed !== node.value;
      const justCleared = state.cleared && !!state.clearedBounds && sameField(node.bounds, state.clearedBounds);
      if (showingPlaceholder || justCleared) node.value = undefined;
    }
    iosFieldValues(node.children ?? [], state);
  }
  return nodes;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Real Device Access API only has real devices. */
function assertRealDeviceType(deviceType: DeviceType | undefined): void {
  if (deviceType && deviceType !== 'real') {
    throw new Error(`Sauce Labs only provides real devices; deviceType "${deviceType}" is not available. Use "real" or leave it unset.`);
  }
}

/** Packages of the tooling on Sauce Labs Android devices, left out of listApps(). */
const SAUCE_INFRASTRUCTURE_PACKAGES = [
  /^org\.testobject\./,
  /^com\.saucelabs\./,
  /^com\.sauce\./,
  /^androidx\.test\.(orchestrator|services)$/,
  /^com\.genymobile\.gnirehtet$/,
  /^com\.android\.talkback$/,
  /^com\.google\.android\.apps\.work\.clouddpc$/,
];

function isSauceInfrastructurePackage(bundleId: string): boolean {
  return SAUCE_INFRASTRUCTURE_PACKAGES.some((re) => re.test(bundleId));
}

/** An Android package name, checked before it goes into a shell command. */
export function androidPackage(name: string): string {
  if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(name)) throw new Error(`Not a valid Android package name: "${name}"`);
  return name;
}

/** `.Settings` in package `com.android.settings` → `com.android.settings.Settings`. */
const qualifyActivity = (packageName: string, activity: string) => (activity.startsWith('.') ? packageName + activity : activity);

/** Parses `cmd package resolve-activity --brief`, whose last line is `<package>/<activity>`. */
export function parseResolvedActivity(output: string, packageName: string): string | undefined {
  for (const line of output.split('\n').map((l) => l.trim()).reverse()) {
    if (line.startsWith(`${packageName}/`)) return qualifyActivity(packageName, line.slice(packageName.length + 1));
  }
  return undefined;
}

/** Parses `dumpsys package <pkg>`: the first activity whose intent filter has the LAUNCHER category. */
export function parseDumpsysLauncherActivity(output: string, packageName: string): string | undefined {
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const entry = line.match(/^\s*[0-9a-f]+ ([\w.]+)\/(\S+) filter /);
    if (entry) {
      current = entry[1] === packageName ? qualifyActivity(packageName, entry[2]) : undefined;
    } else if (current && line.includes('Category: "android.intent.category.LAUNCHER"')) {
      return current;
    }
  }
  return undefined;
}

/** Opens a WebSocket, retrying a handshake that gets a 5xx or hits a network error. */
export async function connectRetryingGatewayErrors(connect: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect();
    } catch (err) {
      const delay = GATEWAY_RETRY_DELAYS_MS[attempt];
      const transient = /Unexpected server response: 50[234]\b|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed out/;
      if (!transient.test((err as Error).message) || delay === undefined) throw err;
      debug('%s, retrying in %dms', (err as Error).message, delay);
      await sleep(delay);
    }
  }
}

/** An app reference Sauce Labs resolves itself: a `storage:` ref or an `http(s)://` URL it downloads. */
function isRemoteApp(app: string): boolean {
  return /^(storage:|https?:\/\/)/i.test(app);
}

/** The default display's size (`init=WxH` of display 0) from `dumpsys window displays`, which lists other displays too. */
export function parseAndroidDisplaySize(dumpsys: string): { width: number; height: number } | undefined {
  const sections = dumpsys.split(/(?=Display: mDisplayId=)/);
  const main = sections.find((section) => /^Display: mDisplayId=0\b/.test(section));
  const match = main?.match(/\binit=(\d+)x(\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/** Attempts at `uiautomator dump` before a dump without a hierarchy is taken as an empty screen. */
const UIAUTOMATOR_DUMP_ATTEMPTS = 3;
const UIAUTOMATOR_DUMP_RETRY_MS = 500;

const RECORDING_NOT_SUPPORTED =
  'The driver records no video: Sauce Labs records each test\'s video (see the "Sauce Labs" link in the report).';

/** How long tap() holds the touch: an iOS switch ignores a touch that goes down and up at once. */
const TAP_HOLD_MS = 100;

/** How long setOrientation() waits for the device to show the requested orientation. */
const ORIENTATION_SETTLE_TIMEOUT_MS = 10_000;

/** Orientation from `dumpsys window displays`: mCurrentRotation=ROTATION_90/270 (or mRotation=1/3) is landscape. */
export function parseAndroidRotation(dumpsys: string): 'PORTRAIT' | 'LANDSCAPE' | undefined {
  const named = dumpsys.match(/mCurrentRotation=ROTATION_(\d+)/);
  const degrees = named ? Number(named[1]) : undefined;
  const index = degrees === undefined ? dumpsys.match(/mRotation=(\d)/)?.[1] : undefined;
  if (degrees === undefined && index === undefined) return undefined;
  const quarterTurns = degrees !== undefined ? degrees / 90 : Number(index);
  return quarterTurns % 2 === 1 ? 'LANDSCAPE' : 'PORTRAIT';
}

const RETRY_INITIAL_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

/** Artifacts captured for reported tests unless the `artifacts` option turns them off. */
const DEFAULT_ARTIFACTS: ArtifactToggles = { video: true, screenshots: true, deviceLogs: true };

/** Exponential backoff for session-creation retries: 5s, 10s, 20s, … capped at 60s, with ±20% jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => new Error('Aborted while waiting for a Sauce Labs device to become available');
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

/** Maps a failed `POST /sessions` to the error the device pool should see. See `SauceLabsDriver.createSession`. */
export function classifyCreateSessionError(err: unknown, platform: Platform, deviceName?: string): unknown {
  if (!(err instanceof SauceApiError)) return err;
  const query = `platform=${platform}${deviceName ? `, deviceName=/${deviceName}/` : ''}`;
  const reason = err.detail ?? err.title ?? err.message;

  if (err.status === HTTP_CONFLICT) {
    return new NoDeviceAvailableError(
      `Sauce Labs concurrency limit reached (${err.title ?? 'HTTP 409'}), waiting for a device to be released: ${reason}`,
    );
  }
  if (err.status === HTTP_BAD_REQUEST && Array.isArray(err.body?.['unavailableDevices'])) {
    const busy = (err.body['unavailableDevices'] as unknown[]).join(', ');
    return new NoDeviceAvailableError(`All Sauce Labs devices matching ${query} are busy (${busy}), waiting for one to free up`);
  }
  if (err.status === HTTP_BAD_REQUEST && err.body?.['deviceQuery'] !== undefined) {
    return new Error(
      `No Sauce Labs device matches ${query} (query evaluated as ${JSON.stringify(err.body['deviceQuery'])}): ${reason}`,
      { cause: err },
    );
  }
  return err;
}

/** A Sauce Labs session ended (ERRORED or CLOSED) before it became ACTIVE. */
export class SessionTerminatedError extends Error {
  constructor(readonly sessionId: string, readonly state: string, readonly reason?: string) {
    super(`Session ${sessionId} reached terminal state: ${state}${reason ? `: ${reason}` : ''}`);
    this.name = 'SessionTerminatedError';
  }
}

/** A session that ended ERRORED while starting: it can't be deleted and holds no device. */
function isErroredSession(err: unknown): boolean {
  return err instanceof SessionTerminatedError && err.state === 'ERRORED';
}

/** An ERRORED session a new one may replace: not for a Sauce Connect problem, which a retry won't change. */
function isRetriableErroredSession(err: unknown): boolean {
  return isErroredSession(err) && !/tunnel|Sauce Connect/i.test((err as SessionTerminatedError).reason ?? '');
}

/** Additional session-creation attempts when a session ends ERRORED while starting. */
const ERRORED_SESSION_RETRIES = 1;

/** Polls a session every 5 seconds until it's ACTIVE with its socket links; throws on timeout or a terminal state. */
export async function waitForActiveSession(
  rest: RestClient,
  sessionId: string,
  timeout: number,
  opts: { skipInitialDelay?: boolean; signal?: AbortSignal } = {},
): Promise<import('./rest-client.js').Session> {
  const pollInterval = 5_000;
  const deadline = Date.now() + timeout;

  // A new session is rarely ACTIVE at once, so the first poll waits, unless the session is likely ACTIVE already.
  if (!opts.skipInitialDelay) {
    await sleep(pollInterval);
  }

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error(`Aborted while waiting for session ${sessionId} to become ACTIVE`);
    const s = await rest.getSession(sessionId);
    const hasLinks = !!(s.links?.ioWebsocketUrl && s.links?.eventsWebsocketUrl);
    debug('polling session %s state=%s links=%s', sessionId, s.state, hasLinks);
    if (s.state === 'ACTIVE' && hasLinks) return s;
    if (s.state === 'ERRORED' || s.state === 'CLOSED') {
      throw new SessionTerminatedError(sessionId, s.state, s.error?.message);
    }
    await sleep(pollInterval);
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become ACTIVE`);
}

function resolveCredentials(optionUsername?: string, optionAccessKey?: string): { username: string; accessKey: string } {
  const username = optionUsername ?? process.env['SAUCE_USERNAME'];
  const accessKey = optionAccessKey ?? process.env['SAUCE_ACCESS_KEY'];
  if (!username) throw new Error('Sauce Labs username is required. Set options.username or SAUCE_USERNAME env var.');
  if (!accessKey) throw new Error('Sauce Labs access key is required. Set options.accessKey or SAUCE_ACCESS_KEY env var.');
  return { username, accessKey };
}

// ─── Helper parsers ───────────────────────────────────────────────────────────

function parseOrientation(value: string | undefined): 'PORTRAIT' | 'LANDSCAPE' {
  return value?.toUpperCase() === 'LANDSCAPE' ? 'LANDSCAPE' : 'PORTRAIT';
}

function sauceOrientationToProtocol(o: 'PORTRAIT' | 'LANDSCAPE'): Orientation {
  return o === 'LANDSCAPE' ? 'landscape' : 'portrait';
}

function protocolOrientationToSauce(o: Orientation): 'PORTRAIT' | 'LANDSCAPE' {
  return o === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT';
}

/** Parses `pm list packages -3`. */
function parsePmListPackages(stdout: string): AppInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => ({ bundleId: line.slice('package:'.length).trim() }));
}

/** The foreground package from `dumpsys window` (`mCurrentFocus=Window{… <package>/<activity>}`, or `mResumedActivity`). */
function parseForegroundApp(stdout: string): AppInfo {
  for (const line of stdout.split('\n')) {
    const winMatch = line.match(/mCurrentFocus=Window\{[^}]+ ([^/\s}]+)\//);
    if (winMatch) return { bundleId: winMatch[1] };
    const actMatch = line.match(/mResumedActivity[=: ]+ActivityRecord\{[^ ]+ [^ ]+ ([^/]+)\//);
    if (actMatch) return { bundleId: actMatch[1] };
  }
  return { bundleId: '' };
}

// ─── Open sessions ────────────────────────────────────────────────────────────

/** Sauce Labs sessions this process started and hasn't closed yet, by id. */
export const openSessions = new Map<string, RestClient>();
const SIGNAL_CLEANUP_TIMEOUT_MS = 10_000;
let signalCleanupInstalled = false;

/**
 * Tracks a session so it's deleted if the process is interrupted (SIGINT, SIGTERM): otherwise it keeps its
 * device until Sauce Labs times it out.
 */
function trackOpenSession(sessionId: string, rest: RestClient): void {
  openSessions.set(sessionId, rest);
  installSignalCleanup();
}

function installSignalCleanup(): void {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void cleanUpOnSignal(signal));
  }
}

/**
 * Deletes the open sessions, then stops the Sauce Connect tunnels they used, then lets the signal end the
 * process unless another handler takes care of it.
 */
export async function cleanUpOnSignal(signal: NodeJS.Signals): Promise<void> {
  const sessions = [...openSessions];
  openSessions.clear();
  if (sessions.length > 0) debug('%s: deleting %d open Sauce Labs session(s)', signal, sessions.length);
  const cleanup = async () => {
    await Promise.allSettled(sessions.map(([id, rest]) => rest.deleteSession(id)));
    await stopSauceConnectTunnels();
  };
  await Promise.race([
    cleanup(),
    new Promise((resolve) => setTimeout(resolve, SIGNAL_CLEANUP_TIMEOUT_MS).unref()),
  ]);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

// ─── Driver ───────────────────────────────────────────────────────────────────

/** Mobilewright driver for Sauce Labs real devices, through the Real Device Access API. */
export class SauceLabsDriver implements MobilewrightDriver {
  private session: ActiveSession | null = null;
  /** The options without the credentials, which are kept in private fields so they never show up when printed. */
  private readonly options: Omit<SauceLabsDriverOptions, 'username' | 'accessKey'>;
  readonly #username: string;
  readonly #accessKey: string;
  /** Storage refs of local paths uploaded (or found in Sauce Storage) by this instance. */
  private readonly storageRefs = new Map<string, string>();
  /** The bundle id of each storage ref or URL clearAppData() looked up on iOS. */
  private readonly appBundleIds = new Map<string, string | undefined>();
  /** Sauce Labs sessions this instance allocated for the device pool and has not released yet. */
  private readonly poolSessions = new Set<string>();
  /** The Sauce Connect tunnel `sauceConnect` started, once requested. */
  private tunnel: Promise<SauceConnect> | undefined;

  constructor(options: SauceLabsDriverOptions = {}) {
    const { username, accessKey, ...rest } = options;
    this.options = rest;
    const credentials = resolveCredentials(username, accessKey);
    this.#username = credentials.username;
    this.#accessKey = credentials.accessKey;
  }

  // ─── Sauce Connect ──────────────────────────────────────────────────────────

  /** Called once by Mobilewright's device pool before any test: starts the Sauce Connect tunnel, if enabled. */
  async prepare(): Promise<void> {
    if (this.options.sauceConnect) await this.startTunnel();
  }

  /** Called once by Mobilewright's device pool after the run: stops the Sauce Connect tunnel. */
  async dispose(): Promise<void> {
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    await tunnel?.then((t) => t.stop(), () => {});
  }

  /** Starts the tunnel once; a failed start is retried by the next call. */
  private startTunnel(): Promise<SauceConnect> {
    installSignalCleanup();
    this.tunnel ??= SauceConnect.start({
      username: this.#username,
      accessKey: this.#accessKey,
      region: this.options.region ?? DEFAULT_REGION,
      options: this.options.sauceConnectOpts,
    }).catch((err) => {
      this.tunnel = undefined;
      throw err;
    });
    return this.tunnel;
  }

  /** The tunnel new sessions use: the one `sauceConnect` started, or `tunnelName`. */
  private async sessionTunnel(): Promise<{ name: string; owner?: string } | undefined> {
    if (this.options.sauceConnect) {
      const tunnel = await this.startTunnel();
      if (!tunnel.running) throw new Error(tunnel.describeExit());
      return { name: tunnel.tunnelName };
    }
    if (!this.options.tunnelName) return undefined;
    return { name: this.options.tunnelName, ...(this.options.tunnelOwner ? { owner: this.options.tunnelOwner } : {}) };
  }

  // ─── Device pool (DeviceAllocator) ──────────────────────────────────────────
  //
  // The pool calls allocate() once per worker slot. The session id is the pool's deviceId, and the worker's
  // driver attaches to it in connect().

  /**
   * Creates a session and returns it once it's ACTIVE, with the criteria's `installApps` installed: here they
   * get the allocation timeout instead of the test fixture's 60s `installTimeout`.
   */
  async allocate(
    criteria: AllocationCriteria,
    _takenDeviceIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<AllocatedDevice> {
    if (!criteria.platform) {
      throw new Error('SauceLabsDriver.allocate requires a platform ("ios" or "android") to allocate a device');
    }
    if (criteria.deviceId) {
      throw new Error(
        `SauceLabsDriver.allocate cannot pin a specific deviceId ("${criteria.deviceId}"): select a device with deviceName instead.`,
      );
    }
    assertRealDeviceType(criteria.deviceType);
    const rest = this.makeRest();
    debug('allocate platform=%s deviceName=%s osVersion=%s', criteria.platform, criteria.deviceNamePattern, criteria.osVersion);
    const deviceQuery = await this.resolveDeviceQuery(rest, criteria.platform, criteria.deviceNamePattern, criteria.osVersion);
    // Uploads happen before a device is reserved, so none sits idle meanwhile.
    const installApps = criteria.installApps ?? [];
    const appRefs: string[] = [];
    for (const app of installApps) appRefs.push(await this.toAppRef(app));
    for (let attempt = 0; ; attempt++) {
      const creation = await this.createSessionWithBackoff(rest, criteria.platform, deviceQuery, signal);
      debug('allocate created id=%s state=%s', creation.id, creation.state);

      try {
        const active = await waitForActiveSession(rest, creation.id, this.options.allocationTimeout ?? 300_000, { signal });
        for (const appRef of appRefs) await this.installAppRef(appRef, creation.id);
        this.poolSessions.add(creation.id);
        trackOpenSession(creation.id, rest);
        return {
          deviceId: creation.id,
          platform: criteria.platform,
          driver: 'saucelabs',
          model: active.device?.deviceName ?? active.device?.descriptor,
          osVersion: active.device?.osVersion,
          type: 'real',
          // Reported as given, so the test fixture doesn't install them again.
          ...(installApps.length > 0 ? { installedApps: [...installApps] } : {}),
        };
      } catch (err) {
        await this.cleanUpFailedSession(rest, creation.id, err);
        if (isRetriableErroredSession(err) && attempt < ERRORED_SESSION_RETRIES) {
          debug('session %s ERRORED while starting, creating a new one', creation.id);
          continue;
        }
        throw err;
      }
    }
  }

  /** Deletes a session that failed to start — except an ERRORED one, which Sauce Labs refuses to delete. */
  private async cleanUpFailedSession(rest: RestClient, sessionId: string, err: unknown): Promise<void> {
    if (isErroredSession(err)) {
      debug('session %s ERRORED; Sauce Labs does not delete those and they hold no device, skipping cleanup', sessionId);
      openSessions.delete(sessionId);
      return;
    }
    await rest.deleteSession(sessionId).catch((deleteErr) =>
      debug('session cleanup error after start failure: %s', (deleteErr as Error).message),
    );
    openSessions.delete(sessionId);
  }

  /** Deletes the Sauce Labs session behind a pool device, releasing the device. */
  async release(deviceId: string): Promise<void> {
    debug('release session %s', deviceId);
    this.poolSessions.delete(deviceId);
    await this.makeRest().deleteSession(deviceId);
    openSessions.delete(deviceId);
  }

  /**
   * Creates a session for allocate(), waiting while no device is available. The pool re-queues the worker on
   * NoDeviceAvailableError but only retries when one of its own slots frees up, so when it holds none (the
   * devices are taken outside this run) the driver retries itself, with backoff, until `signal` aborts.
   */
  private async createSessionWithBackoff(
    rest: RestClient,
    platform: Platform,
    deviceName: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<RestClient['createSession']>>> {
    const deadline = signal ? Infinity : Date.now() + (this.options.allocationTimeout ?? 300_000);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createSession(rest, platform, deviceName);
      } catch (err) {
        if (!(err instanceof NoDeviceAvailableError)) throw err;
        if (this.poolSessions.size > 0) {
          debug('no device available; pool holds %d session(s), handing back to the pool', this.poolSessions.size);
          throw err;
        }
        const delay = backoffDelay(attempt);
        if (Date.now() + delay > deadline) throw err;
        debug('no device available (%s), retry %d in %dms', err.message, attempt, delay);
        await abortableSleep(delay, signal);
      }
    }
  }

  /**
   * Creates a session. A 409 (concurrency limit) or a 400 with `unavailableDevices` (all busy) becomes
   * NoDeviceAvailableError, so the pool waits; a query that matches no device stays an error.
   */
  private async createSession(
    rest: RestClient,
    platform: Platform,
    deviceName?: string,
  ): Promise<Awaited<ReturnType<RestClient['createSession']>>> {
    const tunnel = await this.sessionTunnel();
    try {
      return await rest.createSession(this.sessionRequest(platform, deviceName, tunnel));
    } catch (err) {
      throw classifyCreateSessionError(err, platform, deviceName);
    }
  }

  /** The `deviceName` pattern to request. With `osVersion`, the exact ids of the matching devices (the API has no version filter). */
  private async resolveDeviceQuery(
    rest: RestClient,
    platform: Platform,
    deviceName: string | undefined,
    osVersion: string | undefined,
  ): Promise<string | undefined> {
    if (!osVersion) return deviceName;
    const os = platform === 'android' ? 'ANDROID' : 'IOS';
    const nameMatch = deviceName ? new RegExp(deviceName) : undefined;
    const devices = (await rest.listDevices()).filter((d) => d.os === os);
    const matches = devices.filter((d) =>
      !!d.osVersion && osVersionSatisfies(d.osVersion, osVersion) && (!nameMatch || nameMatch.test(d.id) || nameMatch.test(d.name)));
    debug('osVersion %s matches %d of %d %s devices', osVersion, matches.length, devices.length, platform);
    if (matches.length === 0) {
      const versions = [...new Set(devices.map((d) => d.osVersion).filter(Boolean))]
        .sort((a, b) => a!.localeCompare(b!, undefined, { numeric: true }));
      throw new Error(
        `No Sauce Labs ${platform} device matches osVersion "${osVersion}"${deviceName ? ` and deviceName /${deviceName}/` : ''}. ` +
        `Versions available to this account: ${versions.join(', ')}`,
      );
    }
    return `^(?:${matches.map((d) => escapeRegex(d.id)).join('|')})$`;
  }

  /** The `POST /sessions` body. */
  private sessionRequest(
    platform: Platform,
    deviceName: string | undefined,
    tunnel: { name: string; owner?: string } | undefined,
  ): Parameters<RestClient['createSession']>[0] {
    const configuration = {
      ...(this.options.sessionDuration ? { sessionDuration: this.options.sessionDuration } : {}),
      ...(tunnel ? { tunnel } : {}),
    };
    return {
      device: {
        os: platform === 'android' ? 'ANDROID' : 'IOS',
        ...(deviceName ? { deviceName: toSauceDeviceNameQuery(deviceName) } : {}),
      },
      ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    };
  }

  // ─── Session (MobilewrightSession) ──────────────────────────────────────────

  /**
   * Attaches to the pool session `config.deviceId`, or creates (and owns) a session without one, replacing it
   * once if it ends ERRORED while it starts.
   */
  async connect(config: ConnectionConfig): Promise<Session> {
    if (this.session) throw new Error('Already connected to a Sauce Labs session: call disconnect() first.');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connectOnce(config);
      } catch (err) {
        // Only a session this call created can be replaced; a pool session is the pool's.
        if (!config.deviceId && isRetriableErroredSession(err) && attempt < ERRORED_SESSION_RETRIES) {
          debug('session ERRORED while starting, creating a new one');
          continue;
        }
        throw err;
      }
    }
  }

  /** One connect attempt; see connect(). */
  private async connectOnce(config: ConnectionConfig): Promise<Session> {
    const rest = this.makeRest();
    const platform = config.platform;

    let sauceSessionId: string;
    const ownsSession = !config.deviceId;
    if (config.deviceId) {
      debug('attaching to existing session %s', config.deviceId);
      sauceSessionId = config.deviceId;
    } else {
      debug('creating session platform=%s', platform);
      assertRealDeviceType(config.deviceType);
      const deviceName = typeof config.deviceName === 'string' ? config.deviceName : config.deviceName?.source;
      const deviceQuery = await this.resolveDeviceQuery(rest, platform, deviceName, config.osVersion);
      const creation = await this.createSession(rest, platform, deviceQuery);
      debug('session created id=%s state=%s', creation.id, creation.state);
      sauceSessionId = creation.id;
      trackOpenSession(sauceSessionId, rest);
    }

    // A failure before this.session is set must release what was created here: disconnect() won't see it.
    let ioSocket: DeviceControlSocket | undefined;
    let companionSocket: CompanionSocket | undefined;
    try {
      // A pool session is already ACTIVE, so its first poll needn't wait.
      const sauceSession = await waitForActiveSession(
        rest,
        sauceSessionId,
        this.options.allocationTimeout ?? 300_000,
        { skipInitialDelay: !ownsSession },
      );
      debug('session ACTIVE, descriptor=%s expiresAt=%s', sauceSession.device?.descriptor, sauceSession.expiresAt);

      const descriptor = sauceSession.device?.descriptor ?? sauceSessionId;
      const links = sauceSession.links!;

      if (SHOW_LIVE_VIEW && links.liveViewUrl) {
        console.log(`📱 Sauce Labs live view (${descriptor}): 🔗 ${links.liveViewUrl}`);
      }

      // Screen metrics from the device catalog
      let resolutionWidth = 1080;
      let resolutionHeight = 1920;
      let pixelsPerPoint = 1;
      let defaultOrientation: 'PORTRAIT' | 'LANDSCAPE' = 'PORTRAIT';

      try {
        const descriptors = await rest.listDevices();
        const desc = descriptors.find((d) => d.id === descriptor);
        if (desc) {
          resolutionWidth = desc.resolutionWidth ?? resolutionWidth;
          resolutionHeight = desc.resolutionHeight ?? resolutionHeight;
          pixelsPerPoint = desc.pixelsPerPoint ?? pixelsPerPoint;
          defaultOrientation = parseOrientation(desc.defaultOrientation);
        }
      } catch (err) {
        debug('failed to fetch device descriptor: %s', (err as Error).message);
      }

      if (platform === 'android') {
        // Many devices run below the resolution the catalog lists, and element bounds use the real one.
        const actual = await rest.executeShellCommand(sauceSessionId, 'dumpsys window displays')
          .then(parseAndroidDisplaySize)
          .catch((err) => { debug('could not read the display size: %s', (err as Error).message); return undefined; });
        if (actual && (actual.width !== resolutionWidth || actual.height !== resolutionHeight)) {
          debug('display runs at %dx%d (catalog lists %dx%d)', actual.width, actual.height, resolutionWidth, resolutionHeight);
          ({ width: resolutionWidth, height: resolutionHeight } = actual);
        }
      }

      const io = new DeviceControlSocket(links.ioWebsocketUrl, this.#username, this.#accessKey);
      const companion = new CompanionSocket(links.eventsWebsocketUrl, this.#username, this.#accessKey);
      ioSocket = io;
      companionSocket = companion;
      await Promise.all([connectRetryingGatewayErrors(() => io.connect()), connectRetryingGatewayErrors(() => companion.connect())]);

      this.session = {
        sauceSessionId,
        ownsSession,
        platform,
        deviceId: descriptor,
        resolutionWidth,
        resolutionHeight,
        pixelsPerPoint,
        currentOrientation: defaultOrientation,
        ioSocket,
        companionSocket,
        wdaClient: platform === 'ios' ? this.createWdaClient(rest, sauceSessionId) : null,
        textInput: { cleared: false, typed: '' },
        launcherActivities: new Map(),
      };

      await this.startReportedTest();

      return { deviceId: sauceSessionId, platform };
    } catch (err) {
      this.session = null;
      await ioSocket?.disconnect().catch(() => {});
      await companionSocket?.disconnect().catch(() => {});
      if (ownsSession) await this.cleanUpFailedSession(rest, sauceSessionId, err);
      throw err;
    }
  }

  /** Ends the reported test and closes everything; deletes the session only if connect() created it. */
  async disconnect(): Promise<void> {
    const session = this.requireSession();
    const rest = this.makeRest();
    await this.endReportedTest(session);
    await session.webViews?.close();

    if (session.wdaClient) {
      await session.wdaClient.close().catch((err) => debug('wda close error: %s', err.message));
    }

    await Promise.all([
      session.ioSocket.disconnect(),
      session.companionSocket.disconnect(),
    ]);

    if (session.ownsSession) {
      await rest.deleteSession(session.sauceSessionId);
      openSessions.delete(session.sauceSessionId);
    }
    this.session = null;
    debug('disconnected (ownsSession=%s)', session.ownsSession);
  }

  // ─── WebViews ────────────────────────────────────────────────────────────────

  /** Webviews (and Chrome / Safari pages) through hosted Appium, started on first use. */
  get webViewBridge(): WebViewBridge {
    return {
      listWebViews: () => this.webViews().listWebViews(),
      attachWebView: (id: string) => this.webViews().attachWebView(id),
    };
  }

  private webViews(): HostedAppiumWebViews {
    const session = this.requireSession();
    session.webViews ??= new HostedAppiumWebViews(this.makeRest(), session.sauceSessionId, session.platform, this.options.appiumVersion);
    return session.webViews;
  }

  // ─── Test reports ────────────────────────────────────────────────────────────

  /** Starts a Sauce Labs test named after the running Playwright test. Errors are only logged. */
  private async startReportedTest(): Promise<void> {
    if (this.options.reportTests === false) return;
    const current = (this.options._currentTest ?? currentPlaywrightTest)();
    if (!current) return;
    const session = this.requireSession();
    const name = current.titlePath.join(' › ') + (current.retry > 0 ? ` (retry ${current.retry})` : '');
    const request = {
      testName: name,
      ...(this.options.build ? { build: this.options.build } : {}),
      ...(this.options.tags?.length ? { tags: this.options.tags } : {}),
      artifacts: { ...DEFAULT_ARTIFACTS, ...this.options.artifacts },
    };
    const rest = this.makeRest();
    try {
      let started;
      try {
        started = await rest.startTest(session.sauceSessionId, request);
      } catch (err) {
        // 409: a test is still open (a worker crashed mid-test): end it and retry once.
        if (!(err instanceof SauceApiError && err.status === 409)) throw err;
        debug('a test is still active on session %s; ending it before starting "%s"', session.sauceSessionId, name);
        await rest.endTest(session.sauceSessionId);
        started = await rest.startTest(session.sauceSessionId, request);
      }
      session.reportedTest = { name, jobId: started.jobId };
      debug('reporting "%s" to Sauce Labs as job %s', name, started.jobId);
      // A link to the job in Playwright's report.
      if (started.jobId) current.annotations?.push({ type: 'Sauce Labs', description: sauceJobUrl(this.options.region ?? DEFAULT_REGION, started.jobId) });
    } catch (err) {
      debug('could not start a Sauce Labs test for "%s": %s', name, (err as Error).message);
    }
  }

  /** Ends the reported test with the Playwright test's outcome (no result for skipped tests). */
  private async endReportedTest(session: ActiveSession): Promise<void> {
    const reported = session.reportedTest;
    if (!reported) return;
    session.reportedTest = undefined;
    const current = (this.options._currentTest ?? currentPlaywrightTest)();
    const status = !current?.status || current.status === 'skipped'
      ? undefined
      : current.status === current.expectedStatus ? 'passed' : 'failed';
    try {
      await this.makeRest().endTest(session.sauceSessionId, status);
      debug('reported "%s" as %s (job %s)', reported.name, status ?? 'no result', reported.jobId);
    } catch (err) {
      debug('could not end the Sauce Labs test "%s": %s', reported.name, (err as Error).message);
    }
  }

  // ─── Device settings ─────────────────────────────────────────────────────────

  /** Applies device settings; `animations` only applies to Android. */
  async applyDeviceSettings(settings: DeviceSettings): Promise<void> {
    const { sauceSessionId, platform } = this.requireSession();
    const rest = this.makeRest();
    if (settings.animations !== undefined && platform === 'android') {
      await rest.applySettings(sauceSessionId, {
        animations: settings.animations === 'on',
      });
    }
  }

  // ─── UI hierarchy ─────────────────────────────────────────────────────────────

  /** The view hierarchy: `uiautomator dump` on Android, WDA's page source on iOS. */
  async getViewHierarchy(): Promise<ViewNode[]> {
    const session = this.requireSession();
    if (session.platform === 'android') {
      // While hosted Appium runs it can hold UI automation, so an empty dump isn't retried.
      const stdout = await this.dumpAndroidHierarchy(session.sauceSessionId, session.webViews?.active ? 1 : UIAUTOMATOR_DUMP_ATTEMPTS);
      let nodes = parseUiautomatorXml(stdout);
      if (nodes.length === 0 && session.webViews?.active) {
        debug('uiautomator dump returned nothing while hosted Appium runs; using Appium\'s page source');
        nodes = parseUiautomatorXml(await session.webViews.nativeSource());
      }
      return androidFieldValues(nodes, session.textInput);
    } else {
      const wda = this.requireWda(session);
      return iosFieldValues(await wda.getSource(), session.textInput);
    }
  }

  /** `uiautomator dump`, retried when it prints no hierarchy (it fails while the screen animates). */
  private async dumpAndroidHierarchy(sauceSessionId: string, attempts: number): Promise<string> {
    const rest = this.makeRest();
    for (let attempt = 1; ; attempt++) {
      const stdout = await rest.executeShellCommand(sauceSessionId, 'uiautomator dump /dev/tty');
      if (stdout.includes('<hierarchy')) return stdout;
      debug('uiautomator dump printed no hierarchy (attempt %d of %d): %s', attempt, attempts, stdout.trim().slice(0, 200));
      if (attempt >= attempts) return stdout;
      await sleep(UIAUTOMATOR_DUMP_RETRY_MS);
    }
  }

  // ─── Input ───────────────────────────────────────────────────────────────────

  /** The touch canvas: pixels on Android, points on iOS (where element bounds are in points). */
  private touchFrame(session: ActiveSession): { cw: number; ch: number; orientation: 0 | 1 } {
    const scale = session.platform === 'ios' ? (session.pixelsPerPoint || 1) : 1;
    const w = session.resolutionWidth / scale;
    const h = session.resolutionHeight / scale;
    const orientation: 0 | 1 = session.currentOrientation === 'LANDSCAPE' ? 1 : 0;
    return orientation === 1 ? { cw: h, ch: w, orientation } : { cw: w, ch: h, orientation };
  }

  /** Taps at the given coordinates, holding the touch TAP_HOLD_MS. */
  async tap(x: number, y: number): Promise<void> {
    const session = this.requireSession();
    session.textInput = { cleared: false, typed: '' };
    const { cw, ch, orientation } = this.touchFrame(session);
    session.ioSocket.sendTouch('d', [{ x, y, index: 0 }], cw, ch, orientation);
    await sleep(TAP_HOLD_MS);
    session.ioSocket.sendTouch('u', [{ x, y, index: 0 }], cw, ch, orientation);
  }

  /** Two taps, 100ms apart. */
  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await sleep(100);
    await this.tap(x, y);
  }

  /** Holds a touch for `duration` ms. */
  async longPress(x: number, y: number, duration = 500): Promise<void> {
    const session = this.requireSession();
    session.textInput = { cleared: false, typed: '' };
    const { cw, ch, orientation } = this.touchFrame(session);
    session.ioSocket.sendTouch('d', [{ x, y, index: 0 }], cw, ch, orientation);
    await sleep(duration);
    session.ioSocket.sendTouch('u', [{ x, y, index: 0 }], cw, ch, orientation);
  }

  /** Types into the focused field: WDA on iOS; on Android socket keys for ASCII, `input text` otherwise. */
  async typeText(text: string): Promise<void> {
    const session = this.requireSession();
    const { typed } = session.textInput;
    session.textInput = { cleared: false, typed: typed === null ? null : typed + text };
    if (session.platform === 'ios') {
      // Socket keys can drop characters on iOS.
      await this.requireWda(session).typeKeys(text);
      return;
    }
    const ascii = /^[\x00-\x7F]*$/.test(text);
    if (ascii) {
      for (const char of text) {
        session.ioSocket.sendKey(char);
      }
    } else {
      const rest = this.makeRest();
      const shellText = text.replace(/'/g, '\'\\\'\'');
      await rest.executeShellCommand(session.sauceSessionId, `input text '${shellText}'`, `input text ${redact(text)}`);
    }
  }

  /** Sends each key through the device-control socket. */
  async pressKeys(keys: string[]): Promise<void> {
    const session = this.requireSession();
    const { ioSocket } = session;
    session.textInput = { cleared: false, typed: null };
    for (const key of keys) {
      ioSocket.sendKey(key);
    }
  }

  /** Clears the focused text field: WDA's element clear on iOS; Ctrl+A then DEL on Android (13+). */
  async clearText(): Promise<void> {
    const session = this.requireSession();
    session.textInput = { cleared: true, typed: '' };
    if (session.platform === 'ios') {
      const clearedBounds = await this.requireWda(session).clearActiveElement();
      session.textInput = { cleared: true, typed: '', clearedBounds };
      return;
    }
    const rest = this.makeRest();
    // Before Android 13 `input keycombination` doesn't exist and would silently clear nothing.
    session.androidSdk ??= Number((await rest.executeShellCommand(session.sauceSessionId, 'getprop ro.build.version.sdk')).trim()) || undefined;
    if (session.androidSdk !== undefined && session.androidSdk < ANDROID_13_SDK) {
      throw new Error(
        `clearText() needs Android 13 or later (it uses \`input keycombination\`); this device runs API level ${session.androidSdk}. ` +
        'Select newer devices, e.g. with osVersion: \'>=13\' in your project\'s use options.',
      );
    }
    // Moving the cursor first makes the keyboard finish the word being typed: while a word is open (its suggestions
    // showing), Gboard ignores select-all (Pixel 8, Android 17).
    await rest.executeShellCommand(session.sauceSessionId, `input keyevent ${KEYCODE_MOVE_END}`);
    await rest.executeShellCommand(session.sauceSessionId, `input keycombination ${KEYCODE_CTRL_LEFT} ${KEYCODE_A}`);
    await rest.executeShellCommand(session.sauceSessionId, `input keyevent ${KEYCODE_DEL}`);
  }

  /** Swipes in a direction, as touch moves spread over `duration`. */
  async swipe(direction: SwipeDirection, opts?: SwipeOptions): Promise<void> {
    const session = this.requireSession();
    session.textInput = { cleared: false, typed: '' };
    const { ioSocket } = session;
    const { cw, ch, orientation } = this.touchFrame(session);

    const centerX = cw / 2;
    const centerY = ch / 2;
    const startX = opts?.startX ?? centerX;
    const startY = opts?.startY ?? centerY;

    const isHorizontal = direction === 'left' || direction === 'right';
    const defaultDistance = (isHorizontal ? cw : ch) * 0.5;
    const distance = opts?.distance ?? defaultDistance;

    let endX = startX;
    let endY = startY;
    switch (direction) {
      case 'up':    endY = startY - distance; break;
      case 'down':  endY = startY + distance; break;
      case 'left':  endX = startX - distance; break;
      case 'right': endX = startX + distance; break;
    }

    const steps = 10;
    const duration = opts?.duration ?? 300;
    const stepDelay = Math.round(duration / steps);

    ioSocket.sendTouch('d', [{ x: startX, y: startY, index: 0 }], cw, ch, orientation);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mx = startX + (endX - startX) * t;
      const my = startY + (endY - startY) * t;
      await sleep(stepDelay);
      ioSocket.sendTouch('m', [{ x: mx, y: my, index: 0 }], cw, ch, orientation);
    }
    ioSocket.sendTouch('u', [{ x: endX, y: endY, index: 0 }], cw, ch, orientation);
  }

  /** Replays a multi-pointer gesture at its timestamps. */
  async gesture(gestures: GestureSequence): Promise<void> {
    const session = this.requireSession();
    session.textInput = { cleared: false, typed: '' };
    const { ioSocket } = session;
    const { cw, ch, orientation } = this.touchFrame(session);
    const pointers = gestures.pointers;

    const timestamps = Array.from(
      new Set(pointers.flatMap((pts) => pts.map((p) => p.time ?? 0))),
    ).sort((a, b) => a - b);

    let prevTime = 0;
    for (const time of timestamps) {
      if (time > prevTime) {
        await sleep(time - prevTime);
      }
      prevTime = time;

      const points = pointers
        .map((ptr, index) => {
          const pt = ptr.find((p) => (p.time ?? 0) === time);
          return pt ? { x: pt.x, y: pt.y, index } : null;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (points.length > 0) {
        const isFirst = time === timestamps[0];
        const isLast = time === timestamps[timestamps.length - 1];
        const action = isFirst ? 'd' : isLast ? 'u' : 'm';
        ioSocket.sendTouch(action, points, cw, ch, orientation);
      }
    }
  }

  /** Presses a hardware button: `input keyevent` on Android, WDA on iOS, the socket otherwise. */
  async pressButton(button: HardwareButton): Promise<void> {
    const session = this.requireSession();

    if (session.platform === 'android') {
      const keyEvent = BUTTON_KEYEVENT[button];
      if (keyEvent !== undefined) {
        await this.makeRest().executeShellCommand(session.sauceSessionId, `input keyevent ${keyEvent}`);
        return;
      }
    } else {
      const wdaName = BUTTON_WDA[button];
      if (wdaName) {
        await this.requireWda(session).pressButton(wdaName);
        return;
      }
    }

    const socketKey = BUTTON_KEY[button];
    if (socketKey) {
      session.ioSocket.sendKey(socketKey);
      return;
    }
    throw new Error(`Unsupported hardware button on ${session.platform === 'android' ? 'Android' : 'iOS'}: ${button}`);
  }

  // ─── Screen ──────────────────────────────────────────────────────────────────

  /** The screen as PNG. */
  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    const { sauceSessionId } = this.requireSession();
    const rest = this.makeRest();
    return rest.takeScreenshot(sauceSessionId);
  }

  /** The screen size in points, rotated in landscape. */
  async getScreenSize(): Promise<ScreenSize> {
    const { resolutionWidth, resolutionHeight, pixelsPerPoint, currentOrientation } = this.requireSession();
    const scale = pixelsPerPoint || 1;
    if (currentOrientation === 'LANDSCAPE') {
      return { width: resolutionHeight / scale, height: resolutionWidth / scale, scale };
    }
    return { width: resolutionWidth / scale, height: resolutionHeight / scale, scale };
  }

  /** The orientation the device shows. */
  async getOrientation(): Promise<Orientation> {
    const session = this.requireSession();
    const actual = await this.readDeviceOrientation(session);
    if (actual) session.currentOrientation = actual;
    return sauceOrientationToProtocol(session.currentOrientation);
  }

  /** The orientation the device shows (`dumpsys window displays` on Android, WDA on iOS), or undefined. */
  private async readDeviceOrientation(session: ActiveSession): Promise<'PORTRAIT' | 'LANDSCAPE' | undefined> {
    try {
      if (session.platform === 'ios') return await this.requireWda(session).getOrientation();
      const stdout = await this.makeRest().executeShellCommand(session.sauceSessionId, 'dumpsys window displays');
      return parseAndroidRotation(stdout);
    } catch (err) {
      debug('could not read the device orientation: %s', (err as Error).message);
      return undefined;
    }
  }

  /** Not supported by the Real Device Access API. */
  async setGeolocation(_geolocation: Geolocation | null): Promise<void> {
    throw new Error('setGeolocation is not supported by the Sauce Labs driver');
  }

  /** Not supported by the Real Device Access API. */
  async setFoldState(_state: FoldState): Promise<void> {
    throw new Error('setFoldState is not supported by the Sauce Labs driver');
  }

  /** Rotates the device and waits until it shows the orientation (an app locked to one keeps it). */
  async setOrientation(orientation: Orientation): Promise<void> {
    const { sauceSessionId } = this.requireSession();
    const rest = this.makeRest();
    const requested = protocolOrientationToSauce(orientation);
    await rest.applySettings(sauceSessionId, { orientation: requested });

    // Touch coordinates must follow what the device actually shows.
    const session = this.requireSession();
    const deadline = Date.now() + ORIENTATION_SETTLE_TIMEOUT_MS;
    let actual = await this.readDeviceOrientation(session);
    while (actual && actual !== requested && Date.now() < deadline) {
      await sleep(1_000);
      actual = await this.readDeviceOrientation(session);
    }
    if (actual && actual !== requested) {
      debug('setOrientation %s: the device stayed %s (the foreground app may not rotate)', requested, actual);
    }
    session.currentOrientation = actual ?? requested;
  }

  // ─── Apps ────────────────────────────────────────────────────────────────────

  /** Launches an installed app; on Android with its launcher activity unless `opts.activity` is given. */
  async launchApp(bundleId: string, opts?: LaunchOptions): Promise<void> {
    const { sauceSessionId, platform } = this.requireSession();
    const rest = this.makeRest();
    if (platform === 'android') {
      // The API requires an activity on Android.
      const activityName = opts?.activity ?? await this.launcherActivity(bundleId);
      await rest.launchApp(sauceSessionId, { packageName: bundleId, activityName });
    } else {
      await rest.launchApp(sauceSessionId, { bundleId });
    }
  }

  /** An installed package's launcher activity, cached per session; `dumpsys package` is the fallback. */
  private async launcherActivity(packageName: string): Promise<string> {
    const session = this.requireSession();
    const cached = session.launcherActivities.get(packageName);
    if (cached) return cached;
    const rest = this.makeRest();
    const run = (command: string) => rest.executeShellCommand(session.sauceSessionId, command).catch((err) => {
      debug('%s failed: %s', command, (err as Error).message);
      return '';
    });
    const activity =
      parseResolvedActivity(await run(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${androidPackage(packageName)}`), packageName) ??
      parseDumpsysLauncherActivity(await run(`dumpsys package ${androidPackage(packageName)}`), packageName);
    if (!activity) {
      throw new Error(`launchApp: no launcher activity found for "${packageName}" (is it installed?). Pass { activity } to launch a specific one.`);
    }
    debug('launcher activity of %s: %s', packageName, activity);
    session.launcherActivities.set(packageName, activity);
    return activity;
  }

  /**
   * Stops an app. On iOS an alert still on screen is dismissed first: with its permission prompt open, an app
   * terminated or reinstalled doesn't come back to the foreground when launched.
   */
  async terminateApp(bundleId: string): Promise<void> {
    const session = this.requireSession();
    const rest = this.makeRest();
    if (session.platform === 'android') {
      await rest.executeShellCommand(session.sauceSessionId, `am force-stop ${androidPackage(bundleId)}`);
    } else {
      const wda = this.requireWda(session);
      if (await wda.dismissAlert()) debug('terminateApp: dismissed an open alert first');
      await wda.terminateApp(bundleId);
    }
  }

  /** Installs an app from a `storage:` ref, an `http(s)://` URL or a local path, and waits until it's installed. */
  async installApp(app: string): Promise<void> {
    await this.installAppRef(await this.toAppRef(app));
  }

  /** `storage:` refs and URLs as given (Sauce Labs downloads URLs); local files uploaded or found in Sauce Storage. */
  private async toAppRef(app: string): Promise<string> {
    if (isRemoteApp(app)) return app;
    const cached = this.storageRefs.get(app);
    if (cached) return cached;
    const ref = await this.makeRest().uploadToStorage(app);
    this.storageRefs.set(app, ref);
    return ref;
  }

  /** Installs from a storage ref or URL and waits until the installation finishes. */
  private async installAppRef(appRef: string, sauceSessionId = this.requireSession().sauceSessionId): Promise<void> {
    const rest = this.makeRest();
    const result = await rest.installApp(sauceSessionId, appRef);
    const installationId = result.installationId;
    if (!installationId) return;

    const deadline = Date.now() + 120_000;
    const pollInterval = 3_000;
    while (Date.now() < deadline) {
      await sleep(pollInterval);
      const { appInstallations } = await rest.listAppInstallations(sauceSessionId);
      const entry = appInstallations.find((a) => a.installationId === installationId);
      if (!entry) continue;
      debug('install %s status=%s', installationId, entry.status);
      if (entry.status === 'FINISHED') return;
      if (entry.status === 'ERROR') throw new Error(`App installation failed for ${appRef}: ${JSON.stringify(entry)}`);
    }
    throw new Error(`Timed out waiting for app installation to complete: ${appRef}`);
  }

  /** Uninstalls an app. */
  async uninstallApp(bundleId: string): Promise<void> {
    const { sauceSessionId, platform } = this.requireSession();
    const rest = this.makeRest();
    if (platform === 'android') {
      await rest.uninstallApp(sauceSessionId, { packageName: bundleId });
    } else {
      await rest.uninstallApp(sauceSessionId, { bundleId });
    }
  }

  /**
   * Clears an app's data and permissions, leaving it installed and stopped: `pm clear` on Android. A real iOS
   * device can't clear app data, so the app is reinstalled from where this session installed it (keychain
   * items stay).
   */
  async clearAppData(bundleId: string): Promise<void> {
    const { sauceSessionId, platform } = this.requireSession();
    const rest = this.makeRest();
    if (platform === 'android') {
      const output = await rest.executeShellCommand(sauceSessionId, `pm clear ${androidPackage(bundleId)}`);
      if (!/^Success/m.test(output)) throw new Error(`Clearing the data of ${bundleId} failed: ${output.trim() || 'no output from pm clear'}`);
      return;
    }

    const appRef = await this.installedAppRef(bundleId);
    if (!appRef) {
      throw new Error(
        `clearAppData('${bundleId}') on iOS reinstalls the app, but this session didn't install it. ` +
        'Install it with installApps first.',
      );
    }
    debug('clearAppData: reinstalling %s from %s', bundleId, appRef);
    // A permission prompt left open would keep the reinstalled app from coming to the foreground.
    if (await this.requireWda(this.requireSession()).dismissAlert()) debug('clearAppData: dismissed an open alert');
    await rest.uninstallApp(sauceSessionId, { bundleId });
    await this.installAppRef(appRef);
  }

  /**
   * Where this session last installed the app from. A stored file's bundle id comes from Sauce Storage, a URL's
   * from the IPA itself (downloaded once).
   */
  private async installedAppRef(bundleId: string): Promise<string | undefined> {
    const { sauceSessionId } = this.requireSession();
    const rest = this.makeRest();
    const { appInstallations } = await rest.listAppInstallations(sauceSessionId);
    // Sauce Labs lists the newest installation first.
    const refs = [...new Set(appInstallations.filter((a) => a.status === 'FINISHED' && a.app).map((a) => a.app!))];
    for (const ref of refs) {
      if (!this.appBundleIds.has(ref)) {
        const lookup = ref.startsWith('storage:') ? rest.storageAppIdentifier(ref) : isRemoteApp(ref) ? rest.ipaBundleId(ref) : undefined;
        this.appBundleIds.set(ref, await Promise.resolve(lookup).catch((err) => {
          debug('could not read the bundle id of %s: %s', ref, (err as Error).message);
          return undefined;
        }));
      }
      if (this.appBundleIds.get(ref) === bundleId) return ref;
    }
    return undefined;
  }

  /** Installed apps on Android (without Sauce Labs' own), running apps on iOS. */
  async listApps(): Promise<AppInfo[]> {
    const session = this.requireSession();
    const rest = this.makeRest();
    if (session.platform === 'android') {
      const stdout = await rest.executeShellCommand(session.sauceSessionId, 'pm list packages -3');
      return parsePmListPackages(stdout).filter((app) => !isSauceInfrastructurePackage(app.bundleId));
    } else {
      const wda = this.requireWda(session);
      return wda.listApps();
    }
  }

  /** The app in the foreground. */
  async getForegroundApp(): Promise<AppInfo> {
    const session = this.requireSession();
    const rest = this.makeRest();
    if (session.platform === 'android') {
      const stdout = await rest.executeShellCommand(session.sauceSessionId, 'dumpsys window');
      debug('getForegroundApp window stdout length=%d', stdout.length);
      const app = parseForegroundApp(stdout);
      debug('getForegroundApp bundleId=%s', app.bundleId);
      return app;
    } else {
      const wda = this.requireWda(session);
      return wda.getActiveAppInfo();
    }
  }

  // ─── Device ──────────────────────────────────────────────────────────────────

  /** The account's devices with their availability. */
  async listDevices(opts?: ListDevicesOptions): Promise<DeviceInfo[]> {
    const rest = this.makeRest();
    const [descriptors, statusResp] = await Promise.all([
      rest.listDevices(),
      rest.listDeviceStatus(),
    ]);

    const statusMap = new Map<string, string>();
    for (const s of statusResp.devices) {
      statusMap.set(s.descriptor, s.state);
    }

    let devices: DeviceInfo[] = descriptors
      .filter((d) => {
        if (opts?.platform) {
          const os = d.os.toLowerCase() as Platform;
          if (os !== opts.platform) return false;
        }
        return true;
      })
      .map((d) => {
        const rawState = statusMap.get(d.id) ?? 'AVAILABLE';
        const state = rawState === 'IN_USE' ? 'offline' as const : 'online' as const;
        return {
          id: d.id,
          name: d.name,
          platform: (d.os.toLowerCase() === 'android' ? 'android' : 'ios') as Platform,
          type: 'real' as const,
          state,
          model: d.name,
          osVersion: d.osVersion,
        };
      });

    if (opts?.state) {
      devices = devices.filter((d) => d.state === opts.state);
    }

    return devices;
  }

  /** Opens a URL in the device's browser. */
  async openUrl(url: string): Promise<void> {
    const { sauceSessionId } = this.requireSession();
    const rest = this.makeRest();
    await rest.openUrl(sauceSessionId, url);
  }

  // ─── Recording ───────────────────────────────────────────────────────────────

  /**
   * Sauce Labs records each test's video, linked from the Playwright report, so the driver records none. Mobilewright
   * runs the test without a local video when this throws.
   */
  async startRecording(_opts: RecordingOptions): Promise<void> {
    throw new Error(RECORDING_NOT_SUPPORTED);
  }

  /** Like startRecording(): the video is on Sauce Labs. */
  async stopRecording(): Promise<RecordingResult> {
    throw new Error(RECORDING_NOT_SUPPORTED);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** The connected session; throws before connect(). */
  private requireSession(): ActiveSession {
    if (!this.session) throw new Error('No active session. Call connect() first.');
    return this.session;
  }

  /** A REST client with the driver's credentials and region. */
  private makeRest(): RestClient {
    return new RestClient(
      this.#username,
      this.#accessKey,
      this.options.region ?? DEFAULT_REGION,
    );
  }

  /** The iOS WebDriverAgent client: the one on the device unless a custom one is configured. */
  private createWdaClient(rest: RestClient, sauceSessionId: string): WdaClient {
    const { iosWdaStorageRef, iosWdaBundleId } = this.options;
    return new WdaClient(rest, sauceSessionId, {
      bundleId: iosWdaBundleId,
      preferDeviceWda: !iosWdaStorageRef && !iosWdaBundleId && !CUSTOM_WDA_URL,
      resolveStorageRef: async () => {
        const wdaSource = iosWdaStorageRef ?? DEFAULT_WDA_URL;
        if (wdaSource.startsWith('storage:')) return wdaSource;
        debug('uploading WDA from URL: %s', wdaSource);
        const ref = await rest.uploadWdaToStorage(wdaSource);
        debug('WDA ready at %s', ref);
        return ref;
      },
    });
  }

  /** The session's WDA client; throws on Android. */
  private requireWda(session: ActiveSession): WdaClient {
    if (!session.wdaClient) throw new Error('WDA client is only available on iOS');
    return session.wdaClient;
  }
}

// ─── uiautomator XML parser ──────────────────────────────────────────────────

const ANDROID_WEBVIEW = 'android.webkit.WebView';

function parseUiautomatorXml(xml: string): ViewNode[] {
  return withoutNestedWebViews(parseXmlTree<ViewNode>(xml, (tag, attrs) => {
    // bounds="[x1,y1][x2,y2]"
    const b = (attrs['bounds'] ?? '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const [x, y, x2, y2] = b ? b.slice(1, 5).map(Number) : [0, 0, 0, 0];
    return {
      type: attrs['class'] ?? tag,
      label: attrs['content-desc'] || undefined,
      identifier: attrs['resource-id'] || undefined,
      resourceId: attrs['resource-id'] || undefined,
      text: attrs['text'] || undefined,
      isVisible: true,
      isEnabled: attrs['enabled'] !== 'false',
      isSelected: attrs['selected'] === 'true',
      isFocused: attrs['focused'] === 'true',
      isChecked: attrs['checked'] === 'true',
      bounds: { x, y, width: x2 - x, height: y2 - y },
      children: [],
      raw: { ...attrs },
    };
  }));
}

/**
 * Appium's page source shows a web view twice: the app's WebView and, right inside it, the page's root, also typed
 * WebView. Mobilewright counts WebView nodes to pick a web view, so the inner one becomes a plain view and its
 * content stays (seen on a Pixel 5, Android 13).
 */
function withoutNestedWebViews(nodes: ViewNode[], insideWebView = false): ViewNode[] {
  for (const node of nodes) {
    const isWebView = node.type === ANDROID_WEBVIEW;
    if (isWebView && insideWebView) node.type = 'android.view.View';
    withoutNestedWebViews(node.children ?? [], insideWebView || isWebView);
  }
  return nodes;
}

