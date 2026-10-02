import { expect, test } from '@playwright/test';
import type { AppInfo, ViewNode } from '@mobilewright/protocol';
import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { SauceConnect } from './sauce-connect.js';
import { SauceLabsDriver, SessionTerminatedError, androidPackage, backoffDelay, connectRetryingGatewayErrors, cleanUpOnSignal, openSessions, parseAndroidDisplaySize, parseAndroidRotation, toSauceDeviceNameQuery, waitForActiveSession, type SauceLabsDriverOptions } from './driver.js';
import { SauceApiError } from './rest-client.js';
import type { TouchPoint } from './device-control-socket.js';

// ─── Fake helpers ────────────────────────────────────────────────────────────

interface TouchCall {
  action: 'd' | 'm' | 'u';
  points: TouchPoint[];
  cw: number;
  ch: number;
  orientation: 0 | 1;
}

function createFakeIoSocket() {
  const touchCalls: TouchCall[] = [];
  const keyCalls: string[] = [];

  return {
    touchCalls,
    keyCalls,
    sendTouch(action: 'd' | 'm' | 'u', points: TouchPoint[], cw: number, ch: number, orientation: 0 | 1) {
      touchCalls.push({ action, points, cw, ch, orientation });
    },
    sendKey(key: string) { keyCalls.push(key); },
    connect: async () => {},
    disconnect: async () => {},
  };
}

interface RestCall { method: string; args: unknown[] }

function createFakeRest(responses: Record<string, unknown> = {}) {
  const calls: RestCall[] = [];
  const rest = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_, method: string) {
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        const val = responses[method];
        if (typeof val === 'function') return val(...args);
        if (val instanceof Error) throw val;
        return val;
      };
    },
  });
  return { rest, calls };
}

interface WdaCall { method: string; args: unknown[] }

function createFakeWda(responses: Record<string, unknown> = {}) {
  const calls: WdaCall[] = [];
  return {
    calls,
    close: async () => {
    },
    getSource: async (): Promise<ViewNode[]> => {
      calls.push({ method: 'getSource', args: [] });
      return (responses['getSource'] as ViewNode[]) ?? [];
    },
    getActiveAppInfo: async (): Promise<AppInfo> => {
      calls.push({ method: 'getActiveAppInfo', args: [] });
      return (responses['getActiveAppInfo'] as AppInfo) ?? { bundleId: '' };
    },
    listApps: async (): Promise<AppInfo[]> => {
      calls.push({ method: 'listApps', args: [] });
      return (responses['listApps'] as AppInfo[]) ?? [];
    },
    terminateApp: async (bundleId: string) => {
      calls.push({ method: 'terminateApp', args: [bundleId] });
    },
    dismissAlert: async () => {
      calls.push({ method: 'dismissAlert', args: [] });
      return (responses['dismissAlert'] as boolean | undefined) ?? false;
    },
    pressButton: async (name: string) => {
      calls.push({ method: 'pressButton', args: [name] });
    },
    clearActiveElement: async () => {
      calls.push({ method: 'clearActiveElement', args: [] });
      return responses['clearActiveElement'];
    },
    typeKeys: async (text: string) => {
      calls.push({ method: 'typeKeys', args: [text] });
    },
    getOrientation: async () => {
      calls.push({ method: 'getOrientation', args: [] });
      const value = responses['getOrientation'];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

type Platform = 'ios' | 'android';

interface SessionOptions {
  platform?: Platform;
  resolutionWidth?: number;
  resolutionHeight?: number;
  pixelsPerPoint?: number;
  currentOrientation?: 'PORTRAIT' | 'LANDSCAPE';
  restResponses?: Record<string, unknown>;
  wdaResponses?: Record<string, unknown>;
  ownsSession?: boolean;
  driverOptions?: SauceLabsDriverOptions;
}

/** A SauceLabsDriver with a fake session injected: no WebSocket or HTTP server needed. */
function createDriverWithSession(opts: SessionOptions = {}) {
  const platform: Platform = opts.platform ?? 'ios';
  const driver = new SauceLabsDriver({ username: 'alice', accessKey: 'secret', ...opts.driverOptions });

  const ioSocket = createFakeIoSocket();
  const wda = platform === 'ios' ? createFakeWda(opts.wdaResponses ?? {}) : null;

  (driver as any).session = {
    sauceSessionId: 'sess-123',
    ownsSession: opts.ownsSession ?? true,
    platform,
    deviceId: 'iPhone_15_real',
    resolutionWidth: opts.resolutionWidth ?? 1170,
    resolutionHeight: opts.resolutionHeight ?? 2532,
    pixelsPerPoint: opts.pixelsPerPoint ?? 3,
    currentOrientation: opts.currentOrientation ?? 'PORTRAIT',
    ioSocket,
    companionSocket: { onOrientationFinish: () => {}, disconnect: async () => {} },
    wdaClient: wda,
    textInput: { cleared: false, typed: '' },
    launcherActivities: new Map(),
  };

  const { rest, calls: restCalls } = createFakeRest(opts.restResponses ?? {});
  (driver as any).makeRest = () => rest;

  return { driver, ioSocket, wda, restCalls };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

/** The Authorization header the driver sends with its first API request. */
async function authorizationSent(driver: SauceLabsDriver): Promise<string | undefined> {
  const original = globalThis.fetch;
  let auth: string | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    auth ??= (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    await driver.listDevices().catch(() => {});
  } finally {
    globalThis.fetch = original;
  }
  return auth;
}

test.describe('SauceLabsDriver constructor', () => {
  test('reads credentials from SAUCE_USERNAME and SAUCE_ACCESS_KEY env vars', () => {
    const orig = { u: process.env['SAUCE_USERNAME'], k: process.env['SAUCE_ACCESS_KEY'] };
    process.env['SAUCE_USERNAME'] = 'env-user';
    process.env['SAUCE_ACCESS_KEY'] = 'env-key';
    try {
      expect(() => new SauceLabsDriver()).not.toThrow();
    } finally {
      if (orig.u === undefined) delete process.env['SAUCE_USERNAME']; else process.env['SAUCE_USERNAME'] = orig.u;
      if (orig.k === undefined) delete process.env['SAUCE_ACCESS_KEY']; else process.env['SAUCE_ACCESS_KEY'] = orig.k;
    }
  });

  test('explicit options take precedence over env vars', async () => {
    const orig = { u: process.env['SAUCE_USERNAME'], k: process.env['SAUCE_ACCESS_KEY'] };
    process.env['SAUCE_USERNAME'] = 'env-user';
    process.env['SAUCE_ACCESS_KEY'] = 'env-key';
    try {
      const driver = new SauceLabsDriver({ username: 'opt-user', accessKey: 'opt-key' });
      const auth = await authorizationSent(driver);
      expect(auth).toBe(`Basic ${Buffer.from('opt-user:opt-key').toString('base64')}`);
    } finally {
      if (orig.u === undefined) delete process.env['SAUCE_USERNAME']; else process.env['SAUCE_USERNAME'] = orig.u;
      if (orig.k === undefined) delete process.env['SAUCE_ACCESS_KEY']; else process.env['SAUCE_ACCESS_KEY'] = orig.k;
    }
  });

  test('the access key never shows up when the driver is printed or serialized', async () => {
    const { inspect } = await import('node:util');
    const driver = new SauceLabsDriver({ username: 'opt-user', accessKey: 'secret-key-123' });
    const encoded = Buffer.from('opt-user:secret-key-123').toString('base64');
    for (const shown of [inspect(driver, { depth: 10, showHidden: true }), JSON.stringify(driver)]) {
      expect(shown).not.toContain('secret-key-123');
      expect(shown).not.toContain(encoded);
    }
  });

  test('throws with helpful message when username is missing', () => {
    const orig = process.env['SAUCE_USERNAME'];
    delete process.env['SAUCE_USERNAME'];
    try {
      expect(() => new SauceLabsDriver({ accessKey: 'k' })).toThrow('SAUCE_USERNAME');
    } finally {
      if (orig !== undefined) process.env['SAUCE_USERNAME'] = orig;
    }
  });

  test('throws with helpful message when accessKey is missing', () => {
    const orig = process.env['SAUCE_ACCESS_KEY'];
    delete process.env['SAUCE_ACCESS_KEY'];
    try {
      expect(() => new SauceLabsDriver({ username: 'u' })).toThrow('SAUCE_ACCESS_KEY');
    } finally {
      if (orig !== undefined) process.env['SAUCE_ACCESS_KEY'] = orig;
    }
  });
});

// ─── Session guard ────────────────────────────────────────────────────────────

test('screenshot() throws "No active session" when connect() was never called', async () => {
  const driver = new SauceLabsDriver({ username: 'u', accessKey: 'k' });
  await expect(driver.screenshot()).rejects.toThrow('No active session');
});

// ─── Screen ───────────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.getScreenSize()', () => {
  test('divides resolution by pixelsPerPoint (scale)', async () => {
    const { driver } = createDriverWithSession({ resolutionWidth: 1170, resolutionHeight: 2532, pixelsPerPoint: 3 });
    const size = await driver.getScreenSize();
    expect(size).toEqual({ width: 390, height: 844, scale: 3 });
  });

  test('swaps width and height in landscape orientation', async () => {
    const { driver } = createDriverWithSession({
      resolutionWidth: 1170,
      resolutionHeight: 2532,
      pixelsPerPoint: 3,
      currentOrientation: 'LANDSCAPE',
    });
    const size = await driver.getScreenSize();
    expect(size).toEqual({ width: 844, height: 390, scale: 3 });
  });

  test('uses scale 1 when pixelsPerPoint is 0', async () => {
    const { driver } = createDriverWithSession({ resolutionWidth: 1080, resolutionHeight: 1920, pixelsPerPoint: 0 });
    const size = await driver.getScreenSize();
    expect(size.scale).toBe(1);
    expect(size.width).toBe(1080);
  });
});

test.describe('SauceLabsDriver.getOrientation()', () => {
  test('returns portrait when session orientation is PORTRAIT', async () => {
    const { driver } = createDriverWithSession({ currentOrientation: 'PORTRAIT' });
    expect(await driver.getOrientation()).toBe('portrait');
  });

  test('returns landscape when session orientation is LANDSCAPE', async () => {
    const { driver } = createDriverWithSession({ currentOrientation: 'LANDSCAPE' });
    expect(await driver.getOrientation()).toBe('landscape');
  });
});

test.describe('SauceLabsDriver.setOrientation()', () => {
  test('calls applySettings with LANDSCAPE for landscape', async () => {
    const { driver, restCalls } = createDriverWithSession();
    await driver.setOrientation('landscape');

    const call = restCalls.find((c) => c.method === 'applySettings');
    expect(call?.args[1]).toMatchObject({ orientation: 'LANDSCAPE' });
  });

  test('calls applySettings with PORTRAIT for portrait', async () => {
    const { driver, restCalls } = createDriverWithSession({ currentOrientation: 'LANDSCAPE' });
    await driver.setOrientation('portrait');

    const call = restCalls.find((c) => c.method === 'applySettings');
    expect(call?.args[1]).toMatchObject({ orientation: 'PORTRAIT' });
  });
});

test.describe('device orientation is read from the device (the companion socket sends no orientation events)', () => {
  /** executeShellCommand fake answering `dumpsys window displays` with successive rotations. */
  function rotations(...values: string[]) {
    let i = 0;
    return async (_s: unknown, cmd: unknown) =>
      (String(cmd).startsWith('dumpsys window') ? `  mCurrentRotation=${values[Math.min(i++, values.length - 1)]}\n` : '');
  }

  test('Android getOrientation() reads the display rotation and updates the stored orientation', async () => {
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: rotations('ROTATION_90') } });
    expect(await driver.getOrientation()).toBe('landscape');
    expect((driver as any).session.currentOrientation).toBe('LANDSCAPE');
  });

  test('iOS getOrientation() asks WDA', async () => {
    const { driver } = createDriverWithSession({ platform: 'ios', wdaResponses: { getOrientation: 'LANDSCAPE' } });
    expect(await driver.getOrientation()).toBe('landscape');
  });

  test('falls back to the stored orientation when the device can\'t be read', async () => {
    const { driver } = createDriverWithSession({ platform: 'ios', currentOrientation: 'LANDSCAPE', wdaResponses: { getOrientation: new Error('WDA down') } });
    expect(await driver.getOrientation()).toBe('landscape');
  });

  test('setOrientation() waits for the device to rotate and records it', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: rotations('ROTATION_0', 'ROTATION_0', 'ROTATION_270') },
    });
    await withoutRealSleeps(() => driver.setOrientation('landscape'));

    expect(restCalls.find((c) => c.method === 'applySettings')?.args[1]).toEqual({ orientation: 'LANDSCAPE' });
    expect((driver as any).session.currentOrientation).toBe('LANDSCAPE');
  });

  test('setOrientation() records the real orientation when the app does not rotate', async () => {
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: rotations('ROTATION_0') } });
    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => (fakeNow += 2_000);
    try {
      await withoutRealSleeps(() => driver.setOrientation('landscape'));
    } finally {
      Date.now = realNow;
    }
    expect((driver as any).session.currentOrientation).toBe('PORTRAIT');
  });

  test('parseAndroidRotation() understands both dumpsys formats', () => {
    expect(parseAndroidRotation('mCurrentRotation=ROTATION_0')).toBe('PORTRAIT');
    expect(parseAndroidRotation('mCurrentRotation=ROTATION_180')).toBe('PORTRAIT');
    expect(parseAndroidRotation('mCurrentRotation=ROTATION_90')).toBe('LANDSCAPE');
    expect(parseAndroidRotation('mRotation=3')).toBe('LANDSCAPE');
    expect(parseAndroidRotation('nothing here')).toBeUndefined();
  });
});

