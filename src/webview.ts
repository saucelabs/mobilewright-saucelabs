import createDebug from 'debug';
import type { Platform, WebViewBridge, WebViewInfo, WebViewSession } from '@mobilewright/protocol';
import type { RestClient } from './rest-client.js';
import { sleep } from './util.js';

const debug = createDebug('mw:mobilewright-driver:webview');

/**
 * Hosted Appium version used for webviews: one checked with Chrome (Android) and Safari (iOS) pages.
 * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/#choosing-an-appium-version
 */
export const DEFAULT_HOSTED_APPIUM_VERSION = 'appium3-2026-07';

const NATIVE_CONTEXT = 'NATIVE_APP';
const LOAD_STATE_TIMEOUT_MS = 30_000;
/** How long listWebViews() keeps looking when Appium reports none: right after it starts, it may not see pages yet. */
const EMPTY_LIST_RETRY_MS = 10_000;
/** How long an idle Appium session lives: short, so one left behind doesn't hold the device's UI automation for long. */
const APPIUM_IDLE_TIMEOUT_S = 300;
/** A context switch takes under a second; one that takes this long won't answer. */
const SWITCH_TIMEOUT_MS = 20_000;

/**
 * Webviews through the Appium server Sauce Labs hosts for the session: its webview contexts give JavaScript,
 * navigation, URL and title. The Appium session starts on first use; close() ends it.
 */
export class HostedAppiumWebViews implements WebViewBridge {
  private serverUrl?: string;
  private appiumSessionId?: string;
  private starting: Promise<{ serverUrl: string; sessionId: string }> | null = null;
  private currentContext = NATIVE_CONTEXT;
  /** Appium only switches to a context it has listed in this session. */
  private contextsListed = false;

  constructor(
    private readonly rest: RestClient,
    private readonly sauceSessionId: string,
    private readonly platform: Platform,
    private readonly appiumVersion: string = DEFAULT_HOSTED_APPIUM_VERSION,
  ) {}

  async listWebViews(): Promise<WebViewInfo[]> {
    if (this.platform === 'ios') return this.listIosWebViews();
    const deadline = Date.now() + EMPTY_LIST_RETRY_MS;
    let contexts = await this.listContexts();
    while (contexts.every((c) => c === NATIVE_CONTEXT) && Date.now() < deadline) {
      await sleep(1_000);
      contexts = await this.listContexts();
    }
    const webviews: WebViewInfo[] = [];
    for (const id of contexts.filter((c) => c !== NATIVE_CONTEXT)) {
      try {
        await this.switchTo(id);
        webviews.push({ id, url: await this.call<string>('GET', '/url'), title: await this.call<string>('GET', '/title') });
      } catch (err) {
        debug('skipping webview %s: %s', id, (err as Error).message);
      }
    }
    await this.switchTo(NATIVE_CONTEXT);
    return webviews;
  }

  /**
   * iOS reports each page's URL and title without switching into it. Switching into a Safari tab in the
   * background never answers on iOS 18 and later, which would block the Appium session.
   */
  private async listIosWebViews(): Promise<WebViewInfo[]> {
    const deadline = Date.now() + EMPTY_LIST_RETRY_MS;
    for (;;) {
      const contexts = await this.call<Array<{ id: string; url?: string; title?: string }>>(
        'POST', '/execute/sync', { script: 'mobile: getContexts', args: [] });
      this.contextsListed = true;
      const webviews = (contexts ?? [])
        .filter((c) => c.id !== NATIVE_CONTEXT)
        .map((c) => ({ id: c.id, url: c.url ?? '', title: c.title ?? '' }));
      if (webviews.length > 0 || Date.now() >= deadline) return webviews;
      await sleep(1_000);
    }
  }

  async attachWebView(id: string): Promise<WebViewSession> {
    await this.switchTo(id);
    // Each call re-selects the context: another attached session may have switched away meanwhile.
    const inWebView = async <T>(method: string, path: string, body?: unknown) => {
      await this.switchTo(id);
      return this.call<T>(method, path, body);
    };
    return {
      // WebDriver's execute waits for a returned promise, so async expressions resolve too.
      evaluate: <T = unknown>(expr: string) => inWebView<T>('POST', '/execute/sync', { script: `return (${expr});`, args: [] }),
      goto: async (url) => { await inWebView('POST', '/url', { url }); },
      goBack: async () => { await inWebView('POST', '/back', {}); },
      goForward: async () => { await inWebView('POST', '/forward', {}); },
      url: () => inWebView<string>('GET', '/url'),
      title: () => inWebView<string>('GET', '/title'),
      reload: async () => { await inWebView('POST', '/refresh', {}); },
      waitForLoadState: async (state = 'load') => {
        const deadline = Date.now() + LOAD_STATE_TIMEOUT_MS;
        for (;;) {
          const readyState = await inWebView<string>('POST', '/execute/sync', { script: 'return document.readyState;', args: [] });
          if (readyState === 'complete' || (state === 'domcontentloaded' && readyState === 'interactive')) return;
          if (Date.now() >= deadline) throw new Error(`waitForLoadState('${state}') timed out (document.readyState is "${readyState}")`);
          await sleep(250);
        }
      },
      close: async () => { await this.switchTo(NATIVE_CONTEXT); },
    };
  }

