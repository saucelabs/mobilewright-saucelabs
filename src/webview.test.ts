import { test, expect } from '@playwright/test';
import type { RestClient } from './rest-client.js';
import { DEFAULT_HOSTED_APPIUM_VERSION, HostedAppiumWebViews } from './webview.js';

/**
 * A fake hosted Appium: contexts with a URL/title each, plus scripted execute results. Switching into a
 * `suspended` context times out, like a Safari tab in the background on iOS 18+.
 */
function createAppium(
  webviews: Record<string, { url: string; title: string }>,
  execute: (script: string) => unknown = () => null,
  suspended: string[] = [],
  /** Contexts whose switch times out only in the first Appium session. */
  stuckOnce: string[] = [],
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const servers: string[] = [];
  let sessions = 0;
  let context = 'NATIVE_APP';
  let listed = false;
  const rest = {
    async ensureAppiumServer(_sessionId: string, version: string) {
      servers.push(version);
      return 'https://appium.example/wd/hub';
    },
    async appiumRequest(_url: string, method: string, path: string, body?: { name?: string; script?: string }) {
      calls.push({ method, path, body });
      if (method === 'POST' && path === '/session') { context = 'NATIVE_APP'; listed = false; return { sessionId: `appium-${++sessions}` }; }
      const command = path.replace(/^\/session\/appium-\d+/, '');
      if (command === '/contexts') { listed = true; return ['NATIVE_APP', ...Object.keys(webviews)]; }
      if (command === '/context') {
        // Like Appium: a session only switches to a context it has listed.
        if (body!.name !== 'NATIVE_APP' && !listed) throw new Error('Appium POST /context failed: 500 No such context found.');
        const stuck = suspended.includes(body!.name!) || (stuckOnce.includes(body!.name!) && sessions === 1);
        if (stuck) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        context = body!.name!;
        return null;
      }
      if (command === '/execute/sync' && body!.script === 'mobile: getContexts') {
        listed = true;
        return [{ id: 'NATIVE_APP' }, ...Object.entries(webviews).map(([id, w]) => ({ id, ...w, bundleId: 'com.apple.mobilesafari' }))];
      }
      if (command === '/url' && method === 'GET') return webviews[context]?.url;
      if (command === '/title') return webviews[context]?.title;
      if (command === '/execute/sync') return execute(body!.script!);
      return null;
    },
  };
  const commands = () => calls.filter((c) => c.path !== '/session').map((c) => `${c.method} ${c.path.replace(/^\/session\/appium-\d+/, '')}`);
  return { rest: rest as unknown as RestClient, calls, servers, commands, current: () => context };
}

