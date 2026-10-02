import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestClient, SauceApiError } from './rest-client.js';

// ─── Mock fetch helpers ──────────────────────────────────────────────────────

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function makeMockFetch(responses: Record<string, { status: number; body: unknown }>) {
  const calls: FetchCall[] = [];

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let parsedBody: unknown = init?.body;
    if (typeof parsedBody === 'string') {
      try { parsedBody = JSON.parse(parsedBody); } catch { /* leave as string */ }
    }
    calls.push({ url, method, headers, body: parsedBody });

    // match the longest suffix key
    const key = Object.keys(responses).find((k) => url.includes(k)) ?? '__default';
    const resp = responses[key] ?? { status: 200, body: {} };
    const responseBody = resp.body instanceof Uint8Array
      ? resp.body
      : JSON.stringify(resp.body);
    return new Response(responseBody as string, { status: resp.status });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, calls };
}

const BASE = 'https://api.us-west-1.saucelabs.com/rdc/v2';
const STORAGE_BASE = 'https://api.us-west-1.saucelabs.com/v1/storage/upload';

function client(overrides?: Record<string, { status: number; body: unknown }>) {
  const { mockFetch, calls } = makeMockFetch(overrides ?? { '': { status: 200, body: {} } });
  const rest = new RestClient('alice', 'secret-key', 'us-west-1', mockFetch);
  return { rest, calls };
}

// ─── Auth header ─────────────────────────────────────────────────────────────

test('identifies the driver and its version in the User-Agent', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const { rest, calls } = client({ '/sessions': { status: 200, body: { id: 's1', state: 'CREATING' } } });
  await rest.createSession({ device: { os: 'ANDROID' } });
  await rest.deleteSession('s1');

  expect(calls.map((c) => c.headers['User-Agent'])).toEqual([`saucelabs-mobilewright-driver/${version}`, `saucelabs-mobilewright-driver/${version}`]);
  expect(calls[0].headers['Content-Type']).toBe('application/json');
});

test('includes Basic auth header with base64(username:accessKey)', async () => {
  const { rest, calls } = client({ '/sessions': { status: 200, body: { id: 's1', state: 'CREATING' } } });
  await rest.createSession({ device: { os: 'ANDROID' } });

  const expectedToken = Buffer.from('alice:secret-key').toString('base64');
  expect(calls[0].headers['Authorization']).toBe(`Basic ${expectedToken}`);
});

// ─── Region → URL ────────────────────────────────────────────────────────────

test('uses eu-central-1 base URL when region is eu-central-1', async () => {
  const { mockFetch, calls } = makeMockFetch({ '': { status: 200, body: [] } });
  const rest = new RestClient('u', 'k', 'eu-central-1', mockFetch);
  await rest.listDevices();
  expect(calls[0].url).toMatch(/api\.eu-central-1\.saucelabs\.com/);
});

test('uses us-east-4 base URL when region is us-east-4', async () => {
  const { mockFetch, calls } = makeMockFetch({ '': { status: 200, body: [] } });
  const rest = new RestClient('u', 'k', 'us-east-4', mockFetch);
  await rest.listDevices();
  expect(calls[0].url).toMatch(/api\.us-east-4\.saucelabs\.com/);
});

test('uses asia-south-2 base URL when region is asia-south-2', async () => {
  const { mockFetch, calls } = makeMockFetch({ '': { status: 200, body: [] } });
  const rest = new RestClient('u', 'k', 'asia-south-2', mockFetch);
  await rest.listDevices();
  expect(calls[0].url).toMatch(/api\.asia-south-2\.saucelabs\.com/);
});

// ─── Session endpoints ───────────────────────────────────────────────────────

test('createSession sends POST /sessions with device os', async () => {
  const { rest, calls } = client({ '/sessions': { status: 200, body: { id: 's1', state: 'CREATING' } } });
  await rest.createSession({ device: { os: 'ANDROID' } });

  expect(calls[0].method).toBe('POST');
  expect(calls[0].url).toBe(`${BASE}/sessions`);
  expect((calls[0].body as Record<string, unknown>)['device']).toMatchObject({ os: 'ANDROID' });
});

