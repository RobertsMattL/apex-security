import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CameraManager } from '../cameras/CameraManager.js';
import { tx, type DB } from '../db/database.js';
import type { FrameSink } from '../detection/DetectionEngine.js';
import type { ListenerRegistry } from '../detection/listeners/index.js';
import type { DetectionFrame, Detector, TrackedObject } from '../detection/types.js';
import type { Bus } from '../util/bus.js';
import { logger } from '../util/log.js';

const log = logger('events');

export interface DetectionEvent {
  id: string;
  cameraId: string;
  kind: string;
  label: string;
  confidence: number;
  trackId: number | null;
  box: [number, number, number, number] | null;
  frameW: number | null;
  frameH: number | null;
  imagePath: string | null;
  createdAt: number;
}

export interface EventSink {
  onEvent(event: DetectionEvent, notify: boolean): void;
}

interface CameraState {
  /** `${trackId}:${kind}` that already produced (or were suppressed from) an event -> last seen ms. */
  handled: Map<string, number>;
  lastFired: Map<string, number>;
  inFlight: Set<string>;
}

const TRACK_FORGET_MS = 10 * 60 * 1000;

/**
 * Event Manager: turns raw detections into de-duplicated detection events.
 *
 * - A tracked object (tacticalRtsp's BoT-SORT + re-ID keeps its id across frames and
 *   short occlusions) produces at most one event, however long it stays in view.
 * - Per camera and kind, a cooldown suppresses new events (new track ids from the
 *   tracker losing an object, untracked detections) for `cooldownSec`.
 * - The highest-confidence qualifying object in the frame is the one reported.
 * Each event's frame is captured by the detector, persisted, then handed on.
 */
export class EventManager implements FrameSink {
  private state = new Map<string, CameraState>();

  constructor(
    private db: DB,
    private cameras: CameraManager,
    private registry: ListenerRegistry,
    private bus: Bus,
    private dataDir: string,
    private sink: EventSink,
    private now: () => number = Date.now,
  ) {
    bus.on('camera.removed', (id) => this.state.delete(id));
  }

  private cam(cameraId: string): CameraState {
    let s = this.state.get(cameraId);
    if (!s) this.state.set(cameraId, (s = { handled: new Map(), lastFired: new Map(), inFlight: new Set() }));
    return s;
  }

  /** The detector reconnected: its track ids start over. Cooldowns still apply. */
  resetCamera(cameraId: string) {
    this.cam(cameraId).handled.clear();
  }

  handleFrame(frame: DetectionFrame, detector: Detector) {
    if (!this.cameras.exists(frame.cameraId)) return;
    const st = this.cam(frame.cameraId);
    const now = this.now();
    const settings = new Map(this.cameras.listenerSettings(frame.cameraId).map((l) => [l.kind, l]));
    const best = new Map<string, TrackedObject>();

    for (const t of frame.tracks) {
      const listener = this.registry.classify(t.cls);
      const s = listener && settings.get(listener.kind);
      if (!listener || !s?.enabled) continue;
      // Keyed by kind too: the tracker is class-agnostic, so a re-used id with a new kind is a new object.
      const key = t.id !== null ? `${t.id}:${listener.kind}` : null;
      if (key && st.handled.has(key)) {
        st.handled.set(key, now);
        continue;
      }
      if (t.conf < s.minConfidence) continue;
      const cooling = now - (st.lastFired.get(listener.kind) ?? -Infinity) < s.cooldownSec * 1000;
      if (cooling || st.inFlight.has(listener.kind)) {
        // Same object later in view must not fire once the cooldown ends.
        if (key) st.handled.set(key, now);
        continue;
      }
      const cur = best.get(listener.kind);
      if (!cur || t.conf > cur.conf) best.set(listener.kind, t);
    }

    for (const [kind, t] of best) {
      if (t.id !== null) st.handled.set(`${t.id}:${kind}`, now);
      st.lastFired.set(kind, now);
      void this.fire(frame, detector, kind, t, settings.get(kind)!.notify);
    }

    for (const [id, seen] of st.handled) if (now - seen > TRACK_FORGET_MS) st.handled.delete(id);
  }

