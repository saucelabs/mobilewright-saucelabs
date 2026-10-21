/**
 * Integration tests on real Sauce Labs devices, one session at a time. Environment:
 *   SAUCE_INTEGRATION=1, SAUCE_USERNAME, SAUCE_ACCESS_KEY (required)
 *   SAUCE_PLATFORM=ios|android (default: ios), SAUCE_REGION (default: us-west-1)
 *   SAUCE_DEVICE_NAME=<regex> (default: a Pixel or an iPhone, no foldables or free-trial devices), SAUCE_OS_VERSION (default: >=13 / >=17)
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import type { Platform, Session, ViewNode } from '@mobilewright/protocol';
import { SauceLabsDriver } from './driver.js';
import { RestClient, type Region } from './rest-client.js';
import { basicAuth } from './util.js';

const INTEGRATION = process.env['SAUCE_INTEGRATION'] === '1';
const HAS_CREDENTIALS = Boolean(process.env['SAUCE_USERNAME'] && process.env['SAUCE_ACCESS_KEY']);
const PLATFORM = (process.env['SAUCE_PLATFORM'] ?? 'ios') as Platform;
const REGION = (process.env['SAUCE_REGION'] ?? 'us-west-1') as Region;
const IOS_WDA_STORAGE_REF = process.env['SAUCE_IOS_WDA_STORAGE_REF'];
// Foldables (apps there can launch onto the display that isn't shown) and free-trial devices (`_free` in the id) are
// excluded. The patterns only match device ids, since display names have spaces.
const DEVICE_NAME = process.env['SAUCE_DEVICE_NAME'] ?? (PLATFORM === 'android' ? '^Google_Pixel_(?!.*(Fold|_free))' : '^iPhone_(?!.*_free)');
// The demo app needs iOS 16.6+, and fill() Android 13+.
const OS_VERSION = process.env['SAUCE_OS_VERSION'] ?? (PLATFORM === 'android' ? '>=13' : '>=17');
const SETTINGS_APP = PLATFORM === 'android' ? 'com.android.settings' : 'com.apple.Preferences';
/** Sauce Labs' public demo app (https://github.com/saucelabs/my-demo-app-android, -ios). Override with SAUCE_TEST_APP. */
const DEMO_APP = process.env['SAUCE_TEST_APP'] ?? (PLATFORM === 'android'
  ? 'https://github.com/saucelabs/my-demo-app-android/releases/download/2.3.0/mda-2.3.0-27.apk'
  : 'https://github.com/saucelabs/my-demo-app-ios/releases/download/2.3.0/SauceLabs-Demo-App.ipa');
const DEMO_BUNDLE = PLATFORM === 'android' ? 'com.saucelabs.mydemoapp.android' : 'com.saucelabs.mydemo.app.ios';
/** For calls the driver doesn't make. */
const AUTHORIZATION = basicAuth(process.env['SAUCE_USERNAME'] ?? '', process.env['SAUCE_ACCESS_KEY'] ?? '');