test('createSession includes sessionDuration when provided', async () => {
  const { rest, calls } = client({ '/sessions': { status: 200, body: { id: 's1', state: 'CREATING' } } });
  await rest.createSession({
    device: { os: 'IOS' },
    configuration: { sessionDuration: 'PT1H' },
  });

  const body = calls[0].body as Record<string, unknown>;
  expect((body['configuration'] as Record<string, unknown>)['sessionDuration']).toBe('PT1H');
});

test('getSession sends GET /sessions/{id}', async () => {
  const { rest, calls } = client({ '/sessions/abc': { status: 200, body: { id: 'abc', state: 'ACTIVE' } } });
  const session = await rest.getSession('abc');

  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe(`${BASE}/sessions/abc`);
  expect(session.state).toBe('ACTIVE');
});

test('deleteSession sends DELETE /sessions/{id}', async () => {
  const { rest, calls } = client({ '/sessions/abc': { status: 200, body: {} } });
  await rest.deleteSession('abc');

  expect(calls[0].method).toBe('DELETE');
  expect(calls[0].url).toBe(`${BASE}/sessions/abc`);
});

test('deleteSession does not throw on 404', async () => {
  const { rest } = client({ '/sessions/abc': { status: 404, body: null } });
  await expect(rest.deleteSession('abc')).resolves.toBeUndefined();
});

// ─── Device endpoints ────────────────────────────────────────────────────────

test('listDevices sends GET /devices', async () => {
  const { rest, calls } = client({ '/devices': { status: 200, body: [] } });
  await rest.listDevices();

  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe(`${BASE}/devices`);
});

test('listDeviceStatus sends GET /devices/status', async () => {
  const { rest, calls } = client({ '/devices/status': { status: 200, body: { devices: [] } } });
  await rest.listDeviceStatus();

  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe(`${BASE}/devices/status`);
});

// ─── Device interaction endpoints ────────────────────────────────────────────

test('executeShellCommand sends adbShellCommand in body and returns stdout', async () => {
  const { rest, calls } = client({
    'executeShellCommand': { status: 200, body: { stdout: 'package:com.example.app\n' } },
  });
  const result = await rest.executeShellCommand('sess1', 'pm list packages -3');

  expect(calls[0].method).toBe('POST');
  expect(calls[0].url).toContain('/sessions/sess1/device/executeShellCommand');
  expect((calls[0].body as Record<string, unknown>)['adbShellCommand']).toBe('pm list packages -3');
  expect(result).toBe('package:com.example.app\n');
});

test('applySettings sends orientation in body', async () => {
  const { rest, calls } = client({ 'applySettings': { status: 200, body: {} } });
  await rest.applySettings('sess1', { orientation: 'LANDSCAPE' });

  expect(calls[0].method).toBe('POST');
  expect(calls[0].url).toContain('/sessions/sess1/device/applySettings');
  expect((calls[0].body as Record<string, unknown>)['orientation']).toBe('LANDSCAPE');
});

test('applySettings sends animations in body', async () => {
  const { rest, calls } = client({ 'applySettings': { status: 200, body: {} } });
  await rest.applySettings('sess1', { animations: false });

  expect((calls[0].body as Record<string, unknown>)['animations']).toBe(false);
});

test('launchApp sends bundleId for iOS', async () => {
  const { rest, calls } = client({ 'launchApp': { status: 200, body: {} } });
  await rest.launchApp('sess1', { bundleId: 'com.example.App' });

  expect(calls[0].url).toContain('/sessions/sess1/device/launchApp');
  expect((calls[0].body as Record<string, unknown>)['bundleId']).toBe('com.example.App');
});

test('launchApp sends packageName and activityName for Android', async () => {
  const { rest, calls } = client({ 'launchApp': { status: 200, body: {} } });
  await rest.launchApp('sess1', { packageName: 'com.example.app', activityName: '.MainActivity' });

  const body = calls[0].body as Record<string, unknown>;
  expect(body['packageName']).toBe('com.example.app');
  expect(body['activityName']).toBe('.MainActivity');
});

test('installApp sends storage ref and enableInstrumentation', async () => {
  const { rest, calls } = client({ 'installApp': { status: 200, body: { status: 'OK' } } });
  await rest.installApp('sess1', 'storage:uuid-123');

  const body = calls[0].body as Record<string, unknown>;
  expect(body['app']).toBe('storage:uuid-123');
  expect(body['enableInstrumentation']).toBe(true);
});