test.describe('SauceLabsDriver.screenshot()', () => {
  test('returns the Buffer from takeScreenshot', async () => {
    const buf = Buffer.from([137, 80, 78, 71]);
    const { driver } = createDriverWithSession({ restResponses: { takeScreenshot: buf } });
    const result = await driver.screenshot();
    expect(result).toBe(buf);
  });
});

// ─── Input ───────────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.tap()', () => {
  test('sends touch down then touch up at same coordinates', async () => {
    const { driver, ioSocket } = createDriverWithSession({ platform: 'android' });
    await driver.tap(540, 960);

    expect(ioSocket.touchCalls).toHaveLength(2);
    expect(ioSocket.touchCalls[0].action).toBe('d');
    expect(ioSocket.touchCalls[1].action).toBe('u');
    expect(ioSocket.touchCalls[0].points[0]).toMatchObject({ x: 540, y: 960, index: 0 });
    expect(ioSocket.touchCalls[1].points[0]).toMatchObject({ x: 540, y: 960, index: 0 });
  });

  test('holds the touch before lifting it, like a finger (an instant tap does not flip an iOS switch)', async () => {
    const { driver, ioSocket } = createDriverWithSession({ platform: 'ios' });
    const started = Date.now();
    const tapping = driver.tap(100, 200);
    expect(ioSocket.touchCalls.map((c) => c.action)).toEqual(['d']);

    await tapping;
    expect(ioSocket.touchCalls.map((c) => c.action)).toEqual(['d', 'u']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  test('uses portrait canvas dimensions in portrait orientation', async () => {
    const { driver, ioSocket } = createDriverWithSession({
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      pixelsPerPoint: 1,
      currentOrientation: 'PORTRAIT',
    });
    await driver.tap(0, 0);

    expect(ioSocket.touchCalls[0].cw).toBe(1080);
    expect(ioSocket.touchCalls[0].ch).toBe(1920);
    expect(ioSocket.touchCalls[0].orientation).toBe(0);
  });

  test('swaps canvas dimensions and sets orientation flag in landscape', async () => {
    const { driver, ioSocket } = createDriverWithSession({
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      pixelsPerPoint: 1,
      currentOrientation: 'LANDSCAPE',
    });
    await driver.tap(0, 0);

    expect(ioSocket.touchCalls[0].cw).toBe(1920);
    expect(ioSocket.touchCalls[0].ch).toBe(1080);
    expect(ioSocket.touchCalls[0].orientation).toBe(1);
  });

  test('on iOS, scales pixel resolution down to points by pixelsPerPoint (WDA bounds are point-space)', async () => {
    const { driver, ioSocket } = createDriverWithSession({
      platform: 'ios',
      resolutionWidth: 1170,
      resolutionHeight: 2532,
      pixelsPerPoint: 3,
      currentOrientation: 'PORTRAIT',
    });
    await driver.tap(195, 768);

    expect(ioSocket.touchCalls[0].cw).toBe(390);
    expect(ioSocket.touchCalls[0].ch).toBe(844);
    // x/y themselves are passed through unchanged — they already come in as points.
    expect(ioSocket.touchCalls[0].points[0]).toMatchObject({ x: 195, y: 768 });
  });

  test('on Android, does not scale canvas dimensions even if pixelsPerPoint is not 1 (uiautomator bounds are already pixel-space)', async () => {
    const { driver, ioSocket } = createDriverWithSession({
      platform: 'android',
      resolutionWidth: 1080,
      resolutionHeight: 2400,
      pixelsPerPoint: 2.75,
      currentOrientation: 'PORTRAIT',
    });
    await driver.tap(540, 1200);

    expect(ioSocket.touchCalls[0].cw).toBe(1080);
    expect(ioSocket.touchCalls[0].ch).toBe(2400);
  });
});

test.describe('SauceLabsDriver.doubleTap()', () => {
  test('sends two complete tap sequences', async () => {
    const { driver, ioSocket } = createDriverWithSession();
    await driver.doubleTap(200, 300);

    const actions = ioSocket.touchCalls.map((c) => c.action);
    expect(actions).toEqual(['d', 'u', 'd', 'u']);
  });

  test('all touches are at the given coordinates', async () => {
    const { driver, ioSocket } = createDriverWithSession();
    await driver.doubleTap(200, 300);

    for (const call of ioSocket.touchCalls) {
      expect(call.points[0]).toMatchObject({ x: 200, y: 300 });
    }
  });
});

test.describe('SauceLabsDriver.longPress()', () => {
  test('sends touch down followed by touch up', async () => {
    const { driver, ioSocket } = createDriverWithSession();
    await driver.longPress(100, 200, 10); // short duration for test speed

    const actions = ioSocket.touchCalls.map((c) => c.action);
    expect(actions[0]).toBe('d');
    expect(actions[actions.length - 1]).toBe('u');
  });
});

test.describe('SauceLabsDriver.clearText()', () => {
  test('on iOS, clears the focused element through WDA and sends no socket keys', async () => {
    const { driver, ioSocket, wda } = createDriverWithSession({ platform: 'ios' });
    await driver.clearText();

    expect(wda!.calls.map((c) => c.method)).toEqual(['clearActiveElement']);
    expect(ioSocket.keyCalls).toEqual([]);
  });

  /** executeShellCommand fake reporting the given API level for getprop. */
  const sdk = (level: string) => async (_s: unknown, cmd: unknown) => (String(cmd).startsWith('getprop') ? `${level}\n` : '');

  test('on Android, moves to the end, selects all with CTRL+A and deletes, without reading the hierarchy', async () => {
    const { driver, ioSocket, restCalls } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: sdk('33') } });
    await driver.clearText();
    await driver.clearText();

    const commands = restCalls.filter((c) => c.method === 'executeShellCommand').map((c) => c.args[1]);
    expect(commands).toEqual([
      'getprop ro.build.version.sdk',
      'input keyevent 123', 'input keycombination 113 29', 'input keyevent 67',
      'input keyevent 123', 'input keycombination 113 29', 'input keyevent 67',
    ]);
    expect(ioSocket.keyCalls).toEqual([]);
  });

  test('on Android 12 and older, fails clearly instead of silently clearing nothing', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: sdk('31') } });

    await expect(driver.clearText()).rejects.toThrow(/needs Android 13 or later.*API level 31.*osVersion: '>=13'/);
    expect(restCalls.some((c) => String(c.args[1]).startsWith('input keycombination'))).toBe(false);
  });
});

test.describe('SauceLabsDriver.getViewHierarchy() text field values on Android', () => {
  /** uiautomator dump with one EditText; `hint` is only dumped by Android 16+. */
  function dump(attrs: { text: string; hint?: string; focused?: boolean }): string {
    const hint = attrs.hint !== undefined ? ` hint="${attrs.hint}"` : '';
    return `<?xml version="1.0"?>
<hierarchy>
  <node class="android.widget.TextView" text="Title" bounds="[0,0][100,20]" enabled="true" />
  <node class="android.widget.EditText" text="${attrs.text}"${hint} focused="${attrs.focused ?? true}" bounds="[0,20][100,70]" enabled="true" />
</hierarchy>`;
  }
  const flatten = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);

  async function readField(driver: SauceLabsDriver) {
    return flatten(await driver.getViewHierarchy()).find((n) => n.type === 'android.widget.EditText')!;
  }

  function androidDriver(xml: () => string) {
    return createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: async (_s: unknown, cmd: unknown) => (String(cmd).startsWith('uiautomator') ? xml() : '') },
    });
  }

  test('copies an editable field\'s text to value, and leaves non-editable nodes alone', async () => {
    const { driver } = androidDriver(() => dump({ text: 'hello' }));
    const nodes = flatten(await driver.getViewHierarchy());

    expect(nodes.find((n) => n.type === 'android.widget.EditText')?.value).toBe('hello');
    expect(nodes.find((n) => n.type === 'android.widget.TextView')?.value).toBeUndefined();
  });

  test.describe('Android 16+ (hint attribute dumped)', () => {
    test('a field showing its hint is empty, and the hint becomes the placeholder', async () => {
      const { driver } = androidDriver(() => dump({ text: 'Search settings', hint: 'Search settings' }));
      const field = await readField(driver);

      expect(field.value).toBeUndefined();
      expect(field.placeholder).toBe('Search settings');
    });

    test('text the driver typed is reported even when it equals the hint', async () => {
      const { driver } = androidDriver(() => dump({ text: 'Search settings', hint: 'Search settings' }));
      await driver.tap(50, 45);
      await driver.typeText('Search settings');

      expect((await readField(driver)).value).toBe('Search settings');
    });

    test('text that differs from the hint is the value', async () => {
      const { driver } = androidDriver(() => dump({ text: 'hello', hint: 'Search settings' }));
      expect((await readField(driver)).value).toBe('hello');
    });
  });

  test.describe('Android 13-15 (no hint attribute)', () => {
    test('the focused field reads as empty after clearText(), even though uiautomator reports its hint', async () => {
      const { driver } = androidDriver(() => dump({ text: 'Search settings' }));
      await driver.tap(50, 45);
      await driver.clearText();

      expect((await readField(driver)).value).toBeUndefined();
    });

    test('typing after clearText() reports the typed text', async () => {
      let text = 'Search settings';
      const { driver } = androidDriver(() => dump({ text }));
      await driver.tap(50, 45);
      await driver.clearText();
      await driver.typeText('abc');
      text = 'abc';

      expect((await readField(driver)).value).toBe('abc');
    });

    test('a tap after clearText() stops treating the focused field as empty, since focus may have moved', async () => {
      const { driver } = androidDriver(() => dump({ text: 'existing' }));
      await driver.clearText();
      await driver.tap(50, 45);

      expect((await readField(driver)).value).toBe('existing');
    });

    test('clearText() only affects the focused field', async () => {
      const { driver } = androidDriver(() => dump({ text: 'other field', focused: false }));
      await driver.clearText();

      expect((await readField(driver)).value).toBe('other field');
    });

    test('known limitation: a field the driver never touched reports its hint as its value', async () => {
      const { driver } = androidDriver(() => dump({ text: 'Search settings' }));
      expect((await readField(driver)).value).toBe('Search settings');
    });
  });
});