/** The Access API's device file endpoints, in DEMO_BUNDLE's sandbox on iOS, for checking app data. */
const deviceFiles = {
  async request(sessionId: string, op: string, body: string | FormData, json: boolean): Promise<Response> {
    const response = await fetch(`https://api.${REGION}.saucelabs.com/rdc/v2/sessions/${sessionId}/device/${op}`, {
      method: 'POST',
      headers: { Authorization: AUTHORIZATION, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body,
    });
    if (!response.ok) throw new Error(`${op} failed: ${response.status} ${await response.text()}`);
    return response;
  },
  async push(sessionId: string, path: string, content: string): Promise<void> {
    const form = new FormData();
    form.append('destinationPath', path);
    if (PLATFORM === 'ios') form.append('bundleId', DEMO_BUNDLE);
    form.append('file', new Blob([content]), 'file.txt');
    await this.request(sessionId, 'pushFile', form, false);
  },
  async list(sessionId: string, path: string): Promise<string[]> {
    const body = JSON.stringify({ path, ...(PLATFORM === 'ios' ? { bundleId: DEMO_BUNDLE } : {}) });
    return (await this.request(sessionId, 'listFiles', body, true)).json() as Promise<string[]>;
  },
};

// Reporting to Sauce Labs Test Results is off here, so only the test that checks it creates results.
const newDriver = () => new SauceLabsDriver({
  region: REGION,
  reportTests: false,
  ...(IOS_WDA_STORAGE_REF ? { iosWdaStorageRef: IOS_WDA_STORAGE_REF } : {}),
});
const rest = () => new RestClient(process.env['SAUCE_USERNAME']!, process.env['SAUCE_ACCESS_KEY']!, REGION);

test.describe.configure({ mode: 'serial' });
test.skip(!INTEGRATION || !HAS_CREDENTIALS, 'Requires SAUCE_INTEGRATION=1, SAUCE_USERNAME, and SAUCE_ACCESS_KEY');

test.describe('SauceLabsDriver integration: session lifecycle', () => {
  test.setTimeout(240_000);

  test('connect() creates its own session and disconnect() closes it', async () => {
    const driver = newDriver();
    const session = await driver.connect({ platform: PLATFORM, deviceName: new RegExp(DEVICE_NAME), osVersion: OS_VERSION });
    try {
      expect(session.platform).toBe(PLATFORM);
      expect(session.deviceId).toBeTruthy();
      await driver.disconnect();
    } finally {
      await rest().deleteSession(session.deviceId).catch(() => {});
    }
    await expectSessionClosed(session.deviceId);
  });

  test('device pool flow: allocate() → connect({ deviceId }) → disconnect() → release()', async () => {
    const driver = newDriver();
    const device = await driver.allocate({ platform: PLATFORM, deviceNamePattern: DEVICE_NAME, osVersion: OS_VERSION }, new Set());
    try {
      expect(device).toMatchObject({ platform: PLATFORM, driver: 'saucelabs', type: 'real' });
      expect(device.model).toBeTruthy();

      // A worker attaches to the pool's session instead of creating a second one.
      const session = await driver.connect({ platform: PLATFORM, deviceId: device.deviceId });
      expect(session.deviceId).toBe(device.deviceId);
      await driver.disconnect();
      expect((await rest().getSession(device.deviceId)).state).toBe('ACTIVE');
    } finally {
      await driver.release(device.deviceId);
    }
    await expectSessionClosed(device.deviceId);
  });

  test('reports the running test to Sauce Labs Test Results', async () => {
    const reporting = () => new SauceLabsDriver({ region: REGION, build: 'mobilewright-driver integration', tags: ['integration'] });
    const pool = reporting();
    const device = await pool.allocate({ platform: PLATFORM, deviceNamePattern: DEVICE_NAME, osVersion: OS_VERSION }, new Set());
    try {
      // The worker half: connect() starts a Sauce Labs test named after this Playwright test, disconnect() ends it.
      const worker = reporting();
      await worker.connect({ platform: PLATFORM, deviceId: device.deviceId });
      await worker.disconnect();

      // Waits until the job reports its end time.
      const tests = await waitFor(30_000, async () => {
        const listed = await rest().getTests(device.deviceId);
        return listed.length === 1 && listed[0].endTime ? listed : undefined;
      }) ?? await rest().getTests(device.deviceId);
      expect(tests).toHaveLength(1);
      expect(tests[0].endTime).toBeTruthy();
      const job = await (await fetch(tests[0].links!.self!, { headers: { Authorization: AUTHORIZATION } })).json() as Record<string, unknown>;
      // A retry is reported as `… (retry 1)`, so the retry's job isn't mixed up with the first try's.
      const { titlePath, retry } = test.info();
      expect(job['name']).toBe(titlePath.join(' › ') + (retry > 0 ? ` (retry ${retry})` : ''));
      expect(job['build']).toBe('mobilewright-driver integration');
      // Still running when disconnect() ended it, so it counts as passing.
      expect(job['passed']).toBe(true);
    } finally {
      await pool.release(device.deviceId);
    }
  });
});

test.describe('SauceLabsDriver integration: Sauce Connect', () => {
  test.setTimeout(420_000);

  test('sauceConnect: the device reaches a server on this machine through the tunnel, stopped by dispose()', async () => {
    // Devices never send localhost or 127.0.0.1 through the tunnel (Chrome and Safari connect to the device itself),
    // so the page uses a made-up host: only it goes through the tunnel, and sc hands it to this server as its
    // upstream proxy, so nothing resolves the name.
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(new URL(req.url ?? '/', 'http://mobilewright.test').pathname);
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Reached through Sauce Connect</h1></body></html>');
    });
    // Safari tries HTTPS first; refusing it makes Safari fall back to HTTP.
    server.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const driver = new SauceLabsDriver({
      region: REGION, reportTests: false, sauceConnect: true,
      sauceConnectOpts: { proxyLocalhost: 'allow', proxy: `127.0.0.1:${port}`, tunnelDomains: 'mobilewright\\.test', tlsPassthroughDomains: 'mobilewright\\.test' },
    });
    let tunnelName: string | undefined;
    // An account must have Sauce Connect enabled for public devices; without it only the tunnel itself is checked.
    let blocked: string | undefined;
    try {
      // What Mobilewright's device pool does: prepare(), allocate(), a worker's connect(), release(), dispose().
      await driver.prepare();
      tunnelName = (await driver['tunnel'])?.tunnelName;
      expect(await activeTunnelNames()).toContain(tunnelName);
      const device = await driver.allocate({ platform: PLATFORM, deviceNamePattern: DEVICE_NAME, osVersion: OS_VERSION }, new Set())
        .catch((err: Error) => {
          if (!/only allowed if Sauce Connect is enabled/.test(err.message)) throw err;
          blocked = err.message;
        });
      if (device) {
        try {
          const worker = newDriver();
          await worker.connect({ platform: PLATFORM, deviceId: device.deviceId });
          await worker.openUrl('http://mobilewright.test/from-device');
          await expect.poll(() => paths, { timeout: 90_000 }).toContain('/from-device');
          await worker.disconnect();
        } finally {
          await driver.release(device.deviceId);
        }
      }
    } finally {
      await driver.dispose();
      server.close();
    }
    await expect.poll(activeTunnelNames, { timeout: 60_000 }).not.toContain(tunnelName);
    test.skip(!!blocked, `Device part skipped: ${blocked}`);
  });
});