test('uninstallApp sends bundleId', async () => {
  const { rest, calls } = client({ 'uninstallApp': { status: 200, body: {} } });
  await rest.uninstallApp('sess1', { bundleId: 'com.example.App' });

  expect((calls[0].body as Record<string, unknown>)['bundleId']).toBe('com.example.App');
});

test('uninstallApp sends packageName for Android', async () => {
  const { rest, calls } = client({ 'uninstallApp': { status: 200, body: {} } });
  await rest.uninstallApp('sess1', { packageName: 'com.example.app' });

  expect((calls[0].body as Record<string, unknown>)['packageName']).toBe('com.example.app');
});

test('openUrl sends url in body', async () => {
  const { rest, calls } = client({ 'openUrl': { status: 200, body: {} } });
  await rest.openUrl('sess1', 'https://example.com');

  expect((calls[0].body as Record<string, unknown>)['url']).toBe('https://example.com');
});

test('takeScreenshot returns Buffer from binary response', async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const { rest } = client({ 'takeScreenshot': { status: 200, body: pngBytes } });
  const result = await rest.takeScreenshot('sess1');

  expect(result).toBeInstanceOf(Buffer);
  expect(result[0]).toBe(137);
});

// ─── Storage upload ───────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), 'mw-saucelabs-rest-test-'));

test.afterAll(() => {
  rmSync(tmpDir, { recursive: true });
});

