import { createHash } from 'node:crypto';
import createDebug from 'debug';
import { plistString } from './plist.js';
import { USER_AGENT, basicAuth, isSauceLabsUrl, sleep } from './util.js';

const debug = createDebug('mw:mobilewright-driver:rest');

// ─── Public types ─────────────────────────────────────────────────────────────

export type SessionState = 'PENDING' | 'CREATING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'ERRORED';
export type DeviceOs = 'ANDROID' | 'IOS';

export interface SessionLinks {
  ioWebsocketUrl: string;
  eventsWebsocketUrl: string;
  liveViewUrl?: string;
}

export interface SessionDevice {
  descriptor: string;
  deviceName?: string;
  os: DeviceOs;
  osVersion?: string;
}

export interface Session {
  id: string;
  state: SessionState;
  device?: SessionDevice;
  links?: SessionLinks;
  /** When Sauce Labs closes the session. */
  expiresAt?: string;
  /** Why the session is ERRORED. */
  error?: { message?: string };
}

export interface SessionCreation {
  id: string;
  state: SessionState;
}

export interface DeviceDescriptor {
  id: string;
  name: string;
  os: DeviceOs;
  osVersion?: string;
  resolutionWidth?: number;
  resolutionHeight?: number;
  pixelsPerPoint?: number;
  defaultOrientation?: string;
  isPrivate?: boolean;
  isTablet?: boolean;
  modelNumber?: string;
}

export interface DeviceStatus {
  descriptor: string;
  isPrivateDevice: boolean;
  state: string;
  inUseBy?: Array<{ username: string }>;
}

export interface DeviceStatusResponse {
  devices: DeviceStatus[];
}

export interface AppInstallationStatus {
  installationId?: string;
  app?: string;
  status: string;
}

export interface ListAppInstallationsResponse {
  appInstallations: AppInstallationStatus[];
}

/** Artifacts Sauce Labs captures for a test. */
export interface ArtifactToggles {
  video?: boolean;
  deviceLogs?: boolean;
  networkCapture?: boolean;
  screenshots?: boolean;
  appiumLogs?: boolean;
}

export interface StartTestRequest {
  testName?: string;
  build?: string;
  tags?: string[];
  artifacts?: ArtifactToggles;
}

export interface SessionTest {
  jobId: string;
  startTime?: string;
  endTime?: string;
  links?: { self?: string; uiViewUrl?: string };
}

export interface CheckWebDriverAgentStatusResponse {
  state: string;
  devicePort?: number;
  hostPort?: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** A non-2xx response from the Sauce Labs API, with the parsed `application/problem+json` body. */
export class SauceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SauceApiError';
  }

  get title(): string | undefined {
    return typeof this.body?.['title'] === 'string' ? this.body['title'] : undefined;
  }

  get detail(): string | undefined {
    return typeof this.body?.['detail'] === 'string' ? this.body['detail'] : undefined;
  }
}

/** `<METHOD> <path> failed: <status> <title>: <detail>`, falling back to the raw body. */
function apiError(method: string, path: string, status: number, statusText: string, text: string): SauceApiError {
  const body = parseJsonObject(text);
  const title = typeof body?.['title'] === 'string' ? body['title'] : undefined;
  const detail = typeof body?.['detail'] === 'string' ? body['detail'] : undefined;
  const reason = title || detail ? [title, detail].filter(Boolean).join(': ') : (text || statusText);
  return new SauceApiError(`${method} ${path} failed: ${status} ${reason}`, status, body);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Retries and downloads ───────────────────────────────────────────────────

/** Gateway statuses for a request that didn't reach the device, so it's safe to repeat. */
const GATEWAY_RETRY_STATUSES = new Set([502, 503]);
/**
 * The gateway's answer when a request to the device or Appium runs past 60s. The request did get through and
 * may still be running, so only requests that are safe to repeat are retried.
 */
const GATEWAY_TIMEOUT = 504;
export const GATEWAY_RETRY_DELAYS_MS = [1_000, 3_000];
/** Time limit of a request, so one that never answers can't hang the test run. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Time limit of a download (an IPA can be large). */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Methods that are safe to repeat after a network error (a repeated POST could, say, open a second session). */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
/**
 * Errors where no connection was made, so the request was never sent and any method is safe to repeat. Waits are
 * longer than for gateway errors, so a network interruption of up to ~30s doesn't fail the request.
 */
const CONNECT_ERROR_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
export const CONNECT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 20_000];

/** Whether fetch failed before a connection was made (fetch puts the reason in `cause`, sometimes several). */
export function isConnectError(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown; errors?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.code === 'string' && CONNECT_ERROR_CODES.has(e.code)) return true;
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every(isConnectError)) return true;
  }
  return false;
}

