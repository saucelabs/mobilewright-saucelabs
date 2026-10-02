import { test, expect } from '@playwright/test';
import type { RestClient } from './rest-client.js';
import { WdaClient, DEVICE_WDA_PORT } from './wda-client.js';

// ─── Fake RestClient ─────────────────────────────────────────────────────────

interface FakeRestOptions {
  /** Whether the device's WebDriverAgent answers GET /status through the proxy. */
  deviceWdaUp?: boolean;
  /** Error thrown by launchWebDriverAgent, e.g. the 403 public devices return. */
  launchError?: Error;
}

function createFakeRest(opts: FakeRestOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let launched = false;

  const rest = {
    async wdaRequest(_sessionId: string, method: string, host: string, port: number, path: string, body?: unknown) {
      calls.push({ method: 'wdaRequest', args: [method, host, port, path, body] });
      if (path === '/status') {
        if (port === DEVICE_WDA_PORT && opts.deviceWdaUp) return { value: { ready: true } };
        throw new Error(`WDA proxy GET /status failed: 500 dial tcp [::1]:${port}: connect: connection refused`);
      }
      if (method === 'POST' && path === '/session') return { sessionId: 'wda-sess' };
      if (path.endsWith('/source')) return { value: '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Tom &amp; Jerry" value="say &quot;hi&quot;"/></XCUIElementTypeApplication>' };
      return {};
    },
    async checkWebDriverAgentStatus() {
      calls.push({ method: 'checkWebDriverAgentStatus', args: [] });
      return launched ? { state: 'RUNNING', devicePort: 8200 } : { state: 'STOPPED' };
    },
    async installApp(...args: unknown[]) {
      calls.push({ method: 'installApp', args });
      return { status: 'INSTALLED' };
    },
    async launchWebDriverAgent(...args: unknown[]) {
      calls.push({ method: 'launchWebDriverAgent', args });
      if (opts.launchError) throw opts.launchError;
      launched = true;
    },
  };

  return { rest: rest as unknown as RestClient, calls, called: (m: string) => calls.filter((c) => c.method === m) };
}

const PUBLIC_DEVICE_403 = new Error(
  'POST /sessions/s1/device/launchWebDriverAgent failed: 403 {"title":"Feature not available on public devices"}',
);

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('WdaClient', () => {
  test('uses the WebDriverAgent on the device without uploading or launching one', async () => {
    const { rest, called } = createFakeRest({ deviceWdaUp: true });
    let resolved = 0;
    const wda = new WdaClient(rest, 's1', { resolveStorageRef: async () => { resolved++; return 'storage:wda'; } });

    const nodes = await wda.getSource();

    expect(nodes[0]?.type).toBe('XCUIElementTypeApplication');
    // XML entities in WDA's source are decoded.
    expect(nodes[0]?.children[0]).toMatchObject({ label: 'Tom & Jerry', value: 'say "hi"' });
    expect(resolved).toBe(0);
    expect(called('launchWebDriverAgent')).toHaveLength(0);
    expect(called('installApp')).toHaveLength(0);
    expect(called('checkWebDriverAgentStatus')).toHaveLength(0);
    const source = called('wdaRequest').find((c) => String(c.args[3]).endsWith('/source'));
    expect(source?.args[2]).toBe(DEVICE_WDA_PORT);
  });

  test('falls back to uploading and launching its own WDA when the one on the device does not answer', async () => {
    const { rest, called } = createFakeRest({ deviceWdaUp: false });
    let resolved = 0;
    const wda = new WdaClient(rest, 's1', { resolveStorageRef: async () => { resolved++; return 'storage:wda'; } });

    await wda.getSource();

    expect(resolved).toBe(1);
    expect(called('installApp')[0]?.args[1]).toBe('storage:wda');
    expect(called('launchWebDriverAgent')).toHaveLength(1);
    const source = called('wdaRequest').find((c) => String(c.args[3]).endsWith('/source'));
    expect(source?.args[2]).toBe(8200);
  });

  test('launches a configured custom WDA without probing the one on the device', async () => {
    const { rest, called } = createFakeRest({ deviceWdaUp: true });
    const wda = new WdaClient(rest, 's1', {
      bundleId: 'com.example.WDA.xctrunner',
      preferDeviceWda: false,
      resolveStorageRef: async () => 'storage:custom-wda',
    });

    await wda.getSource();

    expect(called('wdaRequest').some((c) => c.args[3] === '/status')).toBe(false);
    expect(called('installApp')[0]?.args[1]).toBe('storage:custom-wda');
    expect(called('launchWebDriverAgent')[0]?.args[1]).toEqual({ bundleId: 'com.example.WDA.xctrunner' });
  });

  test('explains a public-device 403 when the WebDriverAgent on the device does not answer', async () => {
    const { rest } = createFakeRest({ deviceWdaUp: false, launchError: PUBLIC_DEVICE_403 });
    const wda = new WdaClient(rest, 's1', { resolveStorageRef: async () => undefined });

    await expect(wda.getSource()).rejects.toThrow(/only available on Sauce Labs private devices, and the one on the device did not respond/);
  });

  test('tells the user to drop the custom WDA options when a custom launch hits the public-device 403', async () => {
    const { rest } = createFakeRest({ launchError: PUBLIC_DEVICE_403 });
    const wda = new WdaClient(rest, 's1', { preferDeviceWda: false, resolveStorageRef: async () => 'storage:custom-wda' });

    await expect(wda.getSource()).rejects.toThrow(/Remove the iosWdaStorageRef \/ iosWdaBundleId options/);
  });
});