test.describe('SauceLabsDriver.typeText()', () => {
  test('on iOS, types through WDA and sends no socket keys, including non-ASCII text', async () => {
    const { driver, ioSocket, wda } = createDriverWithSession({ platform: 'ios' });
    await driver.typeText('hi');
    await driver.typeText('こんにちは');

    expect(wda!.calls.filter((c) => c.method === 'typeKeys').map((c) => c.args[0])).toEqual(['hi', 'こんにちは']);
    expect(ioSocket.keyCalls).toEqual([]);
  });

  test('on Android, sends each ASCII character as a tt/ key event', async () => {
    const { driver, ioSocket } = createDriverWithSession({ platform: 'android' });
    await driver.typeText('hi');

    expect(ioSocket.keyCalls).toEqual(['h', 'i']);
  });

  test('on Android, sends a space as a literal space key, which the device types as a space', async () => {
    // "Space" typed the word "Space" on real devices ("to be removed" → "toSpacebeSpaceremoved").
    const { driver, ioSocket } = createDriverWithSession({ platform: 'android' });
    await driver.typeText('a b');

    expect(ioSocket.keyCalls).toEqual(['a', ' ', 'b']);
  });

  test('calls executeShellCommand for non-ASCII text on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.typeText('こんにちは');

    const shellCall = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(shellCall).toBeDefined();
    expect((shellCall!.args[1] as string)).toContain('input text');
  });

  test('does not call executeShellCommand for ASCII text on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.typeText('hello');

    const shellCall = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(shellCall).toBeUndefined();
  });
});

test.describe('SauceLabsDriver.pressKeys()', () => {
  test('sends each key as a tt/ event in order', async () => {
    const { driver, ioSocket } = createDriverWithSession();
    await driver.pressKeys(['Enter', 'Tab']);

    expect(ioSocket.keyCalls).toEqual(['Enter', 'Tab']);
  });
});

// ─── pressButton ─────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.pressButton()', () => {
  test('HOME on iOS goes through WDA, not the socket', async () => {
    const { driver, ioSocket, wda } = createDriverWithSession({ platform: 'ios' });
    await driver.pressButton('HOME');
    expect(wda!.calls.find((c) => c.method === 'pressButton')?.args[0]).toBe('home');
    expect(ioSocket.keyCalls).toEqual([]);
  });

  test('HOME, BACK and APP_SWITCH on Android are adb key events, not socket keys', async () => {
    const { driver, ioSocket, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.pressButton('HOME');
    await driver.pressButton('BACK');
    await driver.pressButton('APP_SWITCH');

    expect(restCalls.filter((c) => c.method === 'executeShellCommand').map((c) => c.args[1]))
      .toEqual(['input keyevent 3', 'input keyevent 4', 'input keyevent 187']);
    expect(ioSocket.keyCalls).toEqual([]);
  });

  test('APP_SWITCH on iOS falls back to the socket key', async () => {
    const { driver, ioSocket } = createDriverWithSession({ platform: 'ios' });
    await driver.pressButton('APP_SWITCH');
    expect(ioSocket.keyCalls).toEqual(['Sauce_Menu_Key']);
  });

  test('VOLUME_UP on Android calls executeShellCommand with keyevent 24', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.pressButton('VOLUME_UP');

    const call = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(call?.args[1]).toContain('keyevent 24');
  });

  test('POWER on Android calls executeShellCommand with keyevent 26', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.pressButton('POWER');

    const call = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(call?.args[1]).toContain('keyevent 26');
  });

  test('VOLUME_DOWN on Android calls executeShellCommand with keyevent 25', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.pressButton('VOLUME_DOWN');

    const call = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(call?.args[1]).toContain('keyevent 25');
  });

  test('VOLUME_UP on iOS goes directly to WDA pressButton', async () => {
    const { driver, wda } = createDriverWithSession({ platform: 'ios' });
    await driver.pressButton('VOLUME_UP');

    expect(wda!.calls.find((c) => c.method === 'pressButton')?.args[0]).toBe('volumeUp');
  });
});

// ─── Apps ────────────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.launchApp()', () => {
  test('sends bundleId for iOS', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'ios' });
    await driver.launchApp('com.example.App');

    const call = restCalls.find((c) => c.method === 'launchApp');
    expect(call?.args[1]).toMatchObject({ bundleId: 'com.example.App' });
    expect((call?.args[1] as Record<string, unknown>)['packageName']).toBeUndefined();
  });

  /** executeShellCommand fake answering resolve-activity and dumpsys with the given outputs. */
  function launcherShell(resolve: string | Error, dumpsys = '') {
    return async (_s: unknown, cmd: unknown) => {
      const command = String(cmd);
      if (command.startsWith('cmd package resolve-activity')) {
        if (resolve instanceof Error) throw resolve;
        return resolve;
      }
      if (command.startsWith('dumpsys package')) return dumpsys;
      return '';
    };
  }

  test('on Android, resolves the launcher activity and sends it with the package', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: launcherShell('priority=0 preferredOrder=0 isDefault=true\ncom.example.app/.MainActivity\n') },
    });
    await driver.launchApp('com.example.app');

    const call = restCalls.find((c) => c.method === 'launchApp');
    expect(call?.args[1]).toEqual({ packageName: 'com.example.app', activityName: 'com.example.app.MainActivity' });
  });

  test('on Android, falls back to dumpsys package when resolve-activity is unavailable', async () => {
    // Shape of `dumpsys package com.android.chrome` on a Galaxy A23 (Android 13).
    const dumpsys = [
      '      android.intent.action.MAIN:',
      '        d0159b com.android.chrome/com.google.android.apps.chrome.IntentDispatcher filter 109d38',
      '          Action: "android.intent.action.MAIN"',
      '          Category: "android.intent.category.NOTIFICATION_PREFERENCES"',
      '        b6233d6 com.android.chrome/com.google.android.apps.chrome.Main filter 21f7657',
      '          Action: "android.intent.action.MAIN"',
      '          Category: "android.intent.category.LAUNCHER"',
    ].join('\n');
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: launcherShell(new Error('Adb Command Not Allowed'), dumpsys) },
    });
    await driver.launchApp('com.android.chrome');

    expect(restCalls.find((c) => c.method === 'launchApp')?.args[1])
      .toEqual({ packageName: 'com.android.chrome', activityName: 'com.google.android.apps.chrome.Main' });
  });

  test('on Android, an explicit activity is used as given, without a lookup', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: launcherShell('') } });
    await driver.launchApp('com.example.app', { activity: '.MainActivity' });

    expect(restCalls.find((c) => c.method === 'launchApp')?.args[1]).toEqual({ packageName: 'com.example.app', activityName: '.MainActivity' });
    expect(restCalls.some((c) => c.method === 'executeShellCommand')).toBe(false);
  });

  test('on Android, the resolved activity is cached for the session', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: launcherShell('com.example.app/.MainActivity') },
    });
    await driver.launchApp('com.example.app');
    await driver.launchApp('com.example.app');

    expect(restCalls.filter((c) => c.method === 'executeShellCommand')).toHaveLength(1);
    expect(restCalls.filter((c) => c.method === 'launchApp')).toHaveLength(2);
  });

  test('on Android, launches the requested package even after another app was installed, without reinstalling', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: {
        executeShellCommand: launcherShell('com.android.settings/.Settings'),
        installApp: { installationId: 'inst-1', status: 'PENDING' },
        listAppInstallations: { appInstallations: [{ installationId: 'inst-1', app: 'storage:my-app', status: 'FINISHED' }] },
      },
    });
    await withoutRealSleeps(() => driver.installApp('storage:my-app'));
    await driver.launchApp('com.android.settings');

    expect(restCalls.filter((c) => c.method === 'installApp')).toHaveLength(1);
    expect(restCalls.find((c) => c.method === 'launchApp')?.args[1])
      .toEqual({ packageName: 'com.android.settings', activityName: 'com.android.settings.Settings' });
  });

  test('on Android, a package without a launcher activity fails clearly', async () => {
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: launcherShell('No activity found') } });
    await expect(driver.launchApp('com.example.missing')).rejects.toThrow('no launcher activity found for "com.example.missing"');
  });
});

test.describe('SauceLabsDriver.terminateApp()', () => {
  test('calls executeShellCommand with am force-stop on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.terminateApp('com.example.app');

    const call = restCalls.find((c) => c.method === 'executeShellCommand');
    expect(call?.args[1]).toBe('am force-stop com.example.app');
  });

  test('calls WDA terminateApp on iOS, after dismissing an alert left on screen', async () => {
    const { driver, wda } = createDriverWithSession({ platform: 'ios' });
    await driver.terminateApp('com.example.App');

    expect(wda!.calls.map((c) => c.method)).toEqual(['dismissAlert', 'terminateApp']);
    expect(wda!.calls.find((c) => c.method === 'terminateApp')?.args[0]).toBe('com.example.App');
  });
});

test.describe('SauceLabsDriver.installApp()', () => {
  test('uploads file to storage then calls installApp REST', async () => {
    const { driver, restCalls } = createDriverWithSession({
      restResponses: {
        uploadToStorage: 'storage:uuid-abc',
        installApp: { status: 'FINISHED' },
      },
    });
    await driver.installApp('/path/to/app.apk');

    const uploadCall = restCalls.find((c) => c.method === 'uploadToStorage');
    expect(uploadCall?.args[0]).toBe('/path/to/app.apk');

    const installCall = restCalls.find((c) => c.method === 'installApp');
    expect(installCall?.args[1]).toBe('storage:uuid-abc');
  });
});

test.describe('SauceLabsDriver.uninstallApp()', () => {
  test('sends bundleId for iOS', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'ios' });
    await driver.uninstallApp('com.example.App');

    const call = restCalls.find((c) => c.method === 'uninstallApp');
    expect(call?.args[1]).toMatchObject({ bundleId: 'com.example.App' });
  });

  test('sends packageName for Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.uninstallApp('com.example.app');

    const call = restCalls.find((c) => c.method === 'uninstallApp');
    expect(call?.args[1]).toMatchObject({ packageName: 'com.example.app' });
  });
});