/**
 * Wraps fetch to identify the driver in the User-Agent, to time requests out, and to retry gateway errors,
 * connection failures, and other network errors of idempotent requests.
 */
function withRetries(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const method = init?.method ?? 'GET';
    for (let attempt = 0; ; attempt++) {
      const delay = GATEWAY_RETRY_DELAYS_MS[attempt];
      let response: Response;
      try {
        response = await fetchFn(input, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, ...(init?.headers as Record<string, string> | undefined) },
          signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const retryDelay = isConnectError(err) ? CONNECT_RETRY_DELAYS_MS[attempt]
          : IDEMPOTENT_METHODS.has(method) ? delay : undefined;
        if (retryDelay === undefined) throw err;
        debug('%s %s: %s, retrying in %dms', method, String(input), (err as Error).message, retryDelay);
        await sleep(retryDelay);
        continue;
      }
      const retriable = GATEWAY_RETRY_STATUSES.has(response.status)
        || (response.status === GATEWAY_TIMEOUT && IDEMPOTENT_METHODS.has(method));
      if (!retriable || delay === undefined) return response;
      debug('%s %s answered %d, retrying in %dms', method, String(input), response.status, delay);
      await response.body?.cancel().catch(() => {});
      await sleep(delay);
    }
  };
}

/** Largest file the driver downloads into memory (an IPA to read its bundle id, a WDA zip). */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3;

/** Reads a response body, failing once it's larger than `maxBytes`. */
export async function readLimited(response: Response, url: string, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`${url} is larger than the ${maxBytes}-byte download limit`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`${url} is larger than the ${maxBytes}-byte download limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Repackages a WDA zip (the `.app` at its root) into an IPA (`Payload/<App>.app/…`). */
async function repackageToIpa(zipBuffer: Buffer): Promise<Buffer> {
  const { default: AdmZip } = await import('adm-zip');
  const input = new AdmZip(zipBuffer);
  const output = new AdmZip();
  for (const entry of input.getEntries()) {
    output.addFile(`Payload/${entry.entryName}`, entry.getData(), '', entry.attr);
  }
  return output.toBuffer();
}

/** `.../v15.0.0/WebDriverAgentRunner-Runner.zip` → `v15.0.0-WebDriverAgentRunner-Runner.ipa`. */
function ipaFilenameFromUrl(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const base = (parts.at(-1) ?? 'wda.zip').replace(/\.zip$/i, '.ipa');
  const version = parts.at(-2);
  return version ? `${version}-${base}` : base;
}

// ─── Client ──────────────────────────────────────────────────────────────────

/** Sauce Labs data centers: https://docs.saucelabs.com/basics/data-center-endpoints/ */
export type Region = 'us-west-1' | 'us-east-4' | 'eu-central-1' | 'asia-south-2';
export const DEFAULT_REGION: Region = 'us-west-1';

/** A test's page in the Sauce Labs web app. */
export function sauceJobUrl(region: Region, jobId: string): string {
  const host = region === 'us-west-1' ? 'app.saucelabs.com' : `app.${region}.saucelabs.com`;
  return `https://${host}/tests/${jobId}`;
}

/** Bundle id of the WebDriverAgent runner the driver launches when it needs its own. */
export const DEFAULT_WDA_BUNDLE_ID = 'com.facebook.WebDriverAgentRunner.xctrunner';

interface StorageFile {
  id?: string;
  name?: string;
  sha256?: string;
  metadata?: { identifier?: string };
}