test.describe('HostedAppiumWebViews', () => {
  test('listWebViews starts hosted Appium once and reports each webview\'s URL and title', async () => {
    const appium = createAppium({ WEBVIEW_chrome: { url: 'https://example.com/', title: 'Example Domain' } });
    const bridge = new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android');

    expect(await bridge.listWebViews()).toEqual([{ id: 'WEBVIEW_chrome', url: 'https://example.com/', title: 'Example Domain' }]);
    await bridge.listWebViews();

    expect(appium.servers).toEqual([DEFAULT_HOSTED_APPIUM_VERSION]);
    expect(appium.calls.filter((c) => c.path === '/session')).toHaveLength(1);
    expect(appium.current()).toBe('NATIVE_APP');
  });

  test('creates the Appium session with platform capabilities (Safari pages included on iOS)', async () => {
    const appium = createAppium({ WEBVIEW_1: { url: 'https://a.example/', title: 'A' } });
    await new HostedAppiumWebViews(appium.rest, 'sauce-1', 'ios', 'appium3-custom').listWebViews();

    const created = appium.calls.find((c) => c.path === '/session')!.body as { capabilities: { alwaysMatch: Record<string, unknown> } };
    expect(created.capabilities.alwaysMatch).toMatchObject({
      platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:includeSafariInWebviews': true, 'appium:noReset': true,
    });
    expect(appium.servers).toEqual(['appium3-custom']);
  });

  test('an attached webview evaluates expressions, navigates and reads its URL and title', async () => {
    const appium = createAppium({ WEBVIEW_1: { url: 'https://a.example/', title: 'A' } }, (script) => (script === 'return (1 + 1);' ? 2 : null));
    const page = await new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android').attachWebView('WEBVIEW_1');

    expect(await page.evaluate('1 + 1')).toBe(2);
    await page.goto('https://b.example/');
    await page.goBack();
    await page.goForward();
    await page.reload();
    expect(await page.url()).toBe('https://a.example/');
    expect(await page.title()).toBe('A');

    expect(appium.commands()).toEqual([
      // Appium switches only to a context it has listed.
      'GET /contexts', 'POST /context', 'POST /execute/sync', 'POST /url', 'POST /back', 'POST /forward', 'POST /refresh', 'GET /url', 'GET /title',
    ]);
  });

  test('two attached webviews each switch to their own context before a command', async () => {
    const appium = createAppium({ WEBVIEW_1: { url: 'https://one/', title: '1' }, WEBVIEW_2: { url: 'https://two/', title: '2' } });
    const bridge = new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android');
    const one = await bridge.attachWebView('WEBVIEW_1');
    const two = await bridge.attachWebView('WEBVIEW_2');

    expect(await one.url()).toBe('https://one/');
    expect(await two.url()).toBe('https://two/');
    await two.close();
    expect(appium.current()).toBe('NATIVE_APP');
  });

  test('waitForLoadState polls document.readyState until the page has loaded', async () => {
    const states = ['loading', 'interactive', 'complete'];
    const appium = createAppium({ WEBVIEW_1: { url: 'u', title: 't' } }, () => states.shift() ?? 'complete');
    const page = await new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android').attachWebView('WEBVIEW_1');

    await page.waitForLoadState('load');
    expect(states).toEqual([]);
  });

  test('listWebViews keeps looking for a few seconds while Appium reports no webviews', async () => {
    let calls = 0;
    const appium = createAppium({ WEBVIEW_1: { url: 'https://late/', title: 'Late' } });
    const original = appium.rest.appiumRequest.bind(appium.rest);
    (appium.rest as any).appiumRequest = async (url: string, method: string, path: string, body?: unknown) =>
      (path.endsWith('/contexts') && calls++ < 2 ? ['NATIVE_APP'] : original(url, method, path, body));
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void) => origTimeout(fn, 0);
    try {
      expect(await new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android').listWebViews()).toEqual([{ id: 'WEBVIEW_1', url: 'https://late/', title: 'Late' }]);
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
    expect(calls).toBe(3);
  });

  test('on iOS, listWebViews reads each page\'s URL and title without switching into it', async () => {
    const appium = createAppium({
      'WEBVIEW_9.1': { url: 'https://a.example/', title: 'A' },
      'WEBVIEW_9.2': { url: 'https://b.example/', title: 'B' },
    }, () => null, ['WEBVIEW_9.1']);

    expect(await new HostedAppiumWebViews(appium.rest, 'sauce-1', 'ios').listWebViews()).toEqual([
      { id: 'WEBVIEW_9.1', url: 'https://a.example/', title: 'A' },
      { id: 'WEBVIEW_9.2', url: 'https://b.example/', title: 'B' },
    ]);
    expect(appium.commands()).toEqual(['POST /execute/sync']);
  });

  test('a webview that does not answer the switch fails clearly, and the next call gets a new Appium session', async () => {
    const appium = createAppium({
      'WEBVIEW_9.1': { url: 'https://background/', title: 'Back' },
      'WEBVIEW_9.2': { url: 'https://front/', title: 'Front' },
    }, () => null, ['WEBVIEW_9.1']);
    const bridge = new HostedAppiumWebViews(appium.rest, 'sauce-1', 'ios');

    await expect(bridge.attachWebView('WEBVIEW_9.1')).rejects.toThrow('a Safari tab in the background can\'t be attached');
    // Each stuck session is deleted, since Appium would queue every later command behind the switch: the first
    // one, then the one the retry used.
    expect(appium.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/session/appium-1', '/session/appium-2']);

    const page = await bridge.attachWebView('WEBVIEW_9.2');
    expect(await page.url()).toBe('https://front/');
    expect(appium.calls.filter((c) => c.path === '/session').map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(appium.calls.find((c) => c.path === '/session/appium-1/context')?.body).toEqual({ name: 'WEBVIEW_9.1' });
  });

  test('a switch that does not answer once is retried on a new Appium session', async () => {
    const appium = createAppium({ 'WEBVIEW_9.2': { url: 'https://front/', title: 'Front' } }, () => null, [], ['WEBVIEW_9.2']);
    const bridge = new HostedAppiumWebViews(appium.rest, 'sauce-1', 'ios');

    const page = await bridge.attachWebView('WEBVIEW_9.2');
    expect(await page.url()).toBe('https://front/');
    expect(appium.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/session/appium-1']);
  });

  test('close() ends the Appium session only if one was started', async () => {
    const unused = createAppium({});
    await new HostedAppiumWebViews(unused.rest, 'sauce-1', 'android').close();
    expect(unused.calls).toEqual([]);

    const used = createAppium({});
    const bridge = new HostedAppiumWebViews(used.rest, 'sauce-1', 'android');
    await bridge.listWebViews();
    await bridge.close();
    expect(used.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/session/appium-1' });
  });
});

test('concurrent calls start a single Appium session', async () => {
  const appium = createAppium({ WEBVIEW_1: { url: 'https://one/', title: '1' } });
  const bridge = new HostedAppiumWebViews(appium.rest, 'sauce-1', 'android');

  await Promise.all([bridge.listWebViews(), bridge.listWebViews()]);

  expect(appium.calls.filter((c) => c.path === '/session')).toHaveLength(1);
  expect(appium.servers).toHaveLength(1);
});
