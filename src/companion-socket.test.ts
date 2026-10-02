import { test, expect } from '@playwright/test';
import createDebug from 'debug';
import { CompanionSocket } from './companion-socket.js';

// Exercise the private message parser without opening a real WebSocket.
function sendMessage(socket: CompanionSocket, msg: unknown): void {
  (socket as any).handleMessage(JSON.stringify(msg));
}

function createSocket() {
  return new CompanionSocket('wss://fake', 'user', 'key');
}

// ─── Device logs ──────────────────────────────────────────────────────────────

test('device log lines go to their own debug namespace, outside mw:*', () => {
  const socket = createSocket();
  const printed: string[] = [];
  const originalLog = createDebug.log;
  const previouslyEnabled = createDebug.disable();
  createDebug.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    createDebug.enable('mw:*');
    sendMessage(socket, { type: 'device.log.message', value: { message: 'hello from logcat' } });
    expect(printed.some((line) => line.includes('hello from logcat'))).toBe(false);

    createDebug.enable('mobilewright-driver:device-log');
    sendMessage(socket, { type: 'device.log.message', value: { message: 'hello from logcat' } });
    expect(printed.some((line) => line.includes('hello from logcat'))).toBe(true);
  } finally {
    createDebug.log = originalLog;
    createDebug.enable(previouslyEnabled);
  }
});

// ─── Robustness ───────────────────────────────────────────────────────────────

test('silently ignores malformed JSON', () => {
  const socket = createSocket();
  expect(() => {
    (socket as any).handleMessage('not valid json {{{');
  }).not.toThrow();
});