/**
 * Client for the Sauce Labs Real Device Access API (v2) and App Storage.
 * https://docs.saucelabs.com/dev/api/real-device-access/ and https://docs.saucelabs.com/dev/api/storage/
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly storageUrl: string;
  private readonly storageFilesUrl: string;
  readonly #authHeader: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    username: string,
    accessKey: string,
    region: Region = DEFAULT_REGION,
    _fetchFn?: typeof globalThis.fetch,
  ) {
    this.baseUrl = `https://api.${region}.saucelabs.com/rdc/v2`;
    this.storageUrl = `https://api.${region}.saucelabs.com/v1/storage/upload`;
    this.storageFilesUrl = `https://api.${region}.saucelabs.com/v1/storage/files`;
    this.#authHeader = basicAuth(username, accessKey);
    this.fetchFn = withRetries(_fetchFn ?? globalThis.fetch);
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async createSession(body: {
    device: { os: DeviceOs; deviceName?: string };
    configuration?: { sessionDuration?: string; tunnel?: { name: string; owner?: string } };
  }): Promise<SessionCreation> {
    debug('createSession %o', body);
    return this.request<SessionCreation>('POST', '/sessions', body);
  }

  async getSession(sessionId: string): Promise<Session> {
    debug('getSession %s', sessionId);
    return this.request<Session>('GET', `/sessions/${sessionId}`);
  }

  /** Closes a session, releasing its device; a session that's already gone (404) is fine. */
  async deleteSession(sessionId: string): Promise<void> {
    debug('deleteSession %s', sessionId);
    await this.request('DELETE', `/sessions/${sessionId}`, undefined, { allow404: true });
  }

  // ─── Devices ──────────────────────────────────────────────────────────────

  /** The devices the account can use. */
  async listDevices(): Promise<DeviceDescriptor[]> {
    debug('listDevices');
    return this.request<DeviceDescriptor[]>('GET', '/devices');
  }

  /** Whether each device is available or in use. */
  async listDeviceStatus(): Promise<DeviceStatusResponse> {
    debug('listDeviceStatus');
    return this.request<DeviceStatusResponse>('GET', '/devices/status');
  }

  // ─── Device interactions ──────────────────────────────────────────────────

  /** The device screen as PNG. */
  async takeScreenshot(sessionId: string): Promise<Buffer> {
    debug('takeScreenshot %s', sessionId);
    const response = await this.send('POST', `/sessions/${sessionId}/device/takeScreenshot`);
    return Buffer.from(await response.arrayBuffer());
  }

  async applySettings(sessionId: string, settings: {
    orientation?: 'PORTRAIT' | 'LANDSCAPE';
    animations?: boolean;
  }): Promise<void> {
    debug('applySettings %s %o', sessionId, settings);
    await this.request('POST', `/sessions/${sessionId}/device/applySettings`, settings, { noContent: true });
  }

  /** Launches an installed app: `bundleId` on iOS, `packageName` and `activityName` on Android. */
  async launchApp(sessionId: string, opts: {
    bundleId?: string;
    packageName?: string;
    activityName?: string;
  }): Promise<void> {
    debug('launchApp %s %o', sessionId, opts);
    await this.request('POST', `/sessions/${sessionId}/device/launchApp`, opts, { noContent: true });
  }

  /** Starts installing an app from Sauce Storage (`storage:…`) or an `http(s)://` URL Sauce Labs downloads. */
  async installApp(
    sessionId: string,
    app: string,
    opts: { launchAfterInstall?: boolean } = {},
  ): Promise<AppInstallationStatus> {
    debug('installApp %s app=%s launch=%s', sessionId, app, opts.launchAfterInstall ?? false);
    return this.request<AppInstallationStatus>('POST', `/sessions/${sessionId}/device/installApp`, {
      app,
      enableInstrumentation: true,
      ...(opts.launchAfterInstall ? { launchAfterInstall: true } : {}),
    });
  }

  /** The session's app installations, newest first. */
  async listAppInstallations(sessionId: string): Promise<ListAppInstallationsResponse> {
    debug('listAppInstallations %s', sessionId);
    return this.request<ListAppInstallationsResponse>('POST', `/sessions/${sessionId}/device/listAppInstallations`, {});
  }

  /** Uninstalls an app: `bundleId` on iOS, `packageName` on Android. */
  async uninstallApp(sessionId: string, opts: {
    bundleId?: string;
    packageName?: string;
  }): Promise<void> {
    debug('uninstallApp %s %o', sessionId, opts);
    await this.request('POST', `/sessions/${sessionId}/device/uninstallApp`, opts, { noContent: true });
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    debug('openUrl %s %s', sessionId, url);
    await this.request('POST', `/sessions/${sessionId}/device/openUrl`, { url }, { noContent: true });
  }

  /** Runs an adb shell command (Android) and returns its output. `logAs` replaces the command in debug logs. */
  async executeShellCommand(sessionId: string, command: string, logAs = command): Promise<string> {
    debug('executeShellCommand %s %s', sessionId, logAs);
    const result = await this.request<{ stdout: string }>(
      'POST',
      `/sessions/${sessionId}/device/executeShellCommand`,
      { adbShellCommand: command },
    );
    return result.stdout;
  }

  // ─── Test reports ─────────────────────────────────────────────────────────

  /**
   * Starts a test on the session, shown on the Sauce Labs Test Results page.
   * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/
   */
  async startTest(sessionId: string, body: StartTestRequest = {}): Promise<{ jobId?: string }> {
    debug('startTest %s %o', sessionId, body);
    return this.request<{ jobId?: string }>('POST', `/sessions/${sessionId}/startTest`, body);
  }

  /** Ends the session's test, with `status` as its result (none when omitted). */
  async endTest(sessionId: string, status?: 'passed' | 'failed'): Promise<{ jobId?: string; status?: string }> {
    debug('endTest %s status=%s', sessionId, status);
    return this.request<{ jobId?: string; status?: string }>('POST', `/sessions/${sessionId}/endTest`, status ? { status } : {});
  }

  async getTests(sessionId: string): Promise<SessionTest[]> {
    const body = await this.request<{ tests?: SessionTest[] } | SessionTest[]>('GET', `/sessions/${sessionId}/tests`);
    return Array.isArray(body) ? body : body.tests ?? [];
  }

  // ─── Hosted Appium ────────────────────────────────────────────────────────

  /**
   * Starts the Appium server Sauce Labs hosts for the session, or returns the running one's URL.
   * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/
   */
  async ensureAppiumServer(sessionId: string, appiumVersion: string): Promise<string> {
    const running = await this.request<{ url?: string }>('GET', `/sessions/${sessionId}/appiumserver`).catch(() => undefined);
    if (running?.url) return running.url;
    debug('starting hosted Appium %s for session %s', appiumVersion, sessionId);
    const started = await this.request<{ url?: string }>('POST', `/sessions/${sessionId}/appiumserver`, { appiumVersion });
    if (!started.url) throw new Error(`Hosted Appium started without a URL: ${JSON.stringify(started)}`);
    return started.url;
  }

  /** A WebDriver call to the hosted Appium server; returns the response's `value`. */
  async appiumRequest<T = unknown>(serverUrl: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    if (!isSauceLabsUrl(serverUrl)) throw new Error(`Refusing to send Sauce Labs credentials to ${serverUrl}`);
    const url = `${serverUrl.replace(/\/$/, '')}${path}`;
    debug('appium %s %s', method, path);
    const response = await this.fetchFn(url, {
      method,
      headers: { Authorization: this.#authHeader, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const text = await response.text();
    const json = parseJsonObject(text) as { value?: { message?: string; error?: string } } | undefined;
    if (!response.ok) {
      throw new Error(`Appium ${method} ${path} failed: ${response.status} ${json?.value?.message ?? json?.value?.error ?? text}`);
    }
    return json?.value as T;
  }

  // ─── WebDriverAgent (iOS) ─────────────────────────────────────────────────

  async launchWebDriverAgent(sessionId: string, opts: { bundleId?: string; app?: string } = {}): Promise<void> {
    const bundleId = opts.bundleId ?? DEFAULT_WDA_BUNDLE_ID;
    debug('launchWebDriverAgent %s bundleId=%s app=%s', sessionId, bundleId, opts.app);
    await this.request('POST', `/sessions/${sessionId}/device/launchWebDriverAgent`,
      { bundleId, ...(opts.app ? { app: opts.app } : {}) }, { noContent: true });
  }

  /** The launched WDA's state, and its port once it runs. */
  async checkWebDriverAgentStatus(sessionId: string): Promise<CheckWebDriverAgentStatusResponse> {
    debug('checkWebDriverAgentStatus %s', sessionId);
    return this.request<CheckWebDriverAgentStatusResponse>('POST', `/sessions/${sessionId}/device/checkWebDriverAgentStatus`, {});
  }

  /** An HTTP request to WebDriverAgent on the device, through the API's HTTP proxy. */
  async wdaRequest<T = unknown>(
    sessionId: string,
    method: string,
    wdaHost: string,
    wdaPort: number,
    wdaPath: string,
    body?: unknown,
  ): Promise<T> {
    const path = wdaPath.startsWith('/') ? wdaPath.slice(1) : wdaPath;
    const url = `${this.baseUrl}/sessions/${sessionId}/device/proxy/http/${wdaHost}/${wdaPort}/${path}`;
    debug('wdaRequest %s %s', method, url);
    const response = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: this.#authHeader,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`WDA proxy ${method} ${wdaPath} failed: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ─── App Storage ──────────────────────────────────────────────────────────

  /** Uploads a local file to Sauce Storage, or reuses a stored file with the same SHA-256; returns `storage:<id>`. */
  async uploadToStorage(filePath: string): Promise<string> {
    debug('uploadToStorage %s', filePath);
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const content = await readFile(filePath);
    const existing = await this.findInStorageBySha256(sha256Hex(content));
    if (existing) {
      debug('%s is already in storage → %s', basename(filePath), existing);
      return existing;
    }
    return `storage:${await this.upload(content, basename(filePath))}`;
  }

  /** The bundle id in an IPA's Info.plist. Downloads the whole file, so it's only for apps installed from a URL. */
  async ipaBundleId(url: string): Promise<string | undefined> {
    debug('ipaBundleId %s', url);
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(await this.download(url));
    const infoPlist = zip.getEntries().find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.entryName));
    return infoPlist ? plistString(infoPlist.getData(), 'CFBundleIdentifier') : undefined;
  }

  /** `storage:<id>` of a stored file with this SHA-256, or null. */
  async findInStorageBySha256(sha256: string): Promise<string | null> {
    const item = (await this.storageFiles(`sha256=${sha256}&per_page=1`)).find((i) => i.sha256 === sha256 && i.id);
    return item ? `storage:${item.id}` : null;
  }

  /** `storage:<id>` of a stored file with exactly this name, or null. */
  async findInStorage(filename: string): Promise<string | null> {
    debug('findInStorage %s', filename);
    const item = (await this.storageFiles(`q=${encodeURIComponent(filename)}&per_page=25`)).find((i) => i.name === filename);
    return item?.id ? `storage:${item.id}` : null;
  }

  /**
   * The bundle id / package name Sauce Storage recorded for `storage:<id>` or `storage:filename=<name>` (the
   * newest file with that name), or undefined.
   */
  async storageAppIdentifier(storageRef: string): Promise<string | undefined> {
    const ref = storageRef.replace(/^storage:/, '');
    const filename = ref.startsWith('filename=') ? ref.slice('filename='.length) : undefined;
    const items = await this.storageFiles(filename ? `q=${encodeURIComponent(filename)}&per_page=25` : `file_id=${encodeURIComponent(ref)}`);
    return items.find((i) => (filename ? i.name === filename : i.id === ref))?.metadata?.identifier;
  }

  /** Puts a WDA runner zip in Sauce Storage as an IPA, unless it's already there; returns its `storage:filename=` ref. */
  async uploadWdaToStorage(url: string): Promise<string> {
    debug('uploadWdaToStorage %s', url);
    const ipaFilename = ipaFilenameFromUrl(url);
    if (await this.findInStorage(ipaFilename)) {
      debug('WDA already in storage: %s', ipaFilename);
      return `storage:filename=${ipaFilename}`;
    }
    const ipa = await repackageToIpa(await this.download(url));
    await this.upload(ipa, ipaFilename);
    return `storage:filename=${ipaFilename}`;
  }

  /** Files in Sauce Storage matching `query`; an empty list when the lookup fails. */
  private async storageFiles(query: string): Promise<StorageFile[]> {
    const response = await this.fetchFn(`${this.storageFilesUrl}?${query}`, { headers: { Authorization: this.#authHeader } });
    if (!response.ok) {
      debug('storage lookup %s failed: %s %s', query, response.status, response.statusText);
      return [];
    }
    return ((await response.json()) as { items?: StorageFile[] }).items ?? [];
  }

  /** Uploads a file to Sauce Storage; returns its id. */
  private async upload(content: Buffer, filename: string): Promise<string> {
    const formData = new FormData();
    formData.append('payload', new Blob([content]), filename);
    const response = await this.fetchFn(this.storageUrl, {
      method: 'POST',
      headers: { Authorization: this.#authHeader },
      body: formData,
    });
    if (!response.ok) throw new Error(`Storage upload failed: ${response.status} ${response.statusText}`);
    const json = await response.json() as { item?: { id?: string } };
    const id = json?.item?.id;
    if (!id) throw new Error(`Storage upload response missing item.id: ${JSON.stringify(json)}`);
    debug('uploaded %s (%d bytes) → storage:%s', filename, content.length, id);
    return id;
  }

  /** Downloads a file (without credentials), up to MAX_DOWNLOAD_BYTES. */
  private async download(url: string): Promise<Buffer> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to download from ${url}: ${response.status} ${response.statusText}`);
    return readLimited(response, url, MAX_DOWNLOAD_BYTES);
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  /** An API request; returns the parsed JSON body, or nothing with `noContent`. */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { noContent?: boolean; allow404?: boolean } = {},
  ): Promise<T> {
    const response = await this.send(method, path, body, opts.allow404);
    if (opts.noContent || (opts.allow404 && response.status === 404) || method === 'DELETE') return undefined as T;
    return response.json() as Promise<T>;
  }

  private async send(method: string, path: string, body?: unknown, allow404 = false): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.#authHeader,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && !(allow404 && response.status === 404)) {
      const text = await response.text().catch(() => '');
      throw apiError(method, path, response.status, response.statusText, text);
    }
    return response;
  }
}
