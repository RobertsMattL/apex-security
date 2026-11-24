import { randomUUID } from 'node:crypto';
import type { CameraManager } from '../cameras/CameraManager.js';
import { tx, type DB } from '../db/database.js';
import type { ListenerRegistry } from '../detection/listeners/index.js';
import type { DetectionEvent, EventSink } from '../events/EventManager.js';
import type { Bus } from '../util/bus.js';
import { logger } from '../util/log.js';
import type { DeliveryState, DeliveryTransport, NotificationDto } from './types.js';

const log = logger('notify');

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** Unacknowledged deliveries older than this are marked expired. */
  expireAfterMs: number;
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 2000, maxMs: 5 * 60 * 1000, expireAfterMs: 7 * 24 * 3600 * 1000, jitter: 0.2 };

/** Delay before the attempt following attempt number `attempts` (1-based): base * 2^(n-1), capped. */
export function backoffMs(attempts: number, p: RetryPolicy = DEFAULT_RETRY, rand = Math.random): number {
  const raw = Math.min(p.baseMs * 2 ** Math.max(0, attempts - 1), p.maxMs);
  return Math.round(raw * (1 + (rand() * 2 - 1) * p.jitter));
}

interface DueRow {
  notification_id: string;
  device_id: string;
  attempts: number;
  state: DeliveryState;
}

/**
 * Notification Service: creates notifications for detection events and delivers them
 * reliably to every registered device.
 *
 *   pending   --send-->   delivered  --client ack-->  received  --client read-->  read
 *      ^                     |
 *      +---- no ack: resend with exponential backoff (bounded), and on reconnect
 *
 * All state is in SQLite, so pending deliveries survive restarts and disconnects.
 * Clients de-duplicate by notification id, so a resend never shows twice.
 */
export class NotificationService implements EventSink {
  private timer?: NodeJS.Timeout;
  private transport?: DeliveryTransport;

  constructor(
    private db: DB,
    private cameras: CameraManager,
    private registry: ListenerRegistry,
    private bus: Bus,
    private imageUrl: (eventId: string) => string,
    private policy: RetryPolicy = DEFAULT_RETRY,
    private now: () => number = Date.now,
  ) {}

  attach(transport: DeliveryTransport) {
    this.transport = transport;
  }