test.describe('SauceLabsDriver.clearAppData()', () => {
  test('runs pm clear on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: 'Success\n' } });
    await driver.clearAppData('com.example.app');

    expect(restCalls.find((c) => c.method === 'executeShellCommand')?.args[1]).toBe('pm clear com.example.app');
  });

  test('fails on Android when pm clear does not report success', async () => {
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: 'Failed\n' } });
    await expect(driver.clearAppData('com.example.app')).rejects.toThrow('Clearing the data of com.example.app failed: Failed');
  });

  test('on iOS, reinstalls the app from the storage file this session last installed it from', async () => {
    const identifiers: Record<string, string> = { 'storage:old': 'com.example.App', 'storage:other': 'com.example.Other', 'storage:new': 'com.example.App' };
    const { driver, restCalls, wda } = createDriverWithSession({
      platform: 'ios',
      restResponses: {
        // Newest first, as Sauce Labs lists them.
        listAppInstallations: { appInstallations: [
          { app: 'storage:failed', status: 'ERROR' }, { app: 'storage:new', status: 'FINISHED' },
          { app: 'storage:other', status: 'FINISHED' }, { app: 'storage:old', status: 'FINISHED' },
        ] },
        storageAppIdentifier: async (ref: unknown) => identifiers[ref as string],
        installApp: { status: 'FINISHED' },
      },
    });
    await driver.clearAppData('com.example.App');

    // An alert the app left open would keep the reinstalled app from coming to the foreground.
    expect(wda!.calls.map((c) => c.method)).toContain('dismissAlert');
    const steps = restCalls.filter((c) => c.method === 'uninstallApp' || c.method === 'installApp');
    expect(steps.map((c) => [c.method, c.args[1]])).toEqual([['uninstallApp', { bundleId: 'com.example.App' }], ['installApp', 'storage:new']]);
    // The newest installation matched, so older ones weren't looked up.
    expect(restCalls.filter((c) => c.method === 'storageAppIdentifier').map((c) => c.args[0])).toEqual(['storage:new']);
  });

  test('on iOS, reads a URL install\'s bundle id from the IPA, once, and reinstalls from the URL', async () => {
    const url = 'https://example.com/App.ipa';
    const { driver, restCalls } = createDriverWithSession({
      platform: 'ios',
      restResponses: {
        listAppInstallations: { appInstallations: [{ app: url, status: 'FINISHED' }, { app: url, status: 'FINISHED' }] },
        ipaBundleId: 'com.example.App',
        installApp: { status: 'FINISHED' },
      },
    });
    await driver.clearAppData('com.example.App');
    await driver.clearAppData('com.example.App');

    expect(restCalls.filter((c) => c.method === 'ipaBundleId').map((c) => c.args[0])).toEqual([url]);
    expect(restCalls.filter((c) => c.method === 'installApp').map((c) => c.args[1])).toEqual([url, url]);
  });

  test('on iOS, fails without uninstalling when this session did not install the app', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'ios',
      restResponses: {
        listAppInstallations: { appInstallations: [{ app: 'storage:other', status: 'FINISHED' }] },
        storageAppIdentifier: 'com.example.Other',
      },
    });
    await expect(driver.clearAppData('com.example.App')).rejects.toThrow('this session didn\'t install it');
    expect(restCalls.some((c) => c.method === 'uninstallApp')).toBe(false);
  });
});

test.describe('SauceLabsDriver.listApps()', () => {
  test('parses pm list packages output on Android', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: 'package:com.example.one\npackage:com.example.two\n' },
    });
    const apps = await driver.listApps();

    expect(apps).toEqual([
      { bundleId: 'com.example.one' },
      { bundleId: 'com.example.two' },
    ]);
  });

  test('leaves out the packages Sauce Labs installs for its own tooling', async () => {
    // `pm list packages -3` on a fresh public Galaxy S20 Plus, plus one user app.
    const pm = ['androidx.test.orchestrator', 'androidx.test.services', 'com.android.talkback', 'com.genymobile.gnirehtet',
      'com.google.android.apps.work.clouddpc', 'com.sauce.audio.capture', 'com.saucelabs.rdc.network',
      'com.saucelabs.screenrecorder', 'org.testobject.android.toolkit', 'org.testobject.android.toolkit.test', 'com.example.myapp']
      .map((p) => `package:${p}`).join('\n');
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: pm } });

    expect(await driver.listApps()).toEqual([{ bundleId: 'com.example.myapp' }]);
  });

  test('keeps user apps whose names only resemble Sauce Labs packages', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: 'package:com.saucedemo.app\npackage:androidx.test.myapp\n' },
    });
    expect((await driver.listApps()).map((a) => a.bundleId)).toEqual(['com.saucedemo.app', 'androidx.test.myapp']);
  });

  test('ignores non-package lines in pm output', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: 'WARNING: linker\npackage:com.example.app\n' },
    });
    const apps = await driver.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].bundleId).toBe('com.example.app');
  });

  test('delegates to WDA on iOS', async () => {
    const wdaApps = [{ bundleId: 'com.apple.Music' }];
    const { driver, wda } = createDriverWithSession({
      platform: 'ios',
      wdaResponses: { listApps: wdaApps },
    });
    const apps = await driver.listApps();

    expect(wda!.calls.find((c) => c.method === 'listApps')).toBeDefined();
    expect(apps).toEqual(wdaApps);
  });
});

test.describe('SauceLabsDriver.getForegroundApp()', () => {
  test('parses mResumedActivity from dumpsys output on Android', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: {
        executeShellCommand: '  mResumedActivity: ActivityRecord{abc12 u0 com.example.app/.MainActivity t42}\n',
      },
    });
    const app = await driver.getForegroundApp();
    expect(app.bundleId).toBe('com.example.app');
  });

  test('returns empty bundleId when mResumedActivity line is absent', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: 'no matching line here\n' },
    });
    const app = await driver.getForegroundApp();
    expect(app.bundleId).toBe('');
  });

  test('delegates to WDA on iOS', async () => {
    const { driver, wda } = createDriverWithSession({
      platform: 'ios',
      wdaResponses: { getActiveAppInfo: { bundleId: 'com.apple.Maps', name: 'Maps' } },
    });
    const app = await driver.getForegroundApp();

    expect(wda!.calls.find((c) => c.method === 'getActiveAppInfo')).toBeDefined();
    expect(app.bundleId).toBe('com.apple.Maps');
  });
});

test.describe('SauceLabsDriver.openUrl()', () => {
  test('calls REST openUrl with the given URL', async () => {
    const { driver, restCalls } = createDriverWithSession();
    await driver.openUrl('https://example.com');

    const call = restCalls.find((c) => c.method === 'openUrl');
    expect(call?.args[1]).toBe('https://example.com');
  });
});

// ─── Device settings ─────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.applyDeviceSettings()', () => {
  test('calls applySettings with animations=false for { animations: off } on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.applyDeviceSettings({ animations: 'off' });

    const call = restCalls.find((c) => c.method === 'applySettings');
    expect(call?.args[1]).toMatchObject({ animations: false });
  });

  test('calls applySettings with animations=true for { animations: on } on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
    await driver.applyDeviceSettings({ animations: 'on' });

    const call = restCalls.find((c) => c.method === 'applySettings');
    expect(call?.args[1]).toMatchObject({ animations: true });
  });

  test('does not call applySettings for animations on iOS', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'ios' });
    await driver.applyDeviceSettings({ animations: 'off' });

    const call = restCalls.find((c) => c.method === 'applySettings');
    expect(call).toBeUndefined();
  });
});

// ─── Disconnect ──────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.disconnect()', () => {
  test('deletes the Sauce Labs session when this driver created it', async () => {
    const { driver, restCalls } = createDriverWithSession({ ownsSession: true });
    await driver.disconnect();

    const call = restCalls.find((c) => c.method === 'deleteSession');
    expect(call?.args[0]).toBe('sess-123');
  });

  test('leaves the Sauce Labs session alive when this driver only attached to it', async () => {
    const { driver, restCalls } = createDriverWithSession({ ownsSession: false });
    await driver.disconnect();

    const call = restCalls.find((c) => c.method === 'deleteSession');
    expect(call).toBeUndefined();
  });

  test('still closes local sockets and WDA when not owning the session', async () => {
    const { driver, ioSocket, wda } = createDriverWithSession({ ownsSession: false, platform: 'ios' });
    let ioClosed = false;
    ioSocket.disconnect = async () => { ioClosed = true; };
    let wdaClosed = false;
    wda!.close = async () => { wdaClosed = true; };

    await driver.disconnect();

    expect(ioClosed).toBe(true);
    expect(wdaClosed).toBe(true);
  });
});

// ─── Device list ─────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.listDevices()', () => {
  const descriptors = [
    { id: 'iPhone_15_real', name: 'iPhone 15', os: 'IOS', osVersion: '17.0' },
    { id: 'Samsung_S24_real', name: 'Samsung S24', os: 'ANDROID', osVersion: '14' },
  ];
  const statusResp = {
    devices: [
      { descriptor: 'iPhone_15_real', isPrivateDevice: false, state: 'AVAILABLE' },
      { descriptor: 'Samsung_S24_real', isPrivateDevice: false, state: 'IN_USE' },
    ],
  };

  test('returns merged descriptor + status list', async () => {
    const { driver } = createDriverWithSession({
      restResponses: { listDevices: descriptors, listDeviceStatus: statusResp },
    });
    const devices = await driver.listDevices();

    expect(devices).toHaveLength(2);
    expect(devices[0].id).toBe('iPhone_15_real');
    expect(devices[0].platform).toBe('ios');
    expect(devices[0].state).toBe('online');
    expect(devices[1].state).toBe('offline');
  });

  test('maps IN_USE device state to offline', async () => {
    const { driver } = createDriverWithSession({
      restResponses: { listDevices: descriptors, listDeviceStatus: statusResp },
    });
    const devices = await driver.listDevices();
    expect(devices.find((d) => d.id === 'Samsung_S24_real')?.state).toBe('offline');
  });

  test('filters by platform when opts.platform is set', async () => {
    const { driver } = createDriverWithSession({
      restResponses: { listDevices: descriptors, listDeviceStatus: statusResp },
    });
    const devices = await driver.listDevices({ platform: 'ios' });

    expect(devices.every((d) => d.platform === 'ios')).toBe(true);
    expect(devices).toHaveLength(1);
  });

  test('filters by state when opts.state is set', async () => {
    const { driver } = createDriverWithSession({
      restResponses: { listDevices: descriptors, listDeviceStatus: statusResp },
    });
    const devices = await driver.listDevices({ state: 'online' });

    expect(devices.every((d) => d.state === 'online')).toBe(true);
  });
});

// ─── Recording ───────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver startRecording / stopRecording', () => {
  test('are not supported: Sauce Labs records the video', async () => {
    const { driver } = createDriverWithSession();
    await expect(driver.startRecording({ output: '/tmp/out.mp4' })).rejects.toThrow('Sauce Labs records');
    await expect(driver.stopRecording()).rejects.toThrow('Sauce Labs records');
  });
});