// ─── clearActiveElement ──────────────────────────────────────────────────────

test.describe('WdaClient.clearActiveElement()', () => {
  /** Fake with a ready device WebDriverAgent, answering the element lookups with the given responses. */
  function createElementRest(lookups: { active?: unknown; predicate?: unknown; activeFails?: boolean; rectFails?: boolean }) {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const rest = {
      async wdaRequest(_s: string, method: string, _h: string, _p: number, path: string, body?: unknown) {
        requests.push({ method, path, body });
        if (path === '/status') return { value: { ready: true } };
        if (method === 'POST' && path === '/session') return { sessionId: 'wda-sess' };
        if (path.endsWith('/element/active')) {
          if (lookups.activeFails) throw new Error('WDA proxy GET element/active failed: 404');
          return lookups.active;
        }
        if (method === 'POST' && path.endsWith('/element')) return lookups.predicate;
        if (path.endsWith('/rect')) {
          if (lookups.rectFails) throw new Error('WDA proxy GET rect failed: 500');
          return { value: { x: 10, y: 20, width: 300, height: 44 } };
        }
        return {};
      },
    };
    return { rest: rest as unknown as RestClient, requests };
  }
  const W3C = 'element-6066-11e4-a52f-4a6e2b6e4b84';

  test('clears the element WDA reports as active', async () => {
    const { rest, requests } = createElementRest({ active: { value: { [W3C]: 'el-1' } } });
    await new WdaClient(rest, 's1').clearActiveElement();

    const clear = requests.find((r) => r.path.endsWith('/clear'));
    expect(clear?.path).toBe('/session/wda-sess/element/el-1/clear');
    expect(requests.some((r) => r.body && (r.body as any).using === 'predicate string')).toBe(false);
  });

  test('falls back to the element with keyboard focus when element/active fails', async () => {
    const { rest, requests } = createElementRest({ activeFails: true, predicate: { value: { ELEMENT: 'el-2' } } });
    await new WdaClient(rest, 's1').clearActiveElement();

    const lookup = requests.find((r) => r.method === 'POST' && r.path.endsWith('/element'));
    expect(lookup?.body).toEqual({ using: 'predicate string', value: 'hasKeyboardFocus == 1' });
    expect(requests.find((r) => r.path.endsWith('/clear'))?.path).toBe('/session/wda-sess/element/el-2/clear');
  });

  test('returns the cleared element\'s rect, or undefined when WDA cannot report it', async () => {
    const ok = createElementRest({ active: { value: { [W3C]: 'el-1' } } });
    expect(await new WdaClient(ok.rest, 's1').clearActiveElement()).toEqual({ x: 10, y: 20, width: 300, height: 44 });

    const failing = createElementRest({ active: { value: { [W3C]: 'el-1' } }, rectFails: true });
    expect(await new WdaClient(failing.rest, 's1').clearActiveElement()).toBeUndefined();
  });

  test('explains when no element has focus', async () => {
    const { rest } = createElementRest({ active: { value: null }, predicate: { value: null } });
    await expect(new WdaClient(rest, 's1').clearActiveElement()).rejects.toThrow(/no focused element to clear/);
  });
});

