import createDebug from 'debug';
import type { AppInfo, Bounds, ViewNode } from '@mobilewright/protocol';
import type { RestClient, CheckWebDriverAgentStatusResponse } from './rest-client.js';
import { DEFAULT_WDA_BUNDLE_ID } from './rest-client.js';
import { sleep } from './util.js';
import { parseXmlTree } from './xml.js';

const debug = createDebug('mw:mobilewright-driver:wda');

const WDA_POLL_INTERVAL_MS = 2_000;
/** WDA's answer when the session's application element belongs to an app that has closed. */
const STALE_APPLICATION = /stale element reference[\s\S]*Application '/;
/** How long the driver looks for the focused element after a tap, and how often. */
const FOCUS_WAIT_MS = 3_000;
const FOCUS_POLL_MS = 300;
/** How long typeKeys() waits for the screen to stop moving, and how often it checks. */
const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLL_MS = 250;
const WDA_READY_TIMEOUT_MS = 120_000;

/** Port of the WebDriverAgent already running on Sauce Labs iOS devices. */
export const DEVICE_WDA_PORT = 8100;
const DEVICE_WDA_PROBE_ATTEMPTS = 3;

export interface WdaClientOptions {
  /** Bundle id to launch when the driver starts its own WebDriverAgent. */
  bundleId?: string;
  /** Resolves the `storage:` ref of the WebDriverAgent to install; only called when one has to be launched. */
  resolveStorageRef?: () => Promise<string | undefined>;
  /**
   * Use the WebDriverAgent already running on the device, and launch one only if it doesn't answer.
   * Public devices don't allow launching one. Default: true.
   */
  preferDeviceWda?: boolean;
}

interface WdaSessionResponse {
  sessionId?: string;
  value?: { sessionId?: string };
}

/** W3C element reference key; WDA also returns the legacy `ELEMENT` key. */
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52f-4a6e2b6e4b84';

interface WdaElementResponse {
  value?: { ELEMENT?: string; [W3C_ELEMENT_KEY]?: string } | null;
}

function elementIdOf(resp: WdaElementResponse | undefined): string | undefined {
  return resp?.value?.[W3C_ELEMENT_KEY] ?? resp?.value?.ELEMENT ?? undefined;
}

/** Element types whose `value` is their checked state ("1" / "0"). */
const CHECKABLE_TYPES = new Set(['XCUIElementTypeSwitch', 'XCUIElementTypeToggle', 'XCUIElementTypeCheckBox']);

function parseWdaSource(xml: string): ViewNode[] {
  return parseXmlTree<ViewNode>(xml, (tag, attrs) => {
    const x = Number(attrs['x'] ?? 0);
    const y = Number(attrs['y'] ?? 0);
    const w = Number(attrs['width'] ?? 0);
    const h = Number(attrs['height'] ?? 0);
    return {
      type: tag,
      label: attrs['label'] || attrs['name'] || undefined,
      identifier: attrs['name'] || undefined,
      value: attrs['value'] || undefined,
      text: attrs['label'] || undefined,
      placeholder: attrs['placeholderValue'] || undefined,
      // On screen with a size counts as visible: WDA's `visible` attribute is wrong for some SwiftUI elements.
      isVisible: x >= 0 && y >= 0 && w > 0 && h > 0,
      isEnabled: attrs['enabled'] !== 'false',
      ...(CHECKABLE_TYPES.has(tag) ? { isChecked: attrs['value'] === '1' } : {}),
      bounds: { x, y, width: w, height: h },
      children: [],
      raw: { ...attrs },
    };
  });
}

/** A WebDriverAgent session on an iOS device, reached through the Access API's HTTP proxy. */
export class WdaClient {
  private wdaSessionId: string | null = null;
  private wdaPort: number | null = null;
  private initializing: Promise<void> | null = null;
  private reopening: Promise<void> | null = null;

  private readonly wdaBundleId?: string;
  private readonly resolveStorageRef?: () => Promise<string | undefined>;
  private readonly preferDeviceWda: boolean;