// ─── View hierarchy ───────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.getViewHierarchy()', () => {
  test('calls executeShellCommand with uiautomator dump on Android', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: '<?xml version="1.0"?><hierarchy />' },
    });
    await driver.getViewHierarchy();

    const call = restCalls.find((c) => c.method === 'executeShellCommand');
    expect((call?.args[1] as string)).toContain('uiautomator dump');
  });

  test('parses uiautomator XML into ViewNode array on Android', async () => {
    const xml = `<?xml version="1.0"?>
<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][1080,1920]" enabled="true" />
</hierarchy>`;
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { executeShellCommand: xml },
    });
    const nodes = await driver.getViewHierarchy();

    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].type).toBe('hierarchy');
  });

  test('delegates to WDA getSource on iOS', async () => {
    const wdaNodes: ViewNode[] = [{ type: 'XCUIElementTypeWindow', isVisible: true, isEnabled: true, bounds: { x: 0, y: 0, width: 390, height: 844 }, children: [] }];
    const { driver, wda } = createDriverWithSession({
      platform: 'ios',
      wdaResponses: { getSource: wdaNodes },
    });
    const nodes = await driver.getViewHierarchy();

    expect(wda!.calls.find((c) => c.method === 'getSource')).toBeDefined();
    expect(nodes).toEqual(wdaNodes);
  });
});

test.describe('SauceLabsDriver.getViewHierarchy() text field values on iOS', () => {
  const field = (value: string | undefined, placeholder?: string): ViewNode => ({
    type: 'XCUIElementTypeTextField', value, placeholder, isVisible: true, isEnabled: true,
    bounds: { x: 0, y: 0, width: 300, height: 44 }, children: [],
  });
  const iosDriver = (node: ViewNode) => createDriverWithSession({ platform: 'ios', wdaResponses: { getSource: [node] } });

  test('a value equal to the placeholder means the field is empty; the placeholder is kept', async () => {
    const { driver } = iosDriver(field('Coupon code', 'Coupon code'));
    const [node] = await driver.getViewHierarchy();

    expect(node.value).toBeUndefined();
    expect(node.placeholder).toBe('Coupon code');
  });

  test('text the driver typed is reported even when it equals the placeholder', async () => {
    const { driver } = iosDriver(field('Coupon code', 'Coupon code'));
    await driver.tap(10, 10);
    await driver.typeText('Coupon code');

    expect((await driver.getViewHierarchy())[0].value).toBe('Coupon code');
  });

  test('a tap ends that exception, since the typed text may belong to another field', async () => {
    const { driver } = iosDriver(field('Coupon code', 'Coupon code'));
    await driver.typeText('Coupon code');
    await driver.tap(10, 10);

    expect((await driver.getViewHierarchy())[0].value).toBeUndefined();
  });

  test('without a placeholder in the source, the field clearText() cleared (found by its rect) reads as empty', async () => {
    const bounds = { x: 0, y: 0, width: 300, height: 44 };
    const { driver } = createDriverWithSession({
      platform: 'ios',
      wdaResponses: {
        getSource: [field('Search or enter website name'), { ...field('other field'), bounds: { x: 0, y: 100, width: 300, height: 44 } }],
        clearActiveElement: bounds,
      },
    });
    await driver.clearText();
    const [cleared, other] = await driver.getViewHierarchy();

    expect(cleared.value).toBeUndefined();
    expect(other.value).toBe('other field');
  });

  test('the cleared field is found even when WDA\'s rect of it differs from the page source by a few points', async () => {
    const { driver } = createDriverWithSession({
      platform: 'ios',
      wdaResponses: {
        getSource: [
          { ...field('https://www.website.com'), bounds: { x: 16, y: 225, width: 361, height: 45 } },
          { ...field('next field'), bounds: { x: 16, y: 290, width: 361, height: 45 } },
          { ...field('whole form'), bounds: { x: 0, y: 0, width: 393, height: 852 } },
        ],
        clearActiveElement: { x: 16, y: 231, width: 370, height: 47 },
      },
    });
    await driver.clearText();
    const [cleared, next, form] = await driver.getViewHierarchy();

    expect(cleared.value).toBeUndefined();
    expect(next.value).toBe('next field');
    expect(form.value).toBe('whole form');
  });

  test('typing or tapping after clearText() ends the cleared-field rule', async () => {
    const bounds = { x: 0, y: 0, width: 300, height: 44 };
    const typed = createDriverWithSession({ platform: 'ios', wdaResponses: { getSource: [field('abc')], clearActiveElement: bounds } });
    await typed.driver.clearText();
    await typed.driver.typeText('abc');
    expect((await typed.driver.getViewHierarchy())[0].value).toBe('abc');

    const tapped = createDriverWithSession({ platform: 'ios', wdaResponses: { getSource: [field('existing')], clearActiveElement: bounds } });
    await tapped.driver.clearText();
    await tapped.driver.tap(10, 10);
    expect((await tapped.driver.getViewHierarchy())[0].value).toBe('existing');
  });

  test('a value that differs from the placeholder is kept, as is a field without one', async () => {
    expect((await iosDriver(field('hello', 'Coupon code')).driver.getViewHierarchy())[0].value).toBe('hello');
    expect((await iosDriver(field('hello')).driver.getViewHierarchy())[0].value).toBe('hello');
  });
});

// ─── waitForActive ────────────────────────────────────────────────────────────

