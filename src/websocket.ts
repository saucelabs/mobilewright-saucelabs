import WebSocket from 'ws';
import { USER_AGENT } from './util.js';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
export const WS_CLOSE_NORMAL = 1000;

/**
 * Opens a WebSocket authenticated with `authHeader`. `listen` attaches the message and close handlers before
 * the connection opens. Rejects if the handshake fails or takes longer than 30s.
 */
export function openWebSocket(
  url: string,
  authHeader: string,
  name: string,
  log: (format: string, ...args: unknown[]) => void,
  listen: (ws: WebSocket) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    let opened = false;
    listen(ws);
    ws.once('open', () => {
      opened = true;
      log('%s connected', name);
      resolve(ws);
    });
    // Kept for the socket's whole life: an 'error' event without a listener would crash the process.
    ws.on('error', (err) => {
      log('%s error: %s', name, err.message);
      if (!opened) reject(new Error(`${name} failed to connect: ${err.message}`));
    });
  });
}

/** Closes a WebSocket, terminating it if the close handshake doesn't finish in time (5s). */
export function closeWebSocket(ws: WebSocket, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, timeoutMs);
    timer.unref();
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close(WS_CLOSE_NORMAL);
  });
}
