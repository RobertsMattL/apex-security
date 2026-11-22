import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthService, Principal } from '../auth/AuthService.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import type { DeliveryTransport } from '../notifications/types.js';
import type { Bus } from '../util/bus.js';
import { logger } from '../util/log.js';

const log = logger('ws');

interface Client {
  ws: WebSocket;
  principal: Principal;
  alive: boolean;
  connectedAt: number;
}

export interface GatewayOptions {
  path?: string;
  heartbeatMs?: number;
}

/**
 * WebSocket Gateway (ws://host/ws?token=<access token> or Authorization: Bearer).
 *
 * Server -> client:  welcome, notification, notification.read, camera.status,
 *                    camera.upserted, camera.removed, settings.updated, event, pong, error
 * Client -> server:  hello, ack {ids}, read {ids}, ping
 *
 * One live socket per device (a new connection replaces the old one). Liveness is
 * checked with protocol-level pings; a client that misses two is terminated, and its
 * unacknowledged notifications are flushed again when it reconnects.
 */
export class Gateway implements DeliveryTransport {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private clients = new Map<string, Client>();
  private heartbeat?: NodeJS.Timeout;
  private path: string;

  constructor(
    private auth: AuthService,
    private notifications: NotificationService,
    private bus: Bus,
    private opts: GatewayOptions = {},
  ) {
    this.path = opts.path ?? '/ws';
    bus.on('camera.status', (cameraId, status) => this.broadcast({ t: 'camera.status', cameraId, status }));
    bus.on('camera.upserted', (camera) => this.broadcast({ t: 'camera.upserted', camera }));
    bus.on('camera.removed', (cameraId) => this.broadcast({ t: 'camera.removed', cameraId }));
    bus.on('settings.updated', (cameraId, settings) => this.broadcast({ t: 'settings.updated', cameraId, settings }));
    bus.on('event.created', (e) => this.broadcast({ t: 'event', event: e }));
    bus.on('events.deleted', (eventIds, notificationIds) => this.broadcast({ t: 'events.deleted', eventIds, notificationIds }));
    bus.on('notification.read', (id, userId, readAt) => {
      for (const c of this.clients.values()) if (c.principal.userId === userId) this.write(c, { t: 'notification.read', id, readAt });
    });
  }

  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket, head));
    const interval = this.opts.heartbeatMs ?? 15000;
    this.heartbeat = setInterval(() => this.checkLiveness(), interval);
    this.heartbeat.unref();
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== this.path) return; // not ours (another upgrade handler may take it)
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const token = bearer || url.searchParams.get('token') || '';
    let principal: Principal;
    try {
      principal = await this.auth.verifyAccess(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, principal, req));
  }

  private onConnection(ws: WebSocket, principal: Principal, req: IncomingMessage) {
    const prev = this.clients.get(principal.deviceId);
    if (prev) prev.ws.close(4000, 'replaced by a newer connection');
    const client: Client = { ws, principal, alive: true, connectedAt: Date.now() };
    this.clients.set(principal.deviceId, client);
    this.auth.touchDevice(principal.deviceId);
    log.info(`device ${principal.deviceId.slice(0, 8)} connected from ${req.socket.remoteAddress} (${this.clients.size} online)`);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      let msg: { t?: string; ids?: unknown; id?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.write(client, { t: 'error', error: 'invalid JSON' });
      }
      this.onMessage(client, msg);
    });
    ws.on('close', () => {
      if (this.clients.get(principal.deviceId) === client) this.clients.delete(principal.deviceId);
      log.info(`device ${principal.deviceId.slice(0, 8)} disconnected (${this.clients.size} online)`);
    });
    ws.on('error', (e) => log.warn(`socket error ${principal.deviceId.slice(0, 8)}`, e));

    this.write(client, {
      t: 'welcome',
      deviceId: principal.deviceId,
      serverTime: Date.now(),
      unread: this.notifications.unreadCount(principal.deviceId),
      heartbeatMs: this.opts.heartbeatMs ?? 15000,
    });
    this.notifications.onDeviceConnected(principal.deviceId);
  }

  private onMessage(client: Client, msg: { t?: string; ids?: unknown; id?: unknown }) {
    const ids = (Array.isArray(msg.ids) ? msg.ids : msg.id !== undefined ? [msg.id] : []).filter((x): x is string => typeof x === 'string').slice(0, 500);
    switch (msg.t) {
      case 'hello':
        // Explicit resume request (e.g. after the app restores state). Anything sent in the
        // last few seconds (the on-connect flush) is still in flight, so don't double-send it.
        this.notifications.onDeviceConnected(client.principal.deviceId, { skipSentWithinMs: 5000 });
        break;
      case 'ack':
        this.notifications.ack(client.principal.deviceId, ids);
        this.write(client, { t: 'ack.ok', ids });
        break;
      case 'read':
        // A read implies receipt on this device.
        this.notifications.ack(client.principal.deviceId, ids);
        this.notifications.markRead(client.principal.userId, ids);
        this.write(client, { t: 'read.ok', ids });
        break;
      case 'ping':
        this.write(client, { t: 'pong', serverTime: Date.now() });
        break;
      default:
        this.write(client, { t: 'error', error: `unknown message type ${msg.t}` });
    }
  }

  private checkLiveness() {
    for (const [deviceId, c] of this.clients) {
      if (!c.alive) {
        log.warn(`device ${deviceId.slice(0, 8)} missed heartbeat; terminating`);
        c.ws.terminate();
        this.clients.delete(deviceId);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* closing */
      }
    }
  }

  private write(c: Client, msg: unknown): boolean {
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    try {
      c.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(msg: unknown) {
    for (const c of this.clients.values()) this.write(c, msg);
  }

  disconnectDevice(deviceId: string) {
    this.clients.get(deviceId)?.ws.close(4001, 'device revoked');
  }

  // DeliveryTransport
  connectedDevices() {
    return [...this.clients.keys()];
  }

  isConnected(deviceId: string) {
    return this.clients.get(deviceId)?.ws.readyState === WebSocket.OPEN;
  }

  send(deviceId: string, msg: unknown) {
    const c = this.clients.get(deviceId);
    return c ? this.write(c, msg) : false;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients.values()) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }
}