  start(tickMs = 1000) {
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  // ---- creation --------------------------------------------------------------

  onEvent(ev: DetectionEvent, notify: boolean) {
    if (!notify) return;
    const n = this.create(ev);
    if (n) this.dispatchNotification(n);
  }

  create(ev: DetectionEvent): string | null {
    const listener = this.registry.get(ev.kind);
    const cameraName = this.cameras.name(ev.cameraId);
    const title = `${(listener?.label ?? ev.kind).toUpperCase()} DETECTED`;
    const body = `${cameraName} · ${ev.label} ${(ev.confidence * 100).toFixed(0)}%`;
    const id = randomUUID();
    const now = this.now();
    const devices = this.db.prepare('SELECT id FROM devices WHERE revoked = 0').all() as Array<{ id: string }>;
    tx(this.db, () => {
      this.db
        .prepare('INSERT OR IGNORE INTO notifications (id, event_id, camera_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, ev.id, ev.cameraId, ev.kind, title, body, now);
      const ins = this.db.prepare("INSERT OR IGNORE INTO deliveries (notification_id, device_id, state, next_attempt_at) VALUES (?, ?, 'pending', ?)");
      for (const d of devices) ins.run(id, d.id, now);
    });
    log.info(`notification ${id.slice(0, 8)} "${title}" -> ${devices.length} device(s)`);
    this.bus.emit('notification.created', this.dto(id)!);
    return id;
  }

  // ---- delivery --------------------------------------------------------------

  private dispatchNotification(notificationId: string) {
    if (!this.transport) return;
    const rows = this.db
      .prepare("SELECT notification_id, device_id, attempts, state FROM deliveries WHERE notification_id = ? AND state IN ('pending', 'delivered')")
      .all(notificationId) as unknown as DueRow[];
    for (const r of rows) if (this.transport.isConnected(r.device_id)) this.attempt(r);
  }

  /** Called by the gateway when a device (re)connects: flush everything it hasn't acked. */
  onDeviceConnected(deviceId: string, opts: { skipSentWithinMs?: number } = {}) {
    const cutoff = this.now() - (opts.skipSentWithinMs ?? 0);
    const rows = this.db
      .prepare(`SELECT d.notification_id, d.device_id, d.attempts, d.state FROM deliveries d
                JOIN notifications n ON n.id = d.notification_id
                WHERE d.device_id = ? AND d.state IN ('pending', 'delivered')
                AND (d.last_sent_at IS NULL OR d.last_sent_at <= ?) ORDER BY n.created_at`)
      .all(deviceId, cutoff) as unknown as DueRow[];
    if (rows.length) log.info(`device ${deviceId.slice(0, 8)} connected: flushing ${rows.length} unacked`);
    for (const r of rows) this.attempt(r);
  }

  /** Periodic retry pass for connected devices whose deliveries are due. */
  tick() {
    if (!this.transport) return;
    const now = this.now();
    this.db
      .prepare(`UPDATE deliveries SET state = 'expired' WHERE state IN ('pending', 'delivered')
                AND notification_id IN (SELECT id FROM notifications WHERE created_at < ?)`)
      .run(now - this.policy.expireAfterMs);
    const connected = this.transport.connectedDevices();
    if (!connected.length) return;
    const rows = this.db
      .prepare(`SELECT notification_id, device_id, attempts, state FROM deliveries
                WHERE state IN ('pending', 'delivered') AND next_attempt_at <= ?
                AND device_id IN (${connected.map(() => '?').join(',')}) LIMIT 500`)
      .all(now, ...connected) as unknown as DueRow[];
    for (const r of rows) this.attempt(r);
  }

  private attempt(r: DueRow) {
    const n = this.dto(r.notification_id);
    if (!n) return;
    const sent = this.transport!.send(r.device_id, { t: 'notification', n });
    if (!sent) return; // socket gone; stays due and is flushed on reconnect
    const attempts = r.attempts + 1;
    const now = this.now();
    this.db
      .prepare(`UPDATE deliveries SET state = CASE WHEN state = 'pending' THEN 'delivered' ELSE state END,
                attempts = ?, last_sent_at = ?, next_attempt_at = ? WHERE notification_id = ? AND device_id = ?`)
      .run(attempts, now, now + backoffMs(attempts, this.policy), r.notification_id, r.device_id);
    if (attempts > 1) log.debug(`resend ${r.notification_id.slice(0, 8)} to ${r.device_id.slice(0, 8)} (attempt ${attempts})`);
  }

  // ---- receipts --------------------------------------------------------------

  /** Receipt ack: the device has the notification. Idempotent. */
  ack(deviceId: string, ids: string[]): number {
    const now = this.now();
    const stmt = this.db.prepare(
      "UPDATE deliveries SET state = 'received', received_at = ? WHERE device_id = ? AND notification_id = ? AND state IN ('pending', 'delivered', 'expired')",
    );
    let changed = 0;
    for (const id of ids) changed += Number(stmt.run(now, deviceId, id).changes);
    return changed;
  }

  /** Read receipt: the user viewed it. Marks it read on all of that user's devices. */
  markRead(userId: string, ids: string[]): string[] {
    const now = this.now();
    const done: string[] = [];
    tx(this.db, () => {
      const stmt = this.db.prepare(
        `UPDATE deliveries SET state = 'read', read_at = ?, received_at = COALESCE(received_at, ?)
         WHERE notification_id = ? AND state != 'read' AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
      );
      for (const id of ids) if (Number(stmt.run(now, now, id, userId).changes) > 0) done.push(id);
    });
    for (const id of done) this.bus.emit('notification.read', id, userId, now);
    return done;
  }

  // ---- queries ---------------------------------------------------------------

  dto(id: string, deviceId?: string): NotificationDto | undefined {
    const r = this.db
      .prepare(`SELECT n.*, e.label, e.confidence, e.image_path, c.name AS camera_name
                ${deviceId ? ', d.state, d.read_at' : ''}
                FROM notifications n JOIN events e ON e.id = n.event_id JOIN cameras c ON c.id = n.camera_id
                ${deviceId ? 'LEFT JOIN deliveries d ON d.notification_id = n.id AND d.device_id = ?' : ''}
                WHERE n.id = ?`)
      .get(...(deviceId ? [deviceId, id] : [id])) as Record<string, unknown> | undefined;
    return r && this.rowToDto(r);
  }

  list(deviceId: string, q: { unread?: boolean; cameraId?: string; before?: number; limit?: number }): NotificationDto[] {
    const where = ['1=1'];
    const args: Array<string | number> = [deviceId];
    if (q.unread) where.push("COALESCE(d.state, 'pending') != 'read'");
    if (q.cameraId) where.push('n.camera_id = ?'), args.push(q.cameraId);
    if (q.before) where.push('n.created_at < ?'), args.push(q.before);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    const rows = this.db
      .prepare(`SELECT n.*, e.label, e.confidence, e.image_path, c.name AS camera_name, d.state, d.read_at
                FROM notifications n JOIN events e ON e.id = n.event_id JOIN cameras c ON c.id = n.camera_id
                LEFT JOIN deliveries d ON d.notification_id = n.id AND d.device_id = ?
                WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT ${limit}`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDto(r));
  }

  deliveryStates(notificationId: string) {
    return this.db
      .prepare('SELECT device_id AS deviceId, state, attempts, last_sent_at AS lastSentAt, received_at AS receivedAt, read_at AS readAt FROM deliveries WHERE notification_id = ?')
      .all(notificationId);
  }

  unreadCount(deviceId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE device_id = ? AND state != 'read'").get(deviceId) as { c: number }).c;
  }

  private rowToDto(r: Record<string, unknown>): NotificationDto {
    return {
      id: r.id as string,
      eventId: r.event_id as string,
      cameraId: r.camera_id as string,
      cameraName: r.camera_name as string,
      kind: r.kind as string,
      label: r.label as string,
      confidence: r.confidence as number,
      title: r.title as string,
      body: r.body as string,
      createdAt: r.created_at as number,
      imageUrl: r.image_path ? this.imageUrl(r.event_id as string) : null,
      ...(r.state !== undefined ? { state: (r.state as DeliveryState | null) ?? undefined, readAt: (r.read_at as number | null) ?? null } : {}),
    };
  }
}