/** Names of the account's running Sauce Connect tunnels. */
async function activeTunnelNames(): Promise<string[]> {
  const username = encodeURIComponent(process.env['SAUCE_USERNAME'] ?? '');
  const response = await fetch(`https://api.${REGION}.saucelabs.com/rest/v1/${username}/tunnels?full=true`, { headers: { Authorization: AUTHORIZATION } });
  if (!response.ok) throw new Error(`Listing tunnels failed: ${response.status}`);
  const tunnels = await response.json() as Array<{ tunnel_identifier?: string; status?: string }>;
  return tunnels.filter((t) => t.status === 'running').map((t) => t.tunnel_identifier ?? '');
}

test.describe('SauceLabsDriver integration: on one device', () => {
  test.setTimeout(180_000);
  // Created in beforeAll, not here: this runs while tests are collected, before the skip check, and the driver
  // throws without credentials.
  let driver: SauceLabsDriver;
  let deviceId: string;
  let session: Session;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(420_000);
    driver = newDriver();
    deviceId = (await driver.allocate({ platform: PLATFORM, deviceNamePattern: DEVICE_NAME, osVersion: OS_VERSION }, new Set())).deviceId;
    session = await driver.connect({ platform: PLATFORM, deviceId });
  });

  test.afterAll(async () => {
    if (!driver) return;
    await driver.disconnect().catch(() => {});
    if (deviceId) await driver.release(deviceId);
  });

  test('takes a screenshot and returns a non-empty PNG', async () => {
    const screenshot = await driver.screenshot();
    expect(screenshot).toBeInstanceOf(Buffer);
    expect(screenshot.subarray(1, 4).toString()).toBe('PNG');
  });

  test('getScreenSize returns positive dimensions', async () => {
    const size = await driver.getScreenSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    expect(size.scale).toBeGreaterThanOrEqual(1);
  });

  test('getOrientation returns portrait or landscape', async () => {
    expect(await driver.getOrientation()).toMatch(/^(portrait|landscape)$/);
  });

  test('getViewHierarchy returns a non-empty node tree', async () => {
    const hierarchy = await driver.getViewHierarchy();
    expect(hierarchy.length).toBeGreaterThan(0);
    expect(hierarchy[0].type).toBeTruthy();
  });

  test('listDevices returns devices of both platforms', async () => {
    const devices = await driver.listDevices();
    expect(devices.length).toBeGreaterThan(0);
    expect(devices[0].id).toBeTruthy();
    expect(devices[0].platform).toMatch(/^(ios|android)$/);
  });

  test('listApps returns apps, without Sauce Labs\' own packages', async () => {
    const apps = await driver.listApps();
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.filter((a) => /^(org\.testobject|com\.saucelabs?)\./.test(a.bundleId))).toEqual([]);
  });

  test('launchApp brings an app to the foreground and terminateApp closes it', async () => {
    await driver.launchApp(SETTINGS_APP);
    await expect.poll(async () => (await driver.getForegroundApp()).bundleId, { timeout: 30_000 }).toBe(SETTINGS_APP);

    await driver.terminateApp(SETTINGS_APP);
    await expect.poll(async () => (await driver.getForegroundApp()).bundleId, { timeout: 30_000 }).not.toBe(SETTINGS_APP);
  });

  test('openUrl opens a web page in a browser', async () => {
    await driver.openUrl('https://example.com');
    await expect.poll(async () => (await driver.getForegroundApp()).bundleId, { timeout: 30_000 })
      .toMatch(/chrome|browser|safari|sbrowser/i);
  });

  test('tap, swipe and pressButton HOME do not throw', async () => {
    const size = await driver.getScreenSize();
    await driver.tap(size.width / 2, size.height / 2);
    await driver.swipe('up');
    await driver.pressButton('HOME');
  });

  test('setOrientation rotates the device and back', async () => {
    // Home screens and iPhone Settings stay portrait; these apps rotate. Rotating while the app is still
    // launching (home screen showing) has no effect, so wait for it to be in front.
    const rotatingApp = PLATFORM === 'android' ? 'com.android.settings' : 'com.apple.mobilesafari';
    await driver.launchApp(rotatingApp);
    await expect.poll(async () => (await driver.getForegroundApp()).bundleId, { timeout: 30_000 }).toBe(rotatingApp);
    await driver.setOrientation('landscape');
    await expect.poll(() => driver.getOrientation(), { timeout: 30_000 }).toBe('landscape');
    await driver.setOrientation('portrait');
    await expect.poll(() => driver.getOrientation(), { timeout: 30_000 }).toBe('portrait');
  });

  test('fill(\'\') empties a focused field, so retyping does not append, and value reports it', async () => {
    await focusSettingsSearch(driver, session.deviceId);

    await driver.typeText('hello123');
    await expectFieldValue(driver, 'hello123', 'after typing hello123');

    await driver.fill('');
    await expectFieldValue(driver, '', 'after clearing');

    await driver.typeText('abc');
    await expectFieldValue(driver, 'abc', 'after retyping abc');

    await driver.fill('');
    await expectFieldValue(driver, '', 'after clearing again');

    await driver.fill('replaced');
    await expectFieldValue(driver, 'replaced', 'after fill(replaced)');
  });

  test('clearAppData stops the app, removes its files and leaves it installed', async () => {
    test.skip(Boolean(process.env['SAUCE_TEST_APP']), 'Needs the default demo app (its bundle id is known)');
    test.setTimeout(300_000);
    const foreground = async () => (await driver.getForegroundApp()).bundleId;
    await driver.installApp(DEMO_APP);
    await driver.launchApp(DEMO_BUNDLE);
    await expect.poll(foreground, { timeout: 30_000 }).toBe(DEMO_BUNDLE);
    // A file in the app's sandbox on iOS. Android has no app storage the Access API can write to (scoped
    // storage), and pm clear reports whether it cleared the data, which clearAppData checks.
    const marker = '/Documents/mw-marker.txt';
    if (PLATFORM === 'ios') {
      await deviceFiles.push(deviceId, marker, 'marker');
      expect(await deviceFiles.list(deviceId, '/Documents')).toContain(marker);
    }

    await driver.clearAppData(DEMO_BUNDLE);

    await expect.poll(foreground, { timeout: 30_000 }).not.toBe(DEMO_BUNDLE);
    if (PLATFORM === 'ios') expect(await deviceFiles.list(deviceId, '/Documents')).not.toContain(marker);
    await driver.launchApp(DEMO_BUNDLE);
    await expect.poll(foreground, { timeout: 30_000 }).toBe(DEMO_BUNDLE);
  });

  test('webViewBridge drives a browser page through hosted Appium, and the driver keeps working', async () => {
    test.setTimeout(300_000);
    // A URL of its own: the earlier tests' pages stay open in other tabs. iOS lists each Safari tab; Android
    // lists Chrome once, on the tab ChromeDriver attached to, which may be an earlier one.
    const url = `https://example.com/?webview-test=${Date.now()}`;
    const expected = PLATFORM === 'ios' ? url : expect.stringContaining('example.com');
    await driver.openUrl(url);
    const webviews = await expect.poll(async () => driver.webViewBridge.listWebViews(), { timeout: 60_000 })
      .toContainEqual(expect.objectContaining({ url: expected }))
      .then(() => driver.webViewBridge.listWebViews());
    const example = webviews.find((w) => (PLATFORM === 'ios' ? w.url === url : w.url.includes('example.com')))!;
    expect(example.title).toBe('Example Domain');

    const page = await driver.webViewBridge.attachWebView(example.id);
    expect(await page.evaluate<string>('document.title')).toBe('Example Domain');
    await page.goto('https://example.org/');
    await page.waitForLoadState();
    expect(await page.url()).toContain('example.org');
    await page.close();

    // Hosted Appium must not take the device away from the driver.
    expect((await driver.getViewHierarchy()).length).toBeGreaterThan(0);
  });

  test('webViewBridge: a Safari tab in the background attaches or fails fast, and the tab in front still works', async () => {
    test.skip(PLATFORM !== 'ios', 'Safari tabs are iOS only');
    test.setTimeout(300_000);
    const background = `https://example.com/?background=${Date.now()}`;
    const front = `https://example.org/?front=${Date.now()}`;
    await driver.openUrl(background);
    await driver.openUrl(front);
    const webviews = await expect.poll(async () => driver.webViewBridge.listWebViews(), { timeout: 60_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ url: background }), expect.objectContaining({ url: front })]))
      .then(() => driver.webViewBridge.listWebViews());

    // On iOS 18+, Safari suspends a tab some time after it leaves the front; attaching one then never answers.
    const started = Date.now();
    const attached = await driver.webViewBridge.attachWebView(webviews.find((w) => w.url === background)!.id)
      .then((page) => page.close(), (err: Error) => err);
    expect(Date.now() - started).toBeLessThan(40_000);
    if (attached instanceof Error) expect(attached.message).toContain('a Safari tab in the background can\'t be attached');

    const page = await driver.webViewBridge.attachWebView(webviews.find((w) => w.url === front)!.id);
    expect(await page.url()).toBe(front);
    await page.close();
  });
});