test.describe('waitForActiveSession()', () => {
  function fakeRestReturning(states: Array<{ state: string; links?: Record<string, string> }>) {
    let i = 0;
    return {
      getSession: async (_id: string) => {
        const entry = states[Math.min(i++, states.length - 1)];
        return { id: 'sess-1', state: entry.state, links: entry.links };
      },
    };
  }

  test('returns session when state is ACTIVE and links are present', async () => {
    // Override setTimeout so the test does not actually sleep 5s.
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
    try {
      const rest = fakeRestReturning([
        { state: 'ACTIVE', links: { ioWebsocketUrl: 'wss://io', eventsWebsocketUrl: 'wss://ev' } },
      ]);
      const session = await waitForActiveSession(rest as any, 'sess-1', 60_000);
      expect(session.state).toBe('ACTIVE');
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
  });

  test('keeps polling when ACTIVE but links are missing', async () => {
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
    try {
      const rest = fakeRestReturning([
        { state: 'ACTIVE' },
        { state: 'ACTIVE' },
        { state: 'ACTIVE', links: { ioWebsocketUrl: 'wss://io', eventsWebsocketUrl: 'wss://ev' } },
      ]);
      const session = await waitForActiveSession(rest as any, 'sess-1', 60_000);
      expect(session.links?.ioWebsocketUrl).toBe('wss://io');
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
  });

  test('throws immediately on ERRORED state', async () => {
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
    try {
      const rest = fakeRestReturning([{ state: 'ERRORED' }]);
      await expect(waitForActiveSession(rest as any, 'sess-1', 60_000)).rejects.toThrow('ERRORED');
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
  });

  test('throws immediately on CLOSED state', async () => {
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
    try {
      const rest = fakeRestReturning([{ state: 'CLOSED' }]);
      await expect(waitForActiveSession(rest as any, 'sess-1', 60_000)).rejects.toThrow('CLOSED');
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
  });

  test('throws timeout error when deadline is exceeded', async () => {
    const origTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
    try {
      const rest = fakeRestReturning([{ state: 'PENDING' }]);
      // zero-length timeout → deadline already passed
      await expect(waitForActiveSession(rest as any, 'sess-1', 0)).rejects.toThrow('Timed out');
    } finally {
      (globalThis as any).setTimeout = origTimeout;
    }
  });
});

// ─── swipe ────────────────────────────────────────────────────────────────────

test.describe('SauceLabsDriver.swipe()', () => {
  test('sends touch down, move sequence, then touch up', async () => {
    const { driver, ioSocket } = createDriverWithSession({
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      pixelsPerPoint: 1,
    });
    await driver.swipe('up');

    const actions = ioSocket.touchCalls.map((c) => c.action);
    expect(actions[0]).toBe('d');
    expect(actions[actions.length - 1]).toBe('u');
    expect(actions.includes('m')).toBe(true);
  });
});

// ─── Device pool: allocate / release ─────────────────────────────────────────

const ACTIVE_SESSION = {
  id: 'sess-alloc',
  state: 'ACTIVE',
  device: { descriptor: 'Google_Pixel_8_real', deviceName: 'Google Pixel 8', os: 'ANDROID', osVersion: '14' },
  links: { ioWebsocketUrl: 'wss://io', eventsWebsocketUrl: 'wss://ev' },
};

function withoutRealSleeps<T>(run: () => Promise<T>): Promise<T> {
  const origTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => origTimeout(fn, 0);
  return run().finally(() => { (globalThis as any).setTimeout = origTimeout; });
}

function createDriverWithFakeRest(restResponses: Record<string, unknown>, options: SauceLabsDriverOptions = {}) {
  const driver = new SauceLabsDriver({ username: 'alice', accessKey: 'secret', ...options });
  const { rest, calls } = createFakeRest(restResponses);
  (driver as any).makeRest = () => rest;
  return { driver, restCalls: calls };
}

test.describe('SauceLabsDriver.allocate()', () => {
  test('creates a session and hands its id to the pool as the deviceId', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-alloc', state: 'PENDING' },
      getSession: ACTIVE_SESSION,
    });

    const device = await withoutRealSleeps(() => driver.allocate({ platform: 'android', deviceNamePattern: 'Pixel' }, new Set()));

    expect(device).toEqual({
      deviceId: 'sess-alloc',
      platform: 'android',
      driver: 'saucelabs',
      model: 'Google Pixel 8',
      osVersion: '14',
      type: 'real',
    });
    const created = restCalls.find((c) => c.method === 'createSession');
    expect(created?.args[0]).toEqual({ device: { os: 'ANDROID', deviceName: '.*(?:Pixel).*' } });
  });

  test('installs installApps on the new session and reports them installed, so the fixture skips them', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-alloc', state: 'PENDING' },
      getSession: ACTIVE_SESSION,
      uploadToStorage: 'storage:from-file',
      installApp: { status: 'FINISHED' },
    });
    const installApps = ['./app.apk', 'https://example.com/helper.apk'];

    const device = await withoutRealSleeps(() => driver.allocate({ platform: 'android', installApps }, new Set()));

    expect(device.installedApps).toEqual(installApps);
    // The upload happens before the session is created, so no device waits for it; Sauce Labs downloads the URL.
    expect(restCalls.map((c) => c.method).filter((m) => ['uploadToStorage', 'createSession', 'installApp'].includes(m)))
      .toEqual(['uploadToStorage', 'createSession', 'installApp', 'installApp']);
    expect(restCalls.filter((c) => c.method === 'installApp').map((c) => c.args.slice(0, 2)))
      .toEqual([['sess-alloc', 'storage:from-file'], ['sess-alloc', 'https://example.com/helper.apk']]);
  });

  test('deletes the session and fails the allocation when an installApps entry fails to install', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-alloc', state: 'PENDING' },
      getSession: ACTIVE_SESSION,
      installApp: { installationId: 'inst-1', status: 'PENDING' },
      listAppInstallations: { appInstallations: [{ installationId: 'inst-1', app: 'storage:bad', status: 'ERROR' }] },
    });

    await expect(withoutRealSleeps(() => driver.allocate({ platform: 'ios', installApps: ['storage:bad'] }, new Set())))
      .rejects.toThrow('App installation failed for storage:bad');
    expect(restCalls.find((c) => c.method === 'deleteSession')?.args[0]).toBe('sess-alloc');
  });

  test('deletes the session again when it never becomes ACTIVE', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-alloc', state: 'PENDING' },
      getSession: { id: 'sess-alloc', state: 'CLOSED' },
    });

    await expect(withoutRealSleeps(() => driver.allocate({ platform: 'ios' }, new Set()))).rejects.toThrow('CLOSED');

    const deleted = restCalls.find((c) => c.method === 'deleteSession');
    expect(deleted?.args[0]).toBe('sess-alloc');
  });

  test('replaces a session Sauce Labs fails with ERRORED, without trying to delete it', async () => {
    let created = 0;
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: async () => ({ id: `sess-${++created}`, state: 'PENDING' }),
      getSession: async (id: unknown) => (id === 'sess-1' ? { id, state: 'ERRORED' } : { ...ACTIVE_SESSION, id }),
    });

    const device = await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));

    expect(device.deviceId).toBe('sess-2');
    expect(restCalls.filter((c) => c.method === 'deleteSession')).toHaveLength(0);
  });

  test('gives up after one replacement when sessions keep ending ERRORED', async () => {
    let created = 0;
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: async () => ({ id: `sess-${++created}`, state: 'PENDING' }),
      getSession: async (id: unknown) => ({ id, state: 'ERRORED' }),
    });

    const err = await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set())).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionTerminatedError);
    expect((err as SessionTerminatedError).state).toBe('ERRORED');
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(2);
    expect(restCalls.filter((c) => c.method === 'deleteSession')).toHaveLength(0);
  });

  test('connect() also replaces an ERRORED session it created, once', async () => {
    let created = 0;
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: async () => ({ id: `sess-${++created}`, state: 'PENDING' }),
      getSession: async (id: unknown) => ({ id, state: 'ERRORED' }),
    });

    await expect(withoutRealSleeps(() => driver.connect({ platform: 'android' }))).rejects.toBeInstanceOf(SessionTerminatedError);
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(2);
    expect(restCalls.filter((c) => c.method === 'deleteSession')).toHaveLength(0);
  });

  test('connect() does not replace an ERRORED session it only attached to', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      getSession: { id: 'sess-pool', state: 'ERRORED' },
    });

    await expect(withoutRealSleeps(() => driver.connect({ platform: 'android', deviceId: 'sess-pool' }))).rejects.toBeInstanceOf(SessionTerminatedError);
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(0);
  });

  test('sends the tunnel and session duration in the session configuration', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-alloc', state: 'PENDING' },
      getSession: ACTIVE_SESSION,
    }, { tunnelName: 'my-tunnel', tunnelOwner: 'bob', sessionDuration: 'PT1H' });

    await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));

    expect(restCalls.find((c) => c.method === 'createSession')?.args[0]).toEqual({
      device: { os: 'ANDROID' },
      configuration: { sessionDuration: 'PT1H', tunnel: { name: 'my-tunnel', owner: 'bob' } },
    });
  });

  test('does not replace a session that ERRORED because its tunnel was unreachable, and says why', async () => {
    const reason = 'Failed to reach Sauce Connect tunnel with identifier:\'gone\'.';
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: { id: 'sess-1', state: 'PENDING' },
      getSession: { id: 'sess-1', state: 'ERRORED', error: { message: reason } },
    }, { tunnelName: 'gone' });

    await expect(withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()))).rejects.toThrow(reason);
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(1);
  });

  test.describe('with sauceConnect', () => {
    const originalStart = SauceConnect.start;
    let started: Array<Parameters<typeof SauceConnect.start>[0]>;
    let tunnel: { tunnelName: string; running: boolean; stopped: number; stop(): Promise<void>; describeExit(): string };

    test.beforeEach(() => {
      started = [];
      tunnel = {
        tunnelName: 'mobilewright-abc',
        running: true,
        stopped: 0,
        async stop() { this.stopped++; },
        describeExit: () => 'Sauce Connect tunnel "mobilewright-abc" stopped (exit code 1).',
      };
      SauceConnect.start = async (params) => { started.push(params); return tunnel as unknown as SauceConnect; };
    });
    test.afterEach(() => { SauceConnect.start = originalStart; });

    test('prepare() starts one tunnel, sessions use it, and dispose() stops it', async () => {
      const { driver, restCalls } = createDriverWithFakeRest({
        createSession: { id: 'sess-alloc', state: 'PENDING' },
        getSession: ACTIVE_SESSION,
      }, { sauceConnect: true, region: 'eu-central-1', sauceConnectOpts: { proxyLocalhost: 'allow' } });

      await driver.prepare();
      await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));
      await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));
      await driver.dispose();

      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ username: 'alice', accessKey: 'secret', region: 'eu-central-1', options: { proxyLocalhost: 'allow' } });
      expect(restCalls.filter((c) => c.method === 'createSession').map((c) => (c.args[0] as any).configuration))
        .toEqual([{ tunnel: { name: 'mobilewright-abc' } }, { tunnel: { name: 'mobilewright-abc' } }]);
      expect(tunnel.stopped).toBe(1);
    });

    test('a session created without prepare() starts the tunnel first', async () => {
      const { driver, restCalls } = createDriverWithFakeRest({
        createSession: { id: 'sess-alloc', state: 'PENDING' },
        getSession: ACTIVE_SESSION,
      }, { sauceConnect: true });

      await withoutRealSleeps(() => driver.allocate({ platform: 'ios' }, new Set()));

      expect(started).toHaveLength(1);
      expect((restCalls.find((c) => c.method === 'createSession')?.args[0] as any).configuration).toEqual({ tunnel: { name: 'mobilewright-abc' } });
    });

    test('fails new sessions with Sauce Connect output once the tunnel has stopped', async () => {
      const { driver, restCalls } = createDriverWithFakeRest({}, { sauceConnect: true });
      await driver.prepare();
      tunnel.running = false;

      await expect(driver.allocate({ platform: 'android' }, new Set())).rejects.toThrow('stopped (exit code 1)');
      expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(0);
    });

    test('a failed start is retried by the next session', async () => {
      SauceConnect.start = async (params) => {
        started.push(params);
        if (started.length === 1) throw new Error('Sauce Connect could not start');
        return tunnel as unknown as SauceConnect;
      };
      const { driver } = createDriverWithFakeRest({
        createSession: { id: 'sess-alloc', state: 'PENDING' },
        getSession: ACTIVE_SESSION,
      }, { sauceConnect: true });

      await expect(driver.prepare()).rejects.toThrow('could not start');
      await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));
      expect(started).toHaveLength(2);
    });
  });

  test('rejects a request without a platform', async () => {
    const { driver } = createDriverWithFakeRest({});
    await expect(driver.allocate({}, new Set())).rejects.toThrow('platform');
  });

  test('rejects a pinned deviceId since Sauce Labs selects devices by name', async () => {
    const { driver } = createDriverWithFakeRest({});
    await expect(driver.allocate({ platform: 'ios', deviceId: 'iPhone_15_real' }, new Set())).rejects.toThrow('deviceId');
  });
});

test('release() deletes the Sauce Labs session behind the pool deviceId', async () => {
  const { driver, restCalls } = createDriverWithFakeRest({});
  await driver.release('sess-alloc');

  const deleted = restCalls.find((c) => c.method === 'deleteSession');
  expect(deleted?.args[0]).toBe('sess-alloc');
});

test.describe('SauceLabsDriver unsupported device controls', () => {
  test('setGeolocation() throws since the RDC API has no geolocation override', async () => {
    const driver = new SauceLabsDriver({ username: 'u', accessKey: 'k' });
    await expect(driver.setGeolocation({ latitude: 52.52, longitude: 13.405 })).rejects.toThrow('not supported');
  });

  test('setFoldState() throws since the RDC API has no hinge control', async () => {
    const driver = new SauceLabsDriver({ username: 'u', accessKey: 'k' });
    await expect(driver.setFoldState('folded')).rejects.toThrow('not supported');
  });
});

// Bodies from the Access API spec's createSession examples (application/problem+json).
function createSessionError(status: number, body: Record<string, unknown>): SauceApiError {
  return new SauceApiError(`POST /sessions failed: ${status} ${JSON.stringify(body)}`, status, body);
}

const CONCURRENCY_LIMIT = { title: 'Access API Concurrency Limit Reached', detail: 'Your organization already has 5 public devices allocated.' };

/** createSession fake that fails with `errors` in order, then creates `sess-retry`. */
function failingThenCreated(...errors: Error[]) {
  let calls = 0;
  return async () => {
    const err = errors[calls++];
    if (err) throw err;
    return { id: 'sess-retry', state: 'PENDING' };
  };
}

test.describe('SauceLabsDriver.allocate() when Sauce Labs cannot hand out a device yet', () => {
  test('retries a 409 concurrency limit with backoff until a device frees up', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: failingThenCreated(createSessionError(409, CONCURRENCY_LIMIT), createSessionError(409, CONCURRENCY_LIMIT)),
      getSession: ACTIVE_SESSION,
    });

    const device = await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set(), new AbortController().signal));

    expect(device.deviceId).toBe('sess-retry');
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(3);
  });

  test('retries the free-tier 409 and "all matching devices busy" the same way', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: failingThenCreated(
        createSessionError(409, { title: 'Free Tier Concurrency Limit Reached', detail: 'one public device' }),
        createSessionError(400, { title: 'All devices un-available', unavailableDevices: ['iPhone_16_real'] }),
      ),
      getSession: ACTIVE_SESSION,
    });

    const device = await withoutRealSleeps(() => driver.allocate({ platform: 'ios' }, new Set(), new AbortController().signal));

    expect(device.deviceId).toBe('sess-retry');
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(3);
  });

  test('hands NoDeviceAvailableError straight to the pool when it already holds a session from this driver', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: failingThenCreated(createSessionError(409, CONCURRENCY_LIMIT)),
      getSession: ACTIVE_SESSION,
    });
    // An earlier allocate() for this pool succeeded and its session has not been released yet.
    (driver as any).poolSessions.add('sess-held');

    const err = await driver.allocate({ platform: 'android' }, new Set(), new AbortController().signal).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoDeviceAvailableError);
    expect((err as Error).message).toContain('Access API Concurrency Limit Reached');
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(1);
  });

  test('tracks a pool session from allocate() until release(), so retries resume once the pool holds none', async () => {
    const { driver } = createDriverWithFakeRest({
      createSession: { id: 'sess-1', state: 'PENDING' },
      getSession: ACTIVE_SESSION,
    });
    const first = await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));
    expect((driver as any).poolSessions.has(first.deviceId)).toBe(true);

    await driver.release(first.deviceId);

    expect((driver as any).poolSessions.size).toBe(0);
  });

  test('stops retrying with an abort error when the pool aborts the allocation', async () => {
    const controller = new AbortController();
    const { driver } = createDriverWithFakeRest({
      createSession: async () => {
        // Abort while the driver is backing off after this 409.
        setTimeout(() => controller.abort(), 0);
        throw createSessionError(409, CONCURRENCY_LIMIT);
      },
    });

    await expect(driver.allocate({ platform: 'android' }, new Set(), controller.signal)).rejects.toThrow(/Aborted while waiting for a Sauce Labs device/);
  });

  test('without a signal, gives up after allocationTimeout with NoDeviceAvailableError', async () => {
    const { driver } = createDriverWithFakeRest(
      { createSession: createSessionError(409, CONCURRENCY_LIMIT) },
      { allocationTimeout: 1_000 },
    );

    await expect(driver.allocate({ platform: 'android' }, new Set())).rejects.toBeInstanceOf(NoDeviceAvailableError);
  });

  test('keeps "no device matches" a hard error without retrying, and includes the evaluated query', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: createSessionError(400, {
        title: 'No device matches your device query',
        detail: 'The device query did not match any devices.',
        deviceQuery: { os: 'ios', deviceName: 'iPhone_99' },
      }),
    });

    const err = await driver.allocate({ platform: 'ios', deviceNamePattern: 'iPhone_99' }, new Set()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NoDeviceAvailableError);
    expect((err as Error).message).toContain('No Sauce Labs device matches platform=ios, deviceName=/iPhone_99/');
    expect((err as Error).message).toContain('"deviceName":"iPhone_99"');
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(1);
  });

  test('passes other API errors through unchanged', async () => {
    const original = createSessionError(400, { title: 'Device does not exist.', detail: 'The deviceId "Samsung XR" does not exist.' });
    const { driver } = createDriverWithFakeRest({ createSession: original });

    await expect(driver.allocate({ platform: 'android' }, new Set())).rejects.toBe(original);
  });

  test('connect() without a pool device maps the 409 to NoDeviceAvailableError without retrying', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      createSession: createSessionError(409, CONCURRENCY_LIMIT),
    });

    await expect(driver.connect({ platform: 'android' })).rejects.toBeInstanceOf(NoDeviceAvailableError);
    expect(restCalls.filter((c) => c.method === 'createSession')).toHaveLength(1);
  });
});