test('uploadToStorage sends FormData to storage URL and returns storage:uuid', async () => {
  const filePath = join(tmpDir, 'app.apk');
  writeFileSync(filePath, 'fake apk content');

  const { mockFetch, calls } = makeMockFetch({
    '': { status: 200, body: { item: { id: 'uuid-abc-123' } } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  const ref = await rest.uploadToStorage(filePath);

  expect(ref).toBe('storage:uuid-abc-123');
  const upload = calls.find((c) => c.url === STORAGE_BASE);
  expect(upload?.method).toBe('POST');
  expect(upload?.body).toBeInstanceOf(FormData);
});

test('uploadToStorage reuses a file already in storage with the same SHA-256, without uploading', async () => {
  const filePath = join(tmpDir, 'same.apk');
  writeFileSync(filePath, 'same apk content');
  const sha = createHash('sha256').update('same apk content').digest('hex');

  const { mockFetch, calls } = makeMockFetch({
    'storage/files?sha256=': { status: 200, body: { items: [{ id: 'existing-id', sha256: sha }] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);

  expect(await rest.uploadToStorage(filePath)).toBe('storage:existing-id');
  expect(calls[0].url).toContain(`sha256=${sha}`);
  expect(calls.some((c) => c.url === STORAGE_BASE)).toBe(false);
});

test('uploadToStorage uploads when the lookup finds no file with that SHA-256', async () => {
  const filePath = join(tmpDir, 'new.apk');
  writeFileSync(filePath, 'new apk content');

  const { mockFetch, calls } = makeMockFetch({
    'storage/files?sha256=': { status: 200, body: { items: [] } },
    'storage/upload': { status: 200, body: { item: { id: 'new-id' } } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);

  expect(await rest.uploadToStorage(filePath)).toBe('storage:new-id');
  expect(calls.some((c) => c.url === STORAGE_BASE)).toBe(true);
});

test('uploadToStorage throws when response is missing item.id', async () => {
  const filePath = join(tmpDir, 'bad.apk');
  writeFileSync(filePath, 'content');

  const { mockFetch } = makeMockFetch({ '': { status: 200, body: {} } });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  await expect(rest.uploadToStorage(filePath)).rejects.toThrow('missing item.id');
});

// ─── WDA launch ──────────────────────────────────────────────────────────────

test('launchWebDriverAgent sends bundleId and no app when only bundleId is given', async () => {
  const { rest, calls } = client({ 'launchWebDriverAgent': { status: 200, body: {} } });
  await rest.launchWebDriverAgent('sess1', { bundleId: 'com.example.WDA' });

  expect(calls[0].method).toBe('POST');
  expect(calls[0].url).toContain('/sessions/sess1/device/launchWebDriverAgent');
  const body = calls[0].body as Record<string, unknown>;
  expect(body['bundleId']).toBe('com.example.WDA');
  expect(body['app']).toBeUndefined();
});

test('launchWebDriverAgent includes app when a storage ref is given', async () => {
  const { rest, calls } = client({ 'launchWebDriverAgent': { status: 200, body: {} } });
  await rest.launchWebDriverAgent('sess1', {
    bundleId: 'com.example.WDA',
    app: 'storage:wda-uuid-456',
  });

  const body = calls[0].body as Record<string, unknown>;
  expect(body['bundleId']).toBe('com.example.WDA');
  expect(body['app']).toBe('storage:wda-uuid-456');
});

test('launchWebDriverAgent uses DEFAULT_WDA_BUNDLE_ID when none is provided', async () => {
  const { rest, calls } = client({ 'launchWebDriverAgent': { status: 200, body: {} } });
  await rest.launchWebDriverAgent('sess1');

  const body = calls[0].body as Record<string, unknown>;
  expect(body['bundleId']).toBe('com.facebook.WebDriverAgentRunner.xctrunner');
});

test('launchWebDriverAgent uses xctrunner bundleId when app is provided without explicit bundleId', async () => {
  const { rest, calls } = client({ 'launchWebDriverAgent': { status: 200, body: {} } });
  await rest.launchWebDriverAgent('sess1', { app: 'storage:wda-uuid-xyz' });

  const body = calls[0].body as Record<string, unknown>;
  expect(body['bundleId']).toBe('com.facebook.WebDriverAgentRunner.xctrunner');
  expect(body['app']).toBe('storage:wda-uuid-xyz');
});

test('storageAppIdentifier reads the bundle id Sauce Storage recorded for a storage:<id> ref', async () => {
  const { mockFetch, calls } = makeMockFetch({
    'storage/files?file_id=': { status: 200, body: { items: [{ id: 'abc', metadata: { identifier: 'com.example.App' } }] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);

  expect(await rest.storageAppIdentifier('storage:abc')).toBe('com.example.App');
  expect(calls[0].url).toContain('file_id=abc');
});

test('storageAppIdentifier takes the newest file with that exact name for a storage:filename= ref', async () => {
  const { mockFetch, calls } = makeMockFetch({
    'storage/files?q=': { status: 200, body: { items: [
      { id: '1', name: 'my app.ipa.bak', metadata: { identifier: 'com.example.Bak' } },
      { id: '2', name: 'my app.ipa', metadata: { identifier: 'com.example.App' } },
      { id: '3', name: 'my app.ipa', metadata: { identifier: 'com.example.Older' } },
    ] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);

  expect(await rest.storageAppIdentifier('storage:filename=my app.ipa')).toBe('com.example.App');
  expect(calls[0].url).toContain('q=my%20app.ipa');
});

test('storageAppIdentifier returns undefined when the lookup fails', async () => {
  const { rest } = client({ 'storage/files': { status: 500, body: {} } });
  expect(await rest.storageAppIdentifier('storage:abc')).toBeUndefined();
});

// ─── ipaBundleId ──────────────────────────────────────────────────────────────

async function ipa(files: Record<string, string>): Promise<Uint8Array> {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return new Uint8Array(zip.toBuffer());
}

test('ipaBundleId downloads the IPA and reads CFBundleIdentifier from the app\'s Info.plist', async () => {
  const body = await ipa({
    'Payload/My App.app/Frameworks/Lib.framework/Info.plist': '<plist><dict><key>CFBundleIdentifier</key><string>com.example.Lib</string></dict></plist>',
    'Payload/My App.app/Info.plist': '<plist><dict><key>CFBundleIdentifier</key><string>com.example.App</string></dict></plist>',
  });
  const { mockFetch, calls } = makeMockFetch({ 'github.com': { status: 200, body } });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);

  expect(await rest.ipaBundleId('https://github.com/o/r/releases/download/1.0/App.ipa')).toBe('com.example.App');
  expect(calls.map((c) => c.url)).toEqual(['https://github.com/o/r/releases/download/1.0/App.ipa']);
});

test('ipaBundleId returns undefined for a file without an app Info.plist', async () => {
  const { mockFetch } = makeMockFetch({ 'github.com': { status: 200, body: await ipa({ 'classes.dex': 'x' }) } });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  expect(await rest.ipaBundleId('https://github.com/o/r/releases/download/1.0/app.apk')).toBeUndefined();
});

test('ipaBundleId throws when the download fails', async () => {
  const { mockFetch } = makeMockFetch({ 'github.com': { status: 404, body: 'Not Found' } });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  await expect(rest.ipaBundleId('https://github.com/o/r/releases/download/1.0/App.ipa')).rejects.toThrow('Failed to download');
});

// ─── findInStorage ────────────────────────────────────────────────────────────

test('findInStorage returns storage ref when file is found', async () => {
  const { mockFetch, calls } = makeMockFetch({
    '/storage/files': { status: 200, body: { items: [{ id: 'found-uuid', name: 'v15.0.0-WebDriverAgentRunner-Runner.ipa' }] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  const ref = await rest.findInStorage('v15.0.0-WebDriverAgentRunner-Runner.ipa');

  expect(ref).toBe('storage:found-uuid');
  expect(calls[0].url).toContain('/storage/files');
  expect(calls[0].url).toContain('v15.0.0-WebDriverAgentRunner-Runner.ipa');
});

test('findInStorage returns null when file is not found', async () => {
  const { mockFetch } = makeMockFetch({
    '/storage/files': { status: 200, body: { items: [] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  const ref = await rest.findInStorage('missing.ipa');

  expect(ref).toBeNull();
});

test('findInStorage returns null on non-2xx response', async () => {
  const { mockFetch } = makeMockFetch({
    '/storage/files': { status: 500, body: {} },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  const ref = await rest.findInStorage('something.ipa');

  expect(ref).toBeNull();
});

// ─── uploadWdaToStorage ───────────────────────────────────────────────────────

test('uploadWdaToStorage returns existing ref without downloading when file is in storage', async () => {
  const { mockFetch, calls } = makeMockFetch({
    '/storage/files': { status: 200, body: { items: [{ id: 'existing-uuid', name: 'v15.0.0-WebDriverAgentRunner-Runner.ipa' }] } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  const ref = await rest.uploadWdaToStorage(
    'https://github.com/appium/WebDriverAgent/releases/download/v15.0.0/WebDriverAgentRunner-Runner.zip',
  );

  expect(ref).toBe('storage:filename=v15.0.0-WebDriverAgentRunner-Runner.ipa');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('/storage/files');
});

test('uploadWdaToStorage derives versioned IPA filename from URL', async () => {
  const fakeZip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const { mockFetch, calls } = makeMockFetch({
    '/storage/files': { status: 200, body: { items: [] } },
    'github.com': { status: 200, body: fakeZip },
    'storage/upload': { status: 200, body: { item: { id: 'new-uuid' } } },
  });
  const rest = new RestClient('u', 'k', 'us-west-1', mockFetch);
  await rest.uploadWdaToStorage(
    'https://github.com/appium/WebDriverAgent/releases/download/v15.0.0/WebDriverAgentRunner-Runner.zip',
  );

  const uploadCall = calls.find((c) => c.url.includes('storage/upload'));
  expect(uploadCall).toBeTruthy();
  const formData = uploadCall!.body as FormData;
  expect(formData).toBeInstanceOf(FormData);
});

// ─── WDA proxy ────────────────────────────────────────────────────────────────

test('wdaRequest builds correct proxy URL', async () => {
  const { rest, calls } = client({
    '/proxy/http': { status: 200, body: { value: 'ok' } },
  });
  await rest.wdaRequest('sess1', 'GET', 'localhost', 8100, '/source', undefined);

  expect(calls[0].url).toBe(`${BASE}/sessions/sess1/device/proxy/http/localhost/8100/source`);
  expect(calls[0].method).toBe('GET');
});

test('wdaRequest strips leading slash from wdaPath', async () => {
  const { rest, calls } = client({ '/proxy/http': { status: 200, body: {} } });
  await rest.wdaRequest('sess1', 'POST', '127.0.0.1', 8100, '/wda/pressButton', { name: 'home' });

  expect(calls[0].url).toContain('/proxy/http/127.0.0.1/8100/wda/pressButton');
});

// ─── Error handling ───────────────────────────────────────────────────────────

test('throws with status code on non-2xx GET response', async () => {
  const { rest } = client({ '/devices': { status: 401, body: { error: 'Unauthorized' } } });
  await expect(rest.listDevices()).rejects.toThrow('401');
});

test('throws with status code on non-2xx POST response', async () => {
  const { rest } = client({ '/sessions': { status: 422, body: { error: 'Bad request' } } });
  await expect(rest.createSession({ device: { os: 'IOS' } })).rejects.toThrow('422');
});

test('throws with status code on non-2xx DELETE response', async () => {
  const { rest } = client({ '/sessions/x': { status: 500, body: {} } });
  await expect(rest.deleteSession('x')).rejects.toThrow('500');
});

// ─── SauceApiError ────────────────────────────────────────────────────────────

test('createSession throws SauceApiError carrying the status and the problem+json body', async () => {
  const body = {
    type: 'about:blank',
    title: 'Access API Concurrency Limit Reached',
    detail: 'Your organization already has 5 public devices allocated to Access API sessions.',
  };
  const { rest } = client({ '/sessions': { status: 409, body } });

  const err = await rest.createSession({ device: { os: 'ANDROID' } }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(SauceApiError);
  const apiErr = err as SauceApiError;
  expect(apiErr.status).toBe(409);
  expect(apiErr.title).toBe(body.title);
  expect(apiErr.detail).toBe(body.detail);
  expect(apiErr.body).toEqual(body);
  // The message format is unchanged, so callers matching on it keep working.
  expect(apiErr.message).toMatch(/^POST \/sessions failed: 409 /);
});

test('SauceApiError leaves body undefined when the error response is not JSON', async () => {
  const { rest } = client({ '/sessions': { status: 502, body: 'Bad Gateway' } });

  const err = await rest.createSession({ device: { os: 'IOS' } }).catch((e: unknown) => e) as SauceApiError;

  expect(err.status).toBe(502);
  expect(err.body).toBeUndefined();
  expect(err.title).toBeUndefined();
});

// ─── Error messages ───────────────────────────────────────────────────────────

test('error messages use the problem+json title and detail instead of the raw body', async () => {
  const { rest } = client({ '/sessions': { status: 409, body: { type: 'about:blank', title: 'Free Tier Concurrency Limit Reached', detail: 'one public device' } } });
  const err = await rest.createSession({ device: { os: 'ANDROID' } }).catch((e: unknown) => e) as SauceApiError;

  expect(err.message).toBe('POST /sessions failed: 409 Free Tier Concurrency Limit Reached: one public device');
});

test('falls back to the raw body when the error is not problem+json', async () => {
  const { rest } = client({ '/sessions': { status: 502, body: 'Bad Gateway' } });
  const err = await rest.createSession({ device: { os: 'IOS' } }).catch((e: unknown) => e) as SauceApiError;

  expect(err.message).toBe('POST /sessions failed: 502 "Bad Gateway"');
});

// ─── Gateway errors ───────────────────────────────────────────────────────────

/** Runs `run` with setTimeout firing at once, so retry delays don't slow the test. */
async function withoutDelays<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void) => original(fn, 0);
  try {
    return await run();
  } finally {
    globalThis.setTimeout = original;
  }
}

/** A fetch that answers `statuses` in turn (then 200 with `body`), counting calls. */
function fetchAnswering(statuses: number[], body: unknown = { id: 'sess-1', state: 'ACTIVE' }) {
  let calls = 0;
  const fetchFn = (async () => {
    const status = statuses[calls++] ?? 200;
    return new Response(JSON.stringify(status === 200 ? body : { message: 'gateway timeout' }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls: () => calls };
}

test('a 503 from the Sauce Labs gateway is retried, and the request then succeeds', async () => {
  const { fetchFn, calls } = fetchAnswering([503, 502]);
  const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
  expect(await withoutDelays(() => rest.getSession('sess-1'))).toMatchObject({ id: 'sess-1' });
  expect(calls()).toBe(3);
});

test('gateway errors are retried twice, then reported', async () => {
  const { fetchFn, calls } = fetchAnswering([503, 503, 503, 503]);
  const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
  await expect(withoutDelays(() => rest.getSession('sess-1'))).rejects.toThrow('503');
  expect(calls()).toBe(3);
});

test('a 504 is retried for a GET, but not for a POST: the request got through and may still be running', async () => {
  const get = fetchAnswering([504]);
  expect(await withoutDelays(() => new RestClient('u', 'k', 'us-west-1', get.fetchFn).getSession('sess-1'))).toMatchObject({ id: 'sess-1' });
  expect(get.calls()).toBe(2);

  const post = fetchAnswering([504]);
  await expect(withoutDelays(() => new RestClient('u', 'k', 'us-west-1', post.fetchFn).createSession({ device: { os: 'IOS' } }))).rejects.toThrow('504');
  expect(post.calls()).toBe(1);
});

test('other errors are not retried', async () => {
  const { fetchFn, calls } = fetchAnswering([500]);
  const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
  await expect(withoutDelays(() => rest.getSession('sess-1'))).rejects.toThrow('500');
  expect(calls()).toBe(1);
});

// ─── Network errors, credentials, downloads ──────────────────────────────────

test('a DELETE is retried after a network error; a POST is not, since repeating it could open a second session', async () => {
  const calls: Array<[(r: RestClient) => Promise<unknown>, number]> = [
    [(r) => r.deleteSession('s1'), 2],
    [(r) => r.createSession({ device: { os: 'IOS' } }), 1],
  ];
  for (const [call, expectedAttempts] of calls) {
    let attempts = 0;
    const fetchFn = (async () => {
      if (attempts++ === 0) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
    await withoutDelays(() => call(rest)).catch(() => {});
    expect(attempts).toBe(expectedAttempts);
  }
});

test('a request that never connected is retried whatever its method, up to 4 times', async () => {
  const connectTimeout = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  for (const failures of [3, 10]) {
    let attempts = 0;
    const fetchFn = (async () => {
      if (attempts++ < failures) throw connectTimeout();
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
    const result = withoutDelays(() => rest.wdaRequest('s1', 'POST', 'localhost', 8100, '/wda/keys', { value: ['a'] }));
    if (failures === 3) await expect(result).resolves.toEqual({});
    else await expect(result).rejects.toThrow('fetch failed');
    expect(attempts).toBe(failures === 3 ? 4 : 5);
  }
});

test('connection errors are told apart from errors after the request was sent', async () => {
  const { isConnectError } = await import('./rest-client.js');
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  expect(isConnectError(new TypeError('fetch failed', { cause: code('ECONNREFUSED') }))).toBe(true);
  expect(isConnectError(new TypeError('fetch failed', { cause: new AggregateError([code('ECONNREFUSED'), code('EHOSTUNREACH')]) }))).toBe(true);
  expect(isConnectError(new TypeError('fetch failed', { cause: code('ECONNRESET') }))).toBe(false);
  expect(isConnectError(new TypeError('fetch failed', { cause: code('UND_ERR_SOCKET') }))).toBe(false);
  expect(isConnectError(new TypeError('fetch failed'))).toBe(false);
});

test('hosted Appium requests carry credentials only to https://*.saucelabs.com', async () => {
  const sent: string[] = [];
  const fetchFn = (async (url: string) => {
    sent.push(url);
    return new Response('{"value":null}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);

  await rest.appiumRequest('https://api.us-west-1.saucelabs.com/rdc/v2/sessions/s1/appium/wd/hub', 'GET', '/status');
  for (const url of ['https://evil.example/wd/hub', 'http://api.us-west-1.saucelabs.com/wd/hub', 'https://saucelabs.com.evil.example/wd/hub']) {
    await expect(rest.appiumRequest(url, 'GET', '/status')).rejects.toThrow('Refusing to send Sauce Labs credentials');
  }
  expect(sent).toHaveLength(1);
});

test('a download larger than the limit fails instead of filling memory', async () => {
  const fetchFn = (async () => new Response('x', { status: 200, headers: { 'content-length': String(3 * 1024 ** 3) } })) as unknown as typeof globalThis.fetch;
  const rest = new RestClient('u', 'k', 'us-west-1', fetchFn);
  await expect(rest.ipaBundleId('https://example.com/App.ipa')).rejects.toThrow('download limit');
});