  /** True while an Appium session runs (on Android it can hold the UI automation connection). */
  get active(): boolean {
    return this.appiumSessionId !== undefined;
  }

  /** The native view hierarchy from Appium, for when its session keeps `uiautomator dump` from working (Android). */
  async nativeSource(): Promise<string> {
    await this.switchTo(NATIVE_CONTEXT);
    return this.call<string>('GET', '/source');
  }

  /** Ends the Appium session, if one was started. */
  async close(): Promise<void> {
    if (!this.serverUrl || !this.appiumSessionId) return;
    const sessionId = this.appiumSessionId;
    this.appiumSessionId = undefined;
    this.currentContext = NATIVE_CONTEXT;
    this.contextsListed = false;
    await this.rest.appiumRequest(this.serverUrl, 'DELETE', `/session/${sessionId}`)
      .catch((err) => debug('closing the Appium session failed: %s', (err as Error).message));
  }

  private async listContexts(): Promise<string[]> {
    const contexts = await this.call<string[]>('GET', '/contexts');
    this.contextsListed = true;
    return contexts;
  }

  private async switchTo(context: string): Promise<void> {
    if (this.currentContext === context) return;
    // A new Appium session (after close(), or a stuck one replaced) hasn't listed them yet.
    if (context !== NATIVE_CONTEXT && !this.contextsListed) await this.listContexts();
    try {
      await this.call('POST', '/context', { name: context }, SWITCH_TIMEOUT_MS);
    } catch (err) {
      if (!isTimeout(err)) throw err;
      // Appium runs a session's commands one at a time, so every later command would wait behind this one.
      await this.close();
      const hint = this.platform === 'ios'
        ? ' On iOS 18 and later, a Safari tab in the background can\'t be attached: bring it to the front, or close the other tabs.'
        : '';
      throw new Error(`Webview ${context} did not respond within ${SWITCH_TIMEOUT_MS / 1000}s.${hint}`, { cause: err });
    }
    this.currentContext = context;
  }

  /** A command on the Appium session, starting the server and session on first use. */
  private async call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const { serverUrl, sessionId } = await this.ensureSession();
    return this.rest.appiumRequest<T>(serverUrl, method, `/session/${sessionId}${path}`, body, timeoutMs);
  }

  /** Starts the Appium server and session, once even when called concurrently. */
  private ensureSession(): Promise<{ serverUrl: string; sessionId: string }> {
    if (this.serverUrl && this.appiumSessionId) return Promise.resolve({ serverUrl: this.serverUrl, sessionId: this.appiumSessionId });
    this.starting ??= this.startSession().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startSession(): Promise<{ serverUrl: string; sessionId: string }> {
    this.serverUrl ??= await this.rest.ensureAppiumServer(this.sauceSessionId, this.appiumVersion);
    const capabilities = this.platform === 'android'
      ? { platformName: 'Android', 'appium:automationName': 'UiAutomator2' }
      : { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:includeSafariInWebviews': true, 'appium:webviewConnectTimeout': 5_000 };
    const created = await this.rest.appiumRequest<{ sessionId?: string }>(this.serverUrl, 'POST', '/session', {
      capabilities: { alwaysMatch: { ...capabilities, 'appium:noReset': true, 'appium:newCommandTimeout': APPIUM_IDLE_TIMEOUT_S } },
    });
    if (!created?.sessionId) throw new Error(`Hosted Appium returned no session id: ${JSON.stringify(created)}`);
    this.appiumSessionId = created.sessionId;
    this.currentContext = NATIVE_CONTEXT;
    debug('Appium session %s on %s', this.appiumSessionId, this.serverUrl);
    return { serverUrl: this.serverUrl, sessionId: this.appiumSessionId };
  }
}

/** The request ran out of time: our time limit, or the Sauce Labs gateway's (504 after 60s). */
function isTimeout(err: unknown): boolean {
  return (err as Error)?.name === 'TimeoutError' || / failed: 504\b/.test((err as Error)?.message ?? '');
}