test('backoffDelay doubles from 5s up to a 60s cap, with ±20% jitter', () => {
  const noJitter = () => 0.5;
  expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, noJitter))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  expect(backoffDelay(1, () => 0)).toBe(4_000);
  expect(backoffDelay(1, () => 1)).toBe(6_000);
});

test.describe('toSauceDeviceNameQuery()', () => {
  // Sauce Labs requires the regex to match the whole name; Mobilewright patterns match anywhere in it.
  const sauceMatches = (pattern: string, name: string) => new RegExp(`^(?:${toSauceDeviceNameQuery(pattern)})$`).test(name);

  test('a plain pattern matches anywhere in the device name', () => {
    expect(sauceMatches('Pixel 8', 'Google Pixel 8 Pro')).toBe(true);
    expect(sauceMatches('Pixel', 'Google_Pixel_8_real_sjc1')).toBe(true);
    expect(sauceMatches('Pixel 9', 'Google Pixel 8')).toBe(false);
  });

  test('anchors keep their meaning', () => {
    expect(sauceMatches('^Google_Pixel', 'Google_Pixel_8_real_sjc1')).toBe(true);
    expect(sauceMatches('^Pixel', 'Google_Pixel_8_real_sjc1')).toBe(false);
    expect(sauceMatches('_sjc1$', 'Google_Pixel_8_real_sjc1')).toBe(true);
  });

  test('alternation stays grouped', () => {
    expect(sauceMatches('iPhone_15|iPhone_16', 'iPhone_16_Pro_real')).toBe(true);
    expect(sauceMatches('iPhone_15|iPhone_16', 'Samsung_Galaxy')).toBe(false);
  });

  test('a whole-name pattern written for Sauce Labs still works', () => {
    expect(sauceMatches('Google_Pixel.*_16_real.*', 'Google_Pixel_10_Pro_16_real_sjc1')).toBe(true);
  });
});

test.describe('device criteria: osVersion and deviceType', () => {
  const DEVICES = [
    { id: 'Google_Pixel_8_14_real', name: 'Google Pixel 8', os: 'ANDROID', osVersion: '14' },
    { id: 'Google_Pixel_9_15_real', name: 'Google Pixel 9', os: 'ANDROID', osVersion: '15.0' },
    { id: 'Samsung_Galaxy_S24_15_real', name: 'Samsung Galaxy S24', os: 'ANDROID', osVersion: '15' },
    { id: 'Google_Pixel_10_16_real', name: 'Google Pixel 10', os: 'ANDROID', osVersion: '16' },
    { id: 'iPhone_15_17_real', name: 'iPhone 15', os: 'IOS', osVersion: '17.5' },
  ];
  const sentDeviceName = (calls: { method: string; args: unknown[] }[]) =>
    (calls.find((c) => c.method === 'createSession')?.args[0] as { device: { deviceName?: string } }).device.deviceName;

  test('osVersion is resolved to the exact ids of matching devices for the platform', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      listDevices: DEVICES, createSession: { id: 'sess-1', state: 'PENDING' }, getSession: ACTIVE_SESSION,
    });
    await withoutRealSleeps(() => driver.allocate({ platform: 'android', osVersion: '15' }, new Set()));

    expect(sentDeviceName(restCalls)).toBe(toSauceDeviceNameQuery('^(?:Google_Pixel_9_15_real|Samsung_Galaxy_S24_15_real)$'));
  });

  test('osVersion ranges and deviceName combine', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      listDevices: DEVICES, createSession: { id: 'sess-1', state: 'PENDING' }, getSession: ACTIVE_SESSION,
    });
    await withoutRealSleeps(() => driver.allocate({ platform: 'android', osVersion: '>=15', deviceNamePattern: 'Pixel' }, new Set()));

    expect(sentDeviceName(restCalls)).toBe(toSauceDeviceNameQuery('^(?:Google_Pixel_9_15_real|Google_Pixel_10_16_real)$'));
  });

  test('no matching device fails clearly and lists the available versions', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({ listDevices: DEVICES });
    const err = await driver.allocate({ platform: 'android', osVersion: '12' }, new Set()).catch((e: unknown) => e);

    expect((err as Error).message).toContain('No Sauce Labs android device matches osVersion "12"');
    expect((err as Error).message).toContain('14, 15, 15.0, 16');
    expect(restCalls.some((c) => c.method === 'createSession')).toBe(false);
  });

  test('without osVersion, the device list is not fetched', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({ createSession: { id: 'sess-1', state: 'PENDING' }, getSession: ACTIVE_SESSION });
    await withoutRealSleeps(() => driver.allocate({ platform: 'android', deviceNamePattern: 'Pixel' }, new Set()));

    expect(restCalls.some((c) => c.method === 'listDevices')).toBe(false);
  });

  test('connect() applies osVersion the same way', async () => {
    const { driver, restCalls } = createDriverWithFakeRest({
      listDevices: DEVICES, createSession: { id: 'sess-1', state: 'PENDING' }, getSession: { id: 'sess-1', state: 'CLOSED' },
    });
    await withoutRealSleeps(() => driver.connect({ platform: 'ios', osVersion: '17' })).catch(() => {});

    expect(sentDeviceName(restCalls)).toBe(toSauceDeviceNameQuery('^(?:iPhone_15_17_real)$'));
  });

  test('simulators and emulators are rejected; "real" is accepted', async () => {
    const { driver } = createDriverWithFakeRest({ createSession: { id: 'sess-1', state: 'PENDING' }, getSession: ACTIVE_SESSION });

    await expect(driver.allocate({ platform: 'ios', deviceType: 'simulator' }, new Set())).rejects.toThrow('only provides real devices');
    await expect(driver.connect({ platform: 'android', deviceType: 'emulator' })).rejects.toThrow('only provides real devices');
    await expect(withoutRealSleeps(() => driver.allocate({ platform: 'ios', deviceType: 'real' }, new Set()))).resolves.toBeDefined();
  });
});

test.describe('SauceLabsDriver.installApp() app references (what installApps entries reach the driver as)', () => {
  /** REST fake: installApp hands out ids that listAppInstallations reports FINISHED. */
  function appRest() {
    const installs: { installationId: string; app: string; status: string }[] = [];
    return {
      uploadToStorage: async (path: unknown) => `storage:from-file-${String(path).split('/').pop()}`,
      installApp: async (_s: unknown, app: unknown) => {
        const installationId = `inst-${installs.length + 1}`;
        installs.push({ installationId, app: String(app), status: 'FINISHED' });
        return { installationId, status: 'PENDING' };
      },
      listAppInstallations: async () => ({ appInstallations: installs }),
    };
  }
  const installedRefs = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.method === 'installApp').map((c) => c.args[1]);

  test('passes storage refs and URLs to Sauce Labs as given, and uploads local files first', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android', restResponses: appRest() });
    for (const app of ['storage:abc', 'storage:filename=my.apk', 'https://example.com/app.apk', './helper.apk']) {
      await withoutRealSleeps(() => driver.installApp(app));
    }

    expect(installedRefs(restCalls)).toEqual(['storage:abc', 'storage:filename=my.apk', 'https://example.com/app.apk', 'storage:from-file-helper.apk']);
    expect(restCalls.filter((c) => c.method === 'uploadToStorage').map((c) => c.args[0])).toEqual(['./helper.apk']);
  });

  test('reuses an upload within the driver instance', async () => {
    const { driver, restCalls } = createDriverWithSession({ platform: 'android', restResponses: appRest() });
    await withoutRealSleeps(() => driver.installApp('./app.apk'));
    await withoutRealSleeps(() => driver.installApp('./app.apk'));

    expect(restCalls.filter((c) => c.method === 'uploadToStorage')).toHaveLength(1);
    expect(installedRefs(restCalls)).toEqual(['storage:from-file-app.apk', 'storage:from-file-app.apk']);
  });
});