  constructor(
    private readonly rest: RestClient,
    private readonly sessionId: string,
    options: WdaClientOptions = {},
  ) {
    this.wdaBundleId = options.bundleId;
    this.resolveStorageRef = options.resolveStorageRef;
    this.preferDeviceWda = options.preferDeviceWda ?? true;
  }

  /** Finds or launches WebDriverAgent and opens a session, once even when called concurrently. */
  private ensureInitialized(): Promise<void> {
    if (this.wdaSessionId) return Promise.resolve();
    this.initializing ??= this.initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    if (this.preferDeviceWda && await this.probeDeviceWda()) {
      debug('using the WebDriverAgent on the device (port %d)', DEVICE_WDA_PORT);
      this.wdaPort = DEVICE_WDA_PORT;
    } else {
      await this.launchOwnWda();
    }
    await this.openWdaSession();
  }

  /** True when the device's WebDriverAgent answers `/status` as ready. */
  private async probeDeviceWda(): Promise<boolean> {
    for (let attempt = 1; attempt <= DEVICE_WDA_PROBE_ATTEMPTS; attempt++) {
      try {
        const status = await this.rest.wdaRequest<{ value?: { ready?: boolean } }>(
          this.sessionId, 'GET', 'localhost', DEVICE_WDA_PORT, '/status',
        );
        if (status?.value?.ready !== false) return true;
        debug('device WebDriverAgent not ready yet (attempt %d)', attempt);
      } catch (err) {
        debug('device WebDriverAgent probe failed (attempt %d): %s', attempt, (err as Error).message);
      }
      if (attempt < DEVICE_WDA_PROBE_ATTEMPTS) await sleep(WDA_POLL_INTERVAL_MS);
    }
    return false;
  }

  /** Installs (when configured) and launches our own WebDriverAgent, then waits until it runs. */
  private async launchOwnWda(): Promise<void> {
    // An earlier test on the same pooled session may have launched it already; launching again fails.
    const existing = await this.rest.checkWebDriverAgentStatus(this.sessionId).catch(() => undefined);
    if (existing?.state === 'RUNNING' && existing.devicePort) {
      debug('WebDriverAgent already running on port %d', existing.devicePort);
      this.wdaPort = existing.devicePort;
      return;
    }

    const wdaStorageRef = await this.resolveStorageRef?.();
    debug('launching WebDriverAgent bundleId=%s storageRef=%s', this.wdaBundleId, wdaStorageRef);
    try {
      if (wdaStorageRef) {
        await this.rest.installApp(this.sessionId, wdaStorageRef, { launchAfterInstall: true });
        await this.rest.launchWebDriverAgent(this.sessionId, { bundleId: this.wdaBundleId ?? DEFAULT_WDA_BUNDLE_ID });
      } else {
        await this.rest.launchWebDriverAgent(this.sessionId, { bundleId: this.wdaBundleId });
      }
    } catch (err) {
      if (/failed: 403\b/.test((err as Error).message)) {
        throw new Error(
          'Cannot start WebDriverAgent: launching one is only available on Sauce Labs private devices' +
          (this.preferDeviceWda
            ? ', and the one on the device did not respond.'
            : '. Remove the iosWdaStorageRef / iosWdaBundleId options (and SAUCE_IOS_WDA_URL) to use the one on the device.') +
          ` (${(err as Error).message})`,
        );
      }
      throw err;
    }

    const deadline = Date.now() + WDA_READY_TIMEOUT_MS;
    let lastStatus: CheckWebDriverAgentStatusResponse | undefined;
    while (Date.now() < deadline) {
      await sleep(WDA_POLL_INTERVAL_MS);
      lastStatus = await this.rest.checkWebDriverAgentStatus(this.sessionId);
      debug('WebDriverAgent status: %j', lastStatus);
      if (lastStatus.state === 'RUNNING' && lastStatus.devicePort) {
        this.wdaPort = lastStatus.devicePort;
        return;
      }
    }
    throw new Error(`Timed out waiting for WebDriverAgent to run (last status: ${JSON.stringify(lastStatus)})`);
  }

