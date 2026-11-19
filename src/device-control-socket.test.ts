import { test, expect } from '@playwright/test';
import { WebSocketServer, type WebSocket } from 'ws';
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
  test('produces correct mt/d message for a single portrait touch', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch('d', [{ x: 540, y: 960, index: 0 }], 1080, 1920, 0);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('mt/d 1080 1920 0 1 0 540 960');
  });

  test('produces correct mt/u message for touch up', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch('u', [{ x: 540, y: 960, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/u 1080 1920 0 1 0 540 960');
  });

  test('produces correct mt/m message for touch move', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch('m', [{ x: 300, y: 500, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/m 1080 1920 0 1 0 300 500');
  });

  test('sets orientation flag to 1 for landscape', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch('d', [{ x: 960, y: 540, index: 0 }], 1920, 1080, 1);

    expect(sent[0]).toBe('mt/d 1920 1080 1 1 0 960 540');
  });

  test('rounds fractional coordinates', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch('d', [{ x: 540.6, y: 960.4, index: 0 }], 1080, 1920, 0);

    expect(sent[0]).toBe('mt/d 1080 1920 0 1 0 541 960');
  });

  test('encodes two touch points for multi-touch', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendTouch(
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
  test('produces tt/a for letter a', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendKey('a');
    expect(sent[0]).toBe('tt/a');
  });

  test('produces tt/Enter for Enter key', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendKey('Enter');
    expect(sent[0]).toBe('tt/Enter');
  });

  test('produces tt/Backspace for Backspace key', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendKey('Backspace');
    expect(sent[0]).toBe('tt/Backspace');
  });

  test('produces tt/Sauce_Home_Key for home navigation', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendKey('Sauce_Home_Key');
    expect(sent[0]).toBe('tt/Sauce_Home_Key');
  });

  test('produces tt/Sauce_Back_Key for back navigation', async () => {
    const { socket, sent } = createConnectedSocket();
    await socket.sendKey('Sauce_Back_Key');
    expect(sent[0]).toBe('tt/Sauce_Back_Key');
  });
});


// ─── Reconnecting ─────────────────────────────────────────────────────────────

/** A local device-control server that records each connection and its text messages. */
async function startServer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const connections: WebSocket[] = [];
  const messages: string[] = [];
  server.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (data) => messages.push(data.toString()));
  });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as { port: number };
  const stop = () => new Promise<void>((resolve) => {
    for (const ws of server.clients) ws.terminate();
    server.close(() => resolve());
  });
  return { url: `ws://127.0.0.1:${port}`, connections, messages, stop };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.describe('DeviceControlSocket reconnects', () => {
  test('a send reconnects once background reconnects have given up', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      (socket as any).reconnectAttempts = 5; // all background attempts used
      server.connections[0].terminate();
      await waitFor(() => (socket as any).ws === null);
      expect((socket as any).reconnectTimer).toBeNull();

      await socket.sendKey('a');
      await waitFor(() => server.messages.includes('tt/a'));
      expect(server.connections).toHaveLength(2);
    } finally {
      await socket.disconnect();
      await server.stop();
    }
  });

  test('a send reconnects after the server closes the socket normally', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      server.connections[0].close(1000);
      await waitFor(() => (socket as any).ws === null);

      await socket.sendTouch('d', [{ x: 1, y: 2, index: 0 }], 100, 200, 0);
      await waitFor(() => server.messages.includes('mt/d 100 200 0 1 0 1 2'));
      expect(server.connections).toHaveLength(2);
    } finally {
      await socket.disconnect();
      await server.stop();
    }
  });

  test('a send doesn\'t wait for the next background attempt', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      (socket as any).reconnectAttempts = 4; // next background attempt in 16s
      server.connections[0].terminate();
      await waitFor(() => (socket as any).reconnectTimer !== null);

      const started = Date.now();
      await socket.sendKey('Enter');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((socket as any).reconnectTimer).toBeNull();
      await waitFor(() => server.messages.includes('tt/Enter'));
      expect(server.connections).toHaveLength(2);
    } finally {
      await socket.disconnect();
      await server.stop();
    }
  });

  test('concurrent sends share one reconnect', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      server.connections[0].close(1000);
      await waitFor(() => (socket as any).ws === null);

      await Promise.all([socket.sendKey('a'), socket.sendKey('b')]);
      await waitFor(() => server.messages.length === 2);
      expect(server.connections).toHaveLength(2);
    } finally {
      await socket.disconnect();
      await server.stop();
    }
  });

  test('a send fails clearly when reconnecting fails, and the next send tries again', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    const port = Number(new URL(server.url).port);
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      (socket as any).reconnectAttempts = 5;
      await server.stop();
      await waitFor(() => (socket as any).ws === null);

      await expect(socket.sendKey('a')).rejects.toThrow(/not connected: device control socket failed to connect/);

      const again = new WebSocketServer({ port, host: '127.0.0.1' });
      const received = new Promise<string>((resolve) => again.on('connection', (ws) => ws.on('message', (d) => resolve(d.toString()))));
      await new Promise<void>((resolve) => again.on('listening', resolve));
      try {
        await socket.sendKey('b');
        expect(await received).toBe('tt/b');
      } finally {
        await socket.disconnect();
        await new Promise<void>((resolve) => {
          for (const ws of again.clients) ws.terminate();
          again.close(() => resolve());
        });
      }
    } finally {
      await socket.disconnect();
    }
  });

  test('sends after disconnect() throw without reconnecting', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await socket.disconnect();
      await expect(socket.sendKey('a')).rejects.toThrow('not connected');
      await expect(socket.sendTouch('d', [{ x: 0, y: 0, index: 0 }], 1080, 1920, 0)).rejects.toThrow('not connected');
      expect(server.connections).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test('disconnect() while reconnecting closes the new socket', async () => {
    const server = await startServer();
    const socket = new DeviceControlSocket(server.url, 'user', 'key');
    try {
      await socket.connect();
      await waitFor(() => server.connections.length === 1);
      server.connections[0].close(1000);
      await waitFor(() => (socket as any).ws === null);

      const send = socket.sendKey('a');
      await socket.disconnect();
      await expect(send).rejects.toThrow('not connected');
      expect((socket as any).ws).toBeNull();
      await waitFor(() => server.connections.every((ws) => ws.readyState === ws.CLOSED));
      expect(server.messages).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
