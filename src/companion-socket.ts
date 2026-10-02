import createDebug from 'debug';
import type WebSocket from 'ws';
import { basicAuth } from './util.js';
import { closeWebSocket, openWebSocket } from './websocket.js';

const debug = createDebug('mw:mobilewright-driver:companion');
/** Device log lines are many per second, so they get their own namespace outside `mw:*`. */
const debugDeviceLog = createDebug('mobilewright-driver:device-log');

/**
 * The session's events WebSocket: device events and device log lines.
 * https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-mastering-companion-socket/
 */
export class CompanionSocket {
  private ws: WebSocket | null = null;
  readonly #authHeader: string;

  constructor(
    private readonly url: string,
    username: string,
    accessKey: string,
  ) {
    this.#authHeader = basicAuth(username, accessKey);
  }

  async connect(): Promise<void> {
    this.ws = await openWebSocket(this.url, this.#authHeader, 'companion socket', debug, (ws) => {
      ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data.toString()));
      ws.on('close', (code: number) => {
        debug('companion socket closed (code=%d)', code);
        if (this.ws === ws) this.ws = null;
      });
    });
  }

  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (ws) await closeWebSocket(ws);
  }

  private handleMessage(raw: string): void {
    let msg: { type?: string; value?: { message?: unknown } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'device.log.message') {
      debugDeviceLog('%s', typeof msg.value?.message === 'string' ? msg.value.message : JSON.stringify(msg.value));
      return;
    }
    debug('companion event %s', msg.type);
  }
}