  /** Opens the WebDriver session, retrying while WebDriverAgent is still starting. */
  private async openWdaSession(): Promise<void> {
    const deadline = Date.now() + WDA_READY_TIMEOUT_MS;
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      try {
        const resp = await this.proxy<WdaSessionResponse>('POST', '/session', { capabilities: {} });
        const wdaSessionId = resp?.sessionId ?? resp?.value?.sessionId;
        if (!wdaSessionId) throw new Error(`WDA session response missing sessionId: ${JSON.stringify(resp)}`);
        this.wdaSessionId = wdaSessionId;
        debug('WDA session created: %s', wdaSessionId);
        return;
      } catch (err) {
        lastError = err as Error;
        debug('WDA session attempt failed: %s', lastError.message);
        await sleep(WDA_POLL_INTERVAL_MS);
      }
    }
    throw new Error(`Timed out waiting for WebDriverAgent to accept connections: ${lastError?.message}`);
  }

  /** Deletes the WebDriver session. */
  async close(): Promise<void> {
    const wdaSessionId = this.wdaSessionId;
    if (!wdaSessionId) return;
    this.wdaSessionId = null;
    await this.proxy('DELETE', `/session/${wdaSessionId}`).catch((err) => debug('WDA session close error: %s', (err as Error).message));
  }

  /** The view hierarchy, from WDA's page source. */
  async getSource(): Promise<ViewNode[]> {
    const resp = await this.call<{ value?: string }>('GET', '/source');
    return parseWdaSource(resp?.value ?? '');
  }

  /** The app in the foreground. */
  async getActiveAppInfo(): Promise<AppInfo> {
    try {
      const resp = await this.call<{ value?: { bundleId?: string; name?: string } }>('GET', '/wda/activeAppInfo');
      return { bundleId: resp?.value?.bundleId ?? '', name: resp?.value?.name };
    } catch (err) {
      // WDA answers 500 when it can't describe the app in front (an app without a name); its list of active apps
      // still reports it.
      if (!/ failed: 500\b/.test((err as Error).message)) throw err;
      debug('activeAppInfo failed, using the active apps list: %s', (err as Error).message.split('\n')[0]);
      const [app] = await this.listApps();
      if (!app) throw err;
      return app;
    }
  }

  /** The running apps. */
  async listApps(): Promise<AppInfo[]> {
    const resp = await this.call<{ value?: Array<{ bundleId?: string; name?: string }> }>('GET', '/wda/apps/list');
    return (resp?.value ?? []).map((a) => ({ bundleId: a.bundleId ?? '', name: a.name }));
  }

  /** Dismisses the alert on screen (permission prompts included); false when there is none. */
  async dismissAlert(): Promise<boolean> {
    try {
      await this.call('POST', '/alert/dismiss', {});
      return true;
    } catch (err) {
      debug('no alert to dismiss: %s', (err as Error).message);
      return false;
    }
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.call('POST', '/wda/apps/terminate', { bundleId });
  }

  /** Presses a hardware button by WDA name (`home`, `volumeUp`, …). */
  async pressButton(name: string): Promise<void> {
    await this.call('POST', '/wda/pressButton', { name });
  }

  /**
   * Clears the focused text field. Returns its rect (in points), or undefined if WDA doesn't report it, so the
   * driver can recognize the field in later page sources.
   */
  async clearActiveElement(): Promise<Bounds | undefined> {
    const elementId = await this.findActiveElementId();
    await this.call('POST', `/element/${elementId}/clear`, {});
    try {
      const r = (await this.call<{ value?: Bounds }>('GET', `/element/${elementId}/rect`))?.value;
      return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined;
    } catch (err) {
      debug('rect of cleared element unavailable: %s', (err as Error).message);
      return undefined;
    }
  }

  /**
   * The focused element: `element/active`, falling back to a keyboard-focus predicate. Focus can land a moment after
   * the tap that gives it (iOS 27), so both are asked again for up to FOCUS_WAIT_MS.
   */
  private async findActiveElementId(): Promise<string> {
    const deadline = Date.now() + FOCUS_WAIT_MS;
    for (;;) {
      const id = await this.activeElementIdOnce();
      if (id) return id;
      if (Date.now() >= deadline) throw new Error('fill: no focused text field — tap a text field first');
      await sleep(FOCUS_POLL_MS);
    }
  }

  private async activeElementIdOnce(): Promise<string | undefined> {
    try {
      const id = elementIdOf(await this.call<WdaElementResponse>('GET', '/element/active'));
      if (id) return id;
    } catch (err) {
      debug('element/active failed, falling back to hasKeyboardFocus: %s', (err as Error).message);
    }
    const resp = await this.call<WdaElementResponse>('POST', '/element', { using: 'predicate string', value: 'hasKeyboardFocus == 1' })
      .catch(() => undefined);
    return elementIdOf(resp);
  }

  /**
   * Types into the focused element (`wda/keys`), then waits for the layout to settle. Typing can briefly move the
   * screen (on iOS 27 an alert's text field and buttons jump while the keyboard re-appears), and a page source read in
   * that moment reports positions that are gone a second later, so a tap on them misses. Costs a few rect reads.
   */
  async typeKeys(text: string): Promise<void> {
    await this.call('POST', '/wda/keys', { value: [...text] });
    await this.waitForFocusedElementToSettle();
  }

  /** Reads the focused element's rect until two reads agree, for up to SETTLE_TIMEOUT_MS. */
  private async waitForFocusedElementToSettle(): Promise<void> {
    const elementId = await this.activeElementIdOnce();
    if (!elementId) return; // nothing focused: nothing to wait for
    const rect = () => this.call<{ value?: Bounds }>('GET', `/element/${elementId}/rect`)
      .then((r) => r?.value, () => undefined);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let last = await rect();
    while (Date.now() < deadline) {
      await sleep(SETTLE_POLL_MS);
      const next = await rect();
      if (!next || !last || (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height)) return;
      debug('focused element moved after typing: %o → %o', last, next);
      last = next;
    }
  }

  /** The orientation WDA reports, as PORTRAIT or LANDSCAPE. */
  async getOrientation(): Promise<'PORTRAIT' | 'LANDSCAPE'> {
    const resp = await this.call<{ value?: string }>('GET', '/orientation');
    return /LANDSCAPE/i.test(resp?.value ?? '') ? 'LANDSCAPE' : 'PORTRAIT';
  }

  /**
   * A command on the WDA session (`/session/<id><path>`), opening the session first if needed. A session follows the
   * app that was in front when it opened; when that app has closed since, the command is repeated once on a new
   * session, which follows the app in front now.
   */
  private async call<T = unknown>(method: string, path: string, body?: unknown, reopen = true): Promise<T> {
    await this.ensureInitialized();
    const sessionId = this.wdaSessionId;
    try {
      return await this.proxy<T>(method, `/session/${sessionId}${path}`, body);
    } catch (err) {
      if (!reopen || !STALE_APPLICATION.test((err as Error).message)) throw err;
      debug('WDA session %s follows an app that has closed; opening a new session', sessionId);
      await this.reopenSession(sessionId);
      return this.call<T>(method, path, body, false);
    }
  }

  /** Replaces the WDA session `staleId`, once even when several calls find it stale at the same time. */
  private reopenSession(staleId: string | null): Promise<void> {
    if (this.wdaSessionId !== staleId) return Promise.resolve(); // another call replaced it already
    // The new session opens before the old one is deleted, so other calls never see the client without a session.
    this.reopening ??= (async () => {
      await this.openWdaSession();
      if (staleId) await this.proxy('DELETE', `/session/${staleId}`).catch((err) => debug('WDA session close error: %s', (err as Error).message));
    })().finally(() => { this.reopening = null; });
    return this.reopening;
  }

  private proxy<T = unknown>(method: string, wdaPath: string, body?: unknown): Promise<T> {
    return this.rest.wdaRequest<T>(this.sessionId, method, 'localhost', this.wdaPort!, wdaPath, body);
  }
}
