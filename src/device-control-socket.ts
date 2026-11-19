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
  /** The socket being opened, shared by the background reconnects and send(). */
  private opening: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    username: string,
    accessKey: string,
  ) {
    this.#authHeader = basicAuth(username, accessKey);
  }

  /**
   * Connects. After an unexpected close it reconnects in the background (5 attempts, 1s to 16s apart); once those
   * fail, the next send reconnects first. disconnect() ends both.
   */
  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    this.opening ??= this.doOpenSocket().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpenSocket(): Promise<void> {
    const ws = await openWebSocket(this.url, this.#authHeader, 'device control socket', debug, (ws) => {
      ws.on('message', (_data: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) return;
        // Each frame must be acknowledged, or the stream stops.
        if (ws.readyState === WebSocket.OPEN) ws.send('n/');
      });
      ws.on('close', (code: number) => {
        debug('device control socket closed (code=%d)', code);
        if (this.ws !== ws) return;
        this.ws = null;
        if (!this.closed && code !== WS_CLOSE_NORMAL) this.scheduleReconnect();
      });
    });
    if (this.closed) {
      // disconnect() ran while this socket was opening.
      await closeWebSocket(ws);
      throw new Error('Device control socket was disconnected');
    }
    this.ws = ws;
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      debug('device control socket: max reconnect attempts reached; the next send reconnects');
      return;
    }
    const delay = RECONNECT_BASE_MS * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;
    debug('device control socket: reconnecting in %dms (attempt %d)', delay, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.isOpen()) return;
      this.openSocket().catch((err) => {
        debug('reconnect failed: %s', (err as Error).message);
        if (!this.closed && !this.isOpen()) this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
  async sendTouch(
    action: 'd' | 'm' | 'u',
    points: TouchPoint[],
    canvasW: number,
    canvasH: number,
    orientation: 0 | 1,
  ): Promise<void> {
    const parts: string[] = [`mt/${action}`, String(canvasW), String(canvasH), String(orientation), String(points.length)];
    for (const p of points) {
      parts.push(String(p.index), String(Math.round(p.x)), String(Math.round(p.y)));
    }
    await this.send(parts.join(' '));
  }

  /** Sends a key; typed characters are masked in the debug log, named keys (`Enter`, …) are not. */
  async sendKey(key: string): Promise<void> {
    await this.send(`tt/${key}`, `tt/${key.length === 1 ? '*' : key}`);
  }

  private async send(msg: string, logged = msg): Promise<void> {
    if (!this.isOpen()) await this.reconnectNow();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Device control socket is not connected');
    }
    debug('send %s', logged);
    ws.send(msg);
  }

  /**
   * Opens the socket before a send: joins a reconnect in progress, or starts one at once instead of waiting for
   * the next background attempt. The handshake gives up after 30s; the send after that tries again.
   */
  private async reconnectNow(): Promise<void> {
    if (this.closed) throw new Error('Device control socket is not connected');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.opening) debug('device control socket: reconnecting before sending');
    try {
      await this.openSocket();
    } catch (err) {
      throw new Error(`Device control socket is not connected: ${(err as Error).message}`);
    }
  }
}
