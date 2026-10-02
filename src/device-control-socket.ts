import createDebug from 'debug';
import WebSocket from 'ws';
import { basicAuth } from './util.js';
import { WS_CLOSE_NORMAL, closeWebSocket, openWebSocket } from './websocket.js';

const debug = createDebug('mw:mobilewright-driver:io');

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1_000;

export interface TouchPoint {
  x: number;
  y: number;
  index: number;
}

/**
 * The session's device-control WebSocket: touches and keys out. It also streams the screen (MJPEG frames), which
 * the driver only acknowledges: Sauce Labs records the video.
 * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-device-control-socket/
 */
export class DeviceControlSocket {
  private ws: WebSocket | null = null;
  readonly #authHeader: string;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    username: string,
    accessKey: string,
  ) {
    this.#authHeader = basicAuth(username, accessKey);
  }

  /** Connects, and reconnects on unexpected disconnects until disconnect(). */
  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    this.ws = await openWebSocket(this.url, this.#authHeader, 'device control socket', debug, (ws) => {
      ws.on('message', (_data: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) return;
        // Each frame must be acknowledged, or the stream stops.
        if (ws.readyState === WebSocket.OPEN) ws.send('n/');
      });
      ws.on('close', (code: number) => {
        debug('device control socket closed (code=%d)', code);
        if (this.ws === ws) this.ws = null;
        if (!this.closed && code !== WS_CLOSE_NORMAL) this.scheduleReconnect();
      });
    });
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      debug('device control socket: max reconnect attempts reached');
      return;
    }
    const delay = RECONNECT_BASE_MS * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;
    debug('device control socket: reconnecting in %dms (attempt %d)', delay, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket().catch((err) => {
        debug('reconnect failed: %s', (err as Error).message);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) await closeWebSocket(ws);
  }

  // ─── Touch and keys ───────────────────────────────────────────────────────

  /** Sends a touch action (down/move/up) with one or more contact points. */
  sendTouch(
    action: 'd' | 'm' | 'u',
    points: TouchPoint[],
    canvasW: number,
    canvasH: number,
    orientation: 0 | 1,
  ): void {
    const parts: string[] = [`mt/${action}`, String(canvasW), String(canvasH), String(orientation), String(points.length)];
    for (const p of points) {
      parts.push(String(p.index), String(Math.round(p.x)), String(Math.round(p.y)));
    }
    this.send(parts.join(' '));
  }

  /** Sends a key; typed characters are masked in the debug log, named keys (`Enter`, …) are not. */
  sendKey(key: string): void {
    this.send(`tt/${key}`, `tt/${key.length === 1 ? '*' : key}`);
  }

  private send(msg: string, logged = msg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Device control socket is not connected');
    }
    debug('send %s', logged);
    ws.send(msg);
  }
}