/** A deleted session goes CLOSING → CLOSED; either means the device is being released. */
async function expectSessionClosed(sauceSessionId: string): Promise<void> {
  await expect.poll(async () => (await rest().getSession(sauceSessionId)).state, { timeout: 60_000 })
    .toMatch(/^(CLOSING|CLOSED)$/);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const flatten = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const center = (n: ViewNode) => ({ x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 });
const isTextField = (n: ViewNode) =>
  n.bounds.width > 0 && (PLATFORM === 'android'
    ? /EditText|AutoCompleteTextView/.test(n.type)
    : /XCUIElementType(SearchField|TextField)/.test(n.type));
/** What core's getValue() / toHaveValue() / post-clear check read: `value`, '' when absent. */
const fieldValue = (n: ViewNode | undefined) => n?.value ?? '';

/** Polls the field for up to 15s until it reads `expected`; on failure the assertion shows what it last read. */
async function expectFieldValue(driver: SauceLabsDriver, expected: string, step: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let actual = fieldValue(await findField(driver));
  while (actual !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    actual = fieldValue(await findField(driver));
  }
  expect(actual, `field value ${step}`).toBe(expected);
}

async function findField(driver: SauceLabsDriver): Promise<ViewNode | undefined> {
  const nodes = flatten(await driver.getViewHierarchy());
  return nodes.find((n) => isTextField(n) && n.isFocused) ?? nodes.find(isTextField);
}

/** Opens Settings, focuses its search field and returns it. `sauceSessionId` is what connect() returned. */
async function focusSettingsSearch(driver: SauceLabsDriver, sauceSessionId: string): Promise<ViewNode> {
  if (PLATFORM === 'android') {
    await rest().executeShellCommand(sauceSessionId, 'am start -a android.settings.SETTINGS');
    const searchEntry = await waitFor(20_000, async () => flatten(await driver.getViewHierarchy())
      .find((n) => n.isEnabled && /search/i.test(`${n.text ?? ''} ${n.label ?? ''} ${n.identifier ?? ''}`)));
    if (!searchEntry) throw new Error('No search entry found in Android Settings');
    const p = center(searchEntry);
    await driver.tap(p.x, p.y);
  } else {
    await driver.launchApp('com.apple.Preferences');
    // Older iOS versions only reveal the Settings search field after the list is pulled down.
    if (!(await waitFor(5_000, () => findField(driver)))) await driver.swipe('down');
  }

  const field = await waitFor(20_000, () => findField(driver));
  if (!field) throw new Error('No text field found in Settings');
  const p = center(field);
  await driver.tap(p.x, p.y);
  const focused = await waitFor(10_000, () => findField(driver));
  if (!focused) throw new Error('Settings search field disappeared after tapping it');
  return focused;
}

/** Polls `probe` every second until it returns a value, or gives up after `timeoutMs`. */
async function waitFor<T>(timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}