test.describe('reporting tests to Sauce Labs', () => {
  const running = (over: Partial<{ titlePath: string[]; retry: number; status: string; expectedStatus: string }> = {}) =>
    () => ({ titlePath: ['login.spec.ts', 'login', 'signs in'], retry: 0, status: 'passed', expectedStatus: 'passed', ...over });
  const calls = (restCalls: { method: string; args: unknown[] }[], method: string) => restCalls.filter((c) => c.method === method);

  async function connectAndDisconnect(driver: SauceLabsDriver) {
    await (driver as any).startReportedTest();
    await driver.disconnect();
  }

  test('starts a test named after the Playwright test and ends it as passed', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { startTest: { jobId: 'job-1' }, endTest: { jobId: 'job-1', status: 'passed' } },
      driverOptions: { _currentTest: running(), build: 'build-42', tags: ['smoke'], artifacts: { video: true } },
    });
    await connectAndDisconnect(driver);

    expect(calls(restCalls, 'startTest')[0].args[1]).toEqual({
      testName: 'login.spec.ts › login › signs in',
      build: 'build-42',
      tags: ['smoke'],
      artifacts: { video: true, screenshots: true, deviceLogs: true },
    });
    expect(calls(restCalls, 'endTest')[0].args[1]).toBe('passed');
  });

  test('links the Sauce Labs job in the Playwright report, on the region\'s host', async () => {
    const hosts = [
      [undefined, 'app.saucelabs.com'],
      ['eu-central-1', 'app.eu-central-1.saucelabs.com'],
      ['asia-south-2', 'app.asia-south-2.saucelabs.com'],
    ] as const;
    for (const [region, host] of hosts) {
      const current = { ...running()(), annotations: [] as Array<{ type: string; description?: string }> };
      const { driver } = createDriverWithSession({
        platform: 'android',
        restResponses: { startTest: { jobId: 'job-1' }, endTest: {} },
        driverOptions: { _currentTest: () => current, ...(region ? { region } : {}) },
      });
      await connectAndDisconnect(driver);

      expect(current.annotations).toEqual([{ type: 'Sauce Labs', description: `https://${host}/tests/job-1` }]);
    }
  });

  test('video, screenshots and device logs are on by default; each can be turned off, network capture on', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: { startTest: { jobId: 'j' }, endTest: {} },
      driverOptions: { _currentTest: running(), artifacts: { video: false, networkCapture: true } },
    });
    await connectAndDisconnect(driver);

    expect((calls(restCalls, 'startTest')[0].args[1] as { artifacts: unknown }).artifacts)
      .toEqual({ video: false, screenshots: true, deviceLogs: true, networkCapture: true });
  });

  test('a failed or timed-out test is reported as failed; a retry is named as such', async () => {
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android', restResponses: { startTest: { jobId: 'j' }, endTest: {} },
      driverOptions: { _currentTest: running({ status: 'timedOut', retry: 1 }) },
    });
    await connectAndDisconnect(driver);

    expect((calls(restCalls, 'startTest')[0].args[1] as { testName: string }).testName).toBe('login.spec.ts › login › signs in (retry 1)');
    expect(calls(restCalls, 'endTest')[0].args[1]).toBe('failed');
  });

  test('a test expected to fail that fails counts as passed; a skipped test gets no result', async () => {
    const expectedFailure = createDriverWithSession({
      platform: 'android', restResponses: { startTest: { jobId: 'j' }, endTest: {} },
      driverOptions: { _currentTest: running({ status: 'failed', expectedStatus: 'failed' }) },
    });
    await connectAndDisconnect(expectedFailure.driver);
    expect(calls(expectedFailure.restCalls, 'endTest')[0].args[1]).toBe('passed');

    const skipped = createDriverWithSession({
      platform: 'android', restResponses: { startTest: { jobId: 'j' }, endTest: {} },
      driverOptions: { _currentTest: running({ status: 'skipped' }) },
    });
    await connectAndDisconnect(skipped.driver);
    expect(calls(skipped.restCalls, 'endTest')[0].args[1]).toBeUndefined();
  });

  test('nothing is reported outside a Playwright test, or with reportTests: false', async () => {
    const outside = createDriverWithSession({ platform: 'android', driverOptions: { _currentTest: () => undefined } });
    await connectAndDisconnect(outside.driver);
    expect(calls(outside.restCalls, 'startTest')).toEqual([]);

    const disabled = createDriverWithSession({ platform: 'android', driverOptions: { _currentTest: running(), reportTests: false } });
    await connectAndDisconnect(disabled.driver);
    expect(calls(disabled.restCalls, 'startTest')).toEqual([]);
    expect(calls(disabled.restCalls, 'endTest')).toEqual([]);
  });

  test('a test still active on the session (409) is ended before starting the new one', async () => {
    let attempts = 0;
    const { driver, restCalls } = createDriverWithSession({
      platform: 'android',
      restResponses: {
        startTest: async () => {
          if (attempts++ === 0) throw new SauceApiError('POST /sessions/s/startTest failed: 409 Conflict', 409, { title: 'Conflict' });
          return { jobId: 'job-2' };
        },
        endTest: {},
      },
      driverOptions: { _currentTest: running() },
    });
    await (driver as any).startReportedTest();

    expect(restCalls.map((c) => c.method)).toEqual(['startTest', 'endTest', 'startTest']);
    expect((driver as any).session.reportedTest).toEqual({ name: 'login.spec.ts › login › signs in', jobId: 'job-2' });
  });

  test('reporting errors never fail the test', async () => {
    const { driver } = createDriverWithSession({
      platform: 'android',
      restResponses: { startTest: new Error('Sauce Labs is down'), endTest: new Error('still down') },
      driverOptions: { _currentTest: running() },
    });
    await expect(connectAndDisconnect(driver)).resolves.toBeUndefined();
  });
});

test.describe('Android hierarchy while hosted Appium (webViewBridge) runs', () => {
  const appiumSource = `<?xml version="1.0"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" enabled="true">
    <android.widget.TextView class="android.widget.TextView" text="Example Domain" bounds="[0,100][1080,200]" enabled="true" />
  </android.widget.FrameLayout>
</hierarchy>`;
  const flatten = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);

  test('falls back to Appium\'s page source when uiautomator dump returns nothing', async () => {
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: '' } });
    (driver as any).session.webViews = { active: true, nativeSource: async () => appiumSource };

    const texts = flatten(await driver.getViewHierarchy()).map((n) => n.text).filter(Boolean);
    expect(texts).toEqual(['Example Domain']);
  });

  test('reports the page root nested in a WebView as a plain view, so there is one web view', async () => {
    const source = `<?xml version="1.0"?><hierarchy>
      <node class="android.webkit.WebView" resource-id="app:id/webview" bounds="[0,290][1080,2274]">
        <node class="android.webkit.WebView" text="" bounds="[0,290][1080,2275]">
          <node class="android.widget.Button" text="Sign in" bounds="[10,300][200,400]" />
        </node>
      </node></hierarchy>`;
    const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: '' } });
    (driver as any).session.webViews = { active: true, nativeSource: async () => source };

    const nodes = flatten(await driver.getViewHierarchy());
    expect(nodes.filter((n) => n.type === 'android.webkit.WebView').map((n) => n.identifier)).toEqual(['app:id/webview']);
    expect(nodes.map((n) => n.text)).toContain('Sign in');
  });

  test('does not touch Appium when uiautomator dump works, or when no Appium session runs', async () => {
    let sourceCalls = 0;
    const dump = '<?xml version="1.0"?><hierarchy><node class="android.widget.TextView" text="native" bounds="[0,0][10,10]" /></hierarchy>';
    const working = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: dump } });
    (working.driver as any).session.webViews = { active: true, nativeSource: async () => { sourceCalls++; return appiumSource; } };
    await working.driver.getViewHierarchy();

    const idle = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: '' } });
    (idle.driver as any).session.webViews = { active: false, nativeSource: async () => { sourceCalls++; return appiumSource; } };
    expect(await idle.driver.getViewHierarchy()).toEqual([]);

    expect(sourceCalls).toBe(0);
  });
});

test('parseAndroidDisplaySize() reads the real display size from dumpsys window displays', () => {
  // Pixel 9 Pro XL, Android 16: the device catalog lists 1344x2922.
  const dumpsys = `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=9
    init=504x1120 1dpi cur=504x1120 app=504x1120
  Display: mDisplayId=0 (organized)
    init=1008x2244 360dpi base=1344x2992 cur=1008x2244 app=1008x2244 rng=1008x907-2244x2143`;
  // The default display (0) is used even when another display is listed first.
  expect(parseAndroidDisplaySize(dumpsys)).toEqual({ width: 1008, height: 2244 });
  expect(parseAndroidDisplaySize('no sizes here')).toBeUndefined();
});

test('the Android hierarchy reads text with quotes and XML entities as it is on screen', async () => {
  // uiautomator dump single-quotes a value containing ", and escapes & as &amp;.
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
  <node class="android.widget.EditText" text='say "hi"' resource-id="app:id/quote" bounds="[0,0][100,50]" />
  <node class="android.widget.TextView" text="Tom &amp; Jerry &lt;3" resource-id="app:id/amp" bounds="[0,50][100,100]" />
</hierarchy>`;
  const { driver } = createDriverWithSession({ platform: 'android', restResponses: { executeShellCommand: xml } });
  const nodes = (await driver.getViewHierarchy()).flatMap((n) => n.children);

  expect(nodes.map((n) => [n.identifier, n.text])).toEqual([['app:id/quote', 'say "hi"'], ['app:id/amp', 'Tom & Jerry <3']]);
});

test('a WebSocket handshake refused with a 5xx, or failing on the network, is retried; other errors are not', async () => {
  let attempts = 0;
  const flaky = async () => {
    if (attempts++ < 2) throw new Error('Companion socket failed to connect: Unexpected server response: 503');
  };
  await withoutRealSleeps(() => connectRetryingGatewayErrors(flaky));
  expect(attempts).toBe(3);

  let dnsFailures = 0;
  await withoutRealSleeps(() => connectRetryingGatewayErrors(async () => {
    if (dnsFailures++ === 0) throw new Error('device control socket failed to connect: getaddrinfo ENOTFOUND api.us-west-1.saucelabs.com');
  }));
  expect(dnsFailures).toBe(2);

  let refused = 0;
  const unauthorized = async () => {
    refused++;
    throw new Error('Companion socket failed to connect: Unexpected server response: 401');
  };
  await expect(connectRetryingGatewayErrors(unauthorized)).rejects.toThrow('401');
  expect(refused).toBe(1);
});

test('an Android dump that prints no hierarchy (screen still animating) is retried instead of read as an empty screen', async () => {
  const outputs = [
    'ERROR: could not get idle state.\n',
    '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0"><node class="android.widget.Button" text="Go" resource-id="app:id/go" bounds="[0,0][100,50]" /></hierarchy>',
  ];
  const { driver, restCalls } = createDriverWithSession({
    platform: 'android',
    restResponses: { executeShellCommand: async () => outputs.shift() ?? '' },
  });

  const nodes = await withoutRealSleeps(() => driver.getViewHierarchy());

  expect(nodes.flatMap((n) => [n, ...n.children]).map((n) => n.identifier)).toContain('app:id/go');
  expect(restCalls.filter((c) => c.method === 'executeShellCommand')).toHaveLength(2);
});

test('a second connect() is refused instead of dropping the first session', async () => {
  const { driver } = createDriverWithSession({ platform: 'android' });
  await expect(driver.connect({ platform: 'android' })).rejects.toThrow('Already connected');
});

test('package names are checked before they go into a shell command', async () => {
  expect(androidPackage('com.example.app_2')).toBe('com.example.app_2');
  for (const bad of ['com.example; rm -rf /', 'com.example app', '$(reboot)', '']) {
    expect(() => androidPackage(bad)).toThrow('Not a valid Android package name');
  }
  const { driver, restCalls } = createDriverWithSession({ platform: 'android' });
  await expect(driver.terminateApp('x; reboot')).rejects.toThrow('Not a valid Android package name');
  expect(restCalls.some((c) => c.method === 'executeShellCommand')).toBe(false);
});

test('allocated sessions are tracked until released, and deleted when the process is interrupted', async () => {
  const { driver } = createDriverWithFakeRest({
    createSession: { id: 'sess-tracked', state: 'PENDING' },
    getSession: ACTIVE_SESSION,
    deleteSession: undefined,
  });
  await withoutRealSleeps(() => driver.allocate({ platform: 'android' }, new Set()));
  expect(openSessions.has('sess-tracked')).toBe(true);
  await driver.release('sess-tracked');
  expect(openSessions.has('sess-tracked')).toBe(false);

  const deleted: string[] = [];
  openSessions.set('sess-a', { deleteSession: async (id: string) => { deleted.push(id); } } as never);
  openSessions.set('sess-b', { deleteSession: async () => { throw new Error('network down'); } } as never);
  // Another handler for the signal stands in for the test runner's, so the process isn't killed.
  const keepAlive = () => {};
  process.on('SIGUSR2', keepAlive);
  try {
    await cleanUpOnSignal('SIGUSR2');
  } finally {
    process.off('SIGUSR2', keepAlive);
  }
  expect(deleted).toEqual(['sess-a']);
  expect(openSessions.size).toBe(0);
});