  private async fire(frame: DetectionFrame, detector: Detector, kind: string, t: TrackedObject, notify: boolean) {
    const st = this.cam(frame.cameraId);
    st.inFlight.add(kind);
    const id = randomUUID();
    const createdAt = frame.ts || this.now();
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const path = join(this.dataDir, 'events', frame.cameraId, day, `${id}.jpg`);
    try {
      const ok = await detector.snapshot(id, frame.seq, path).catch(() => false);
      if (!this.cameras.exists(frame.cameraId)) return;
      const ev: DetectionEvent = {
        id,
        cameraId: frame.cameraId,
        kind,
        label: t.cls,
        confidence: t.conf,
        trackId: t.id,
        box: t.box,
        frameW: frame.w,
        frameH: frame.h,
        imagePath: ok ? path : null,
        createdAt,
      };
      this.insert(ev);
      log.info(`${kind} on ${this.cameras.name(frame.cameraId)} (${t.cls} ${(t.conf * 100).toFixed(0)}%, track ${t.id ?? '-'})${ok ? '' : ' [no image]'}`);
      this.bus.emit('event.created', { id, cameraId: ev.cameraId, kind });
      this.sink.onEvent(ev, notify && this.cameras.notificationsEnabled(frame.cameraId));
    } catch (e) {
      log.error('failed to record event', e);
    } finally {
      st.inFlight.delete(kind);
    }
  }

  insert(ev: DetectionEvent) {
    this.db
      .prepare(`INSERT INTO events (id, camera_id, kind, label, confidence, track_id, box, frame_w, frame_h, image_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ev.id, ev.cameraId, ev.kind, ev.label, ev.confidence, ev.trackId, ev.box ? JSON.stringify(ev.box) : null, ev.frameW, ev.frameH, ev.imagePath, ev.createdAt);
  }

  /**
   * Delete events with their captured frames. Notifications and per-device deliveries
   * cascade in the database; clients are told so they drop them from their inboxes.
   * Pass ids, or `all` (optionally scoped to one camera / kind).
   */
  async delete(q: { ids?: string[]; all?: boolean; cameraId?: string; kind?: string }): Promise<{ eventIds: string[]; notificationIds: string[] }> {
    let rows: Array<{ id: string; image_path: string | null }>;
    if (q.all) {
      const where: string[] = [];
      const args: string[] = [];
      if (q.cameraId) where.push('camera_id = ?'), args.push(q.cameraId);
      if (q.kind) where.push('kind = ?'), args.push(q.kind);
      rows = this.db.prepare(`SELECT id, image_path FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(...args) as typeof rows;
    } else {
      const ids = [...new Set(q.ids ?? [])].slice(0, 5000);
      if (!ids.length) return { eventIds: [], notificationIds: [] };
      rows = this.db.prepare(`SELECT id, image_path FROM events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as typeof rows;
    }
    if (!rows.length) return { eventIds: [], notificationIds: [] };
    const eventIds = rows.map((r) => r.id);
    let notificationIds: string[] = [];
    tx(this.db, () => {
      for (let i = 0; i < eventIds.length; i += 500) {
        const chunk = eventIds.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        notificationIds = notificationIds.concat(
          (this.db.prepare(`SELECT id FROM notifications WHERE event_id IN (${ph})`).all(...chunk) as Array<{ id: string }>).map((r) => r.id),
        );
        this.db.prepare(`DELETE FROM events WHERE id IN (${ph})`).run(...chunk);
      }
    });
    await Promise.all(rows.filter((r) => r.image_path).map((r) => unlink(r.image_path!).catch(() => {})));
    log.info(`deleted ${eventIds.length} event(s), ${notificationIds.length} notification(s)`);
    this.bus.emit('events.deleted', eventIds, notificationIds);
    return { eventIds, notificationIds };
  }

  get(id: string): DetectionEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r && rowToEvent(r);
  }

  list(q: { cameraId?: string; kind?: string; before?: number; limit?: number }): DetectionEvent[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.cameraId) where.push('camera_id = ?'), args.push(q.cameraId);
    if (q.kind) where.push('kind = ?'), args.push(q.kind);
    if (q.before) where.push('created_at < ?'), args.push(q.before);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }
}

function rowToEvent(r: Record<string, unknown>): DetectionEvent {
  return {
    id: r.id as string,
    cameraId: r.camera_id as string,
    kind: r.kind as string,
    label: r.label as string,
    confidence: r.confidence as number,
    trackId: (r.track_id as number | null) ?? null,
    box: r.box ? JSON.parse(r.box as string) : null,
    frameW: (r.frame_w as number | null) ?? null,
    frameH: (r.frame_h as number | null) ?? null,
    imagePath: (r.image_path as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}
