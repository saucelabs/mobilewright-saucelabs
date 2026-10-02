import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { test, expect } from '@playwright/test';
import WebSocket, { WebSocketServer } from 'ws';
import { USER_AGENT } from './util.js';
import { closeWebSocket, openWebSocket } from './websocket.js';

/** A fake WebSocket that records close() / terminate() and emits 'close' only when told to. */
function fakeSocket(closesOnRequest: boolean) {
  const ws = new EventEmitter() as EventEmitter & { readyState: number; close(): void; terminate(): void; calls: string[] };
  ws.readyState = WebSocket.OPEN;
  ws.calls = [];
  ws.close = () => {
    ws.calls.push('close');
    if (closesOnRequest) setImmediate(() => ws.emit('close'));
  };
  ws.terminate = () => { ws.calls.push('terminate'); };
  return ws;
}

test('closeWebSocket resolves once the socket closes', async () => {
  const ws = fakeSocket(true);
  await closeWebSocket(ws as unknown as WebSocket, 1_000);
  expect(ws.calls).toEqual(['close']);
});

test('closeWebSocket terminates a socket whose close handshake never finishes', async () => {
  const ws = fakeSocket(false);
  await closeWebSocket(ws as unknown as WebSocket, 20);
  expect(ws.calls).toEqual(['close', 'terminate']);
});

test('openWebSocket sends the credentials and the driver\'s User-Agent', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const headers = new Promise<Record<string, string | string[] | undefined>>((resolve) => server.on('connection', (_ws, req) => resolve(req.headers)));
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const ws = await openWebSocket(`ws://127.0.0.1:${port}`, 'Basic x', 'test socket', () => {}, () => {});
    expect(await headers).toMatchObject({ 'authorization': 'Basic x', 'user-agent': USER_AGENT });
    expect(USER_AGENT).toMatch(/^saucelabs-mobilewright-driver\/\d+\.\d+\.\d+/);
    await closeWebSocket(ws, 1_000);
  } finally {
    server.close();
  }
});

test('openWebSocket rejects when the connection fails', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await expect(openWebSocket(`ws://127.0.0.1:${port}`, 'Basic x', 'test socket', () => {}, () => {}))
      .rejects.toThrow('test socket failed to connect');
  } finally {
    server.close();
  }
});
