import { test, expect } from '@playwright/test';
import { DeviceControlSocket } from './device-control-socket.js';

// Inject a pre-connected fake ws so tests don't need a real server.
function createConnectedSocket() {
  const sent: string[] = [];
  const socket = new DeviceControlSocket('wss://fake', 'user', 'key');
  (socket as any).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (msg: string) => sent.push(msg),
  };
  return { socket, sent };
}

// ─── sendTouch ───────────────────────────────────────────────────────────────

test.describe('DeviceControlSocket.sendTouch()', () => {
  test('produces correct mt/d message for a single portrait touch', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch('d', [{ x: 540, y: 960, index: 0 }], 1080, 1920, 0);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('mt/d 1080 1920 0 1 0 540 960');
  });

  test('produces correct mt/u message for touch up', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch('u', [{ x: 540, y: 960, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/u 1080 1920 0 1 0 540 960');
  });

  test('produces correct mt/m message for touch move', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch('m', [{ x: 300, y: 500, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/m 1080 1920 0 1 0 300 500');
  });

  test('sets orientation flag to 1 for landscape', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch('d', [{ x: 960, y: 540, index: 0 }], 1920, 1080, 1);

    expect(sent[0]).toBe('mt/d 1920 1080 1 1 0 960 540');
  });

  test('rounds fractional coordinates', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch('d', [{ x: 540.6, y: 960.4, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/d 1080 1920 0 1 0 541 960');
  });

  test('encodes two touch points for multi-touch', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendTouch(
      'd',
      [{ x: 150, y: 300, index: 0 }, { x: 210, y: 340, index: 1 }],
      360,
      640,
      0,
    );

    expect(sent[0]).toBe('mt/d 360 640 0 2 0 150 300 1 210 340');
  });
});

// ─── sendKey ─────────────────────────────────────────────────────────────────

test.describe('DeviceControlSocket.sendKey()', () => {
  test('produces tt/a for letter a', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendKey('a');
    expect(sent[0]).toBe('tt/a');
  });

  test('produces tt/Enter for Enter key', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendKey('Enter');
    expect(sent[0]).toBe('tt/Enter');
  });

  test('produces tt/Backspace for Backspace key', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendKey('Backspace');
    expect(sent[0]).toBe('tt/Backspace');
  });

  test('produces tt/Sauce_Home_Key for home navigation', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendKey('Sauce_Home_Key');
    expect(sent[0]).toBe('tt/Sauce_Home_Key');
  });

  test('produces tt/Sauce_Back_Key for back navigation', () => {
    const { socket, sent } = createConnectedSocket();
    socket.sendKey('Sauce_Back_Key');
    expect(sent[0]).toBe('tt/Sauce_Back_Key');
  });
});


// ─── Error when not connected ─────────────────────────────────────────────────

test('sendKey throws when socket is not connected', () => {
  const socket = new DeviceControlSocket('wss://fake', 'user', 'key');
  // ws is null — never connected
  expect(() => socket.sendKey('a')).toThrow('not connected');
});

test('sendTouch throws when socket is not connected', () => {
  const socket = new DeviceControlSocket('wss://fake', 'user', 'key');
  expect(() => socket.sendTouch('d', [{ x: 0, y: 0, index: 0 }], 1080, 1920, 0)).toThrow('not connected');
});