test('iOS visibility follows the element\'s frame, not WDA\'s visible attribute', async () => {
  const source = '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" visible="true" x="0" y="0" width="390" height="844">'
    + '<XCUIElementTypeStepper type="XCUIElementTypeStepper" name="stepper" value="1" visible="false" x="16" y="420" width="358" height="44"/>'
    + '<XCUIElementTypeOther type="XCUIElementTypeOther" name="offscreen" visible="true" x="-400" y="0" width="390" height="44"/>'
    + '<XCUIElementTypeOther type="XCUIElementTypeOther" name="empty" visible="true" x="10" y="10" width="0" height="0"/>'
    + '</XCUIElementTypeApplication>';
  const rest = {
    async wdaRequest(_s: string, method: string, _h: string, _p: number, path: string) {
      if (path === '/status') return { value: { ready: true } };
      if (method === 'POST' && path === '/session') return { sessionId: 'wda-sess' };
      return { value: source };
    },
  } as unknown as RestClient;
  const [app] = await new WdaClient(rest, 's1').getSource();

  expect(app.children.map((n) => [n.identifier, n.isVisible])).toEqual([['stepper', true], ['offscreen', false], ['empty', false]]);
});

test('iOS switches report their value as checked state; other elements leave it unset', async () => {
  const source = '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App" x="0" y="0" width="390" height="844">'
    + '<XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="on" value="1" x="0" y="0" width="51" height="31"/>'
    + '<XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="off" value="0" x="0" y="40" width="51" height="31"/>'
    + '<XCUIElementTypeToggle type="XCUIElementTypeToggle" name="toggle" value="1" x="0" y="80" width="51" height="31"/>'
    + '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="text" value="1" x="0" y="120" width="51" height="31"/>'
    + '</XCUIElementTypeApplication>';
  const rest = {
    async wdaRequest(_s: string, method: string, _h: string, _p: number, path: string) {
      if (path === '/status') return { value: { ready: true } };
      if (method === 'POST' && path === '/session') return { sessionId: 'wda-sess' };
      return { value: source };
    },
  } as unknown as RestClient;
  const [app] = await new WdaClient(rest, 's1').getSource();

  expect(app.children.map((n) => [n.identifier, n.isChecked])).toEqual([['on', true], ['off', false], ['toggle', true], ['text', undefined]]);
});

test('dismissAlert reports whether an alert was on screen', async () => {
  const restWith = (alert: boolean) => ({
    async wdaRequest(_s: string, method: string, _h: string, _p: number, path: string) {
      if (path === '/status') return { value: { ready: true } };
      if (method === 'POST' && path === '/session') return { sessionId: 'wda-sess' };
      if (path.endsWith('/alert/dismiss') && !alert) throw new Error('WDA proxy POST /alert/dismiss failed: 404 no such alert');
      return { value: null };
    },
  } as unknown as RestClient);

  expect(await new WdaClient(restWith(true), 's1').dismissAlert()).toBe(true);
  expect(await new WdaClient(restWith(false), 's1').dismissAlert()).toBe(false);
});

test('concurrent calls open a single WDA session', async () => {
  const { rest, calls } = createFakeRest({ deviceWdaUp: true });
  const wda = new WdaClient(rest, 's1');

  await Promise.all([wda.getSource(), wda.getActiveAppInfo(), wda.listApps()]);

  expect(calls.filter((c) => c.args[0] === 'POST' && c.args[3] === '/session')).toHaveLength(1);
});
