import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CameraManager } from '../cameras/CameraManager.js';
import { tx, type DB } from '../db/database.js';
import type { FrameSink } from '../detection/DetectionEngine.js';
import type { ListenerRegistry } from '../detection/listeners/index.js';
import type { DetectionFrame, Detector, TrackedObject } from '../detection/types.js';
import type { Bus } from '../util/bus.js';
import type { ClipRecorder } from './ClipRecorder.js';
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
  /** null: no clip (older events, or clip length 0). */
  clipState: 'recording' | 'ready' | 'failed' | null;
  clipPath: string | null;
  clipDurationSec: number | null;
  createdAt: number;
}

export type ClipState = DetectionEvent['clipState'];

export interface EventSink {
  onEvent(event: DetectionEvent, notify: boolean): void;
}

interface CameraState {
  /** `${trackId}:${kind}` already covered by an event (so not notified again) -> last seen ms. */
  handled: Map<string, number>;
  lastFired: Map<string, number>;
  inFlight: Set<string>;
}

/**
 * Event frames and clips. The `.noindex` suffix keeps macOS Spotlight from indexing
 * every JPEG and MP4 as it is written (that alone cost more CPU than detection).
 */
const MEDIA_DIR = 'events.noindex';

const TRACK_FORGET_MS = 10 * 60 * 1000;

/**
 * Event Manager: turns raw detections into detection events, each with a video clip.
 *
 * - `cooldownSec` (per camera and kind) is both the clip length and the cooldown: an
 *   event records that many seconds of video, and no new event of that kind fires
 *   until it is over. Then detection resumes.
 * - If an object is still in view when the cooldown ends, it fires a follow-up event
 *   (so a long visit is covered by back-to-back clips), but only the first event for a
 *   tracked object notifies. tacticalRtsp's BoT-SORT + re-ID keeps the track id across
 *   frames and short occlusions, so one person standing around is one notification.
 * - The highest-confidence qualifying object in the frame is the one reported.
 * Each event's frame is captured by the detector, persisted, then handed on.
 */
export class EventManager implements FrameSink {
  private state = new Map<string, CameraState>();
  private mediaDir: string;

  constructor(
    private db: DB,
    private cameras: CameraManager,
    private registry: ListenerRegistry,
    private bus: Bus,
    private dataDir: string,
    private sink: EventSink,
    private clips: ClipRecorder | null = null,
    private now: () => number = Date.now,
  ) {
    bus.on('camera.removed', (id) => this.state.delete(id));
    this.mediaDir = join(dataDir, MEDIA_DIR);
    this.moveLegacyMedia();
    // Clips cut off by a restart have no index and can't be played.
    const stale = db.prepare("SELECT id, clip_path FROM events WHERE clip_state = 'recording'").all() as Array<{ id: string; clip_path: string | null }>;
    for (const r of stale) if (r.clip_path) void unlink(r.clip_path).catch(() => {});
    if (stale.length) db.prepare("UPDATE events SET clip_state = 'failed', clip_path = NULL WHERE clip_state = 'recording'").run();
  }

  /** Media used to live in data/events: move it (one rename) and repoint stored paths. */
  private moveLegacyMedia() {
    const old = join(this.dataDir, 'events');
    if (!existsSync(old) || existsSync(this.mediaDir)) return;
    renameSync(old, this.mediaDir);
    for (const col of ['image_path', 'clip_path']) {
      this.db.prepare(`UPDATE events SET ${col} = ? || substr(${col}, ?) WHERE ${col} LIKE ?`).run(this.mediaDir, old.length + 1, `${old}/%`);
    }
    log.info(`moved event media to ${this.mediaDir}`);
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
    const visible = new Map<string, string[]>();
    const fresh = new Set<string>();

    for (const t of frame.tracks) {
      const listener = this.registry.classify(t.cls);
      const s = listener && settings.get(listener.kind);
      if (!listener || !s?.enabled) continue;
      // Keyed by kind too: the tracker is class-agnostic, so a re-used id with a new kind is a new object.
      const key = t.id !== null ? `${t.id}:${listener.kind}` : null;
      const known = key !== null && st.handled.has(key);
      if (known) st.handled.set(key, now);
      if (t.conf < s.minConfidence && !known) continue;
      const cooling = now - (st.lastFired.get(listener.kind) ?? -Infinity) < s.cooldownSec * 1000;
      if (cooling || st.inFlight.has(listener.kind)) continue;
      if (key) visible.set(listener.kind, [...(visible.get(listener.kind) ?? []), key]);
      if (!known) fresh.add(listener.kind);
      const cur = best.get(listener.kind);
      if (!cur || t.conf > cur.conf) best.set(listener.kind, t);
    }

    for (const [kind, t] of best) {
      // Everything in view is covered by this clip; only a new object notifies.
      for (const key of visible.get(kind) ?? []) st.handled.set(key, now);
      st.lastFired.set(kind, now);
      const s = settings.get(kind)!;
      void this.fire(frame, detector, kind, t, s.notify && fresh.has(kind), s.cooldownSec);
    }

    for (const [id, seen] of st.handled) if (now - seen > TRACK_FORGET_MS) st.handled.delete(id);
  }

  private async fire(frame: DetectionFrame, detector: Detector, kind: string, t: TrackedObject, notify: boolean, clipSec: number) {
    const st = this.cam(frame.cameraId);
    st.inFlight.add(kind);
    const id = randomUUID();
    const createdAt = frame.ts || this.now();
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const path = join(this.mediaDir, frame.cameraId, day, `${id}.jpg`);
    const clipPath = this.clips && clipSec > 0 ? join(this.mediaDir, frame.cameraId, day, `${id}.mp4`) : null;
    // Start recording at once, alongside the snapshot, so the clip starts as close to the trigger as possible.
    const clip = clipPath ? this.clips!.record(id, frame.cameraId, clipPath, clipSec) : null;
    try {
      const ok = await detector.snapshot(id, frame.seq, path).catch(() => false);
      if (!this.cameras.exists(frame.cameraId)) {
        if (clip) this.clips!.cancel([id]);
        return;
      }
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
        clipState: clip ? 'recording' : null,
        clipPath,
        clipDurationSec: null,
        createdAt,
      };
      this.insert(ev);
      if (clip) void clip.then((dur) => this.clipDone(ev, dur));
      log.info(`${kind} on ${this.cameras.name(frame.cameraId)} (${t.cls} ${(t.conf * 100).toFixed(0)}%, track ${t.id ?? '-'})${ok ? '' : ' [no image]'}`);
      this.bus.emit('event.created', { id, cameraId: ev.cameraId, kind });
      this.sink.onEvent(ev, notify && this.cameras.notificationsEnabled(frame.cameraId));
    } catch (e) {
      log.error('failed to record event', e);
    } finally {
      st.inFlight.delete(kind);
    }
  }

  private clipDone(ev: DetectionEvent, duration: number | null) {
    const state: ClipState = duration !== null ? 'ready' : 'failed';
    const r = this.db
      .prepare('UPDATE events SET clip_state = ?, clip_path = ?, clip_duration = ? WHERE id = ?')
      .run(state, duration !== null ? ev.clipPath : null, duration, ev.id);
    if (!r.changes) {
      // Deleted while recording.
      if (ev.clipPath) void unlink(ev.clipPath).catch(() => {});
      return;
    }
    log.info(`clip ${state} for ${ev.kind} on ${this.cameras.name(ev.cameraId)}${duration !== null ? ` (${duration}s)` : ''}`);
    this.bus.emit('event.clip', { id: ev.id, cameraId: ev.cameraId, clipState: state, clipDurationSec: duration });
  }

  insert(ev: DetectionEvent) {
    this.db
      .prepare(`INSERT INTO events (id, camera_id, kind, label, confidence, track_id, box, frame_w, frame_h, image_path, clip_state, clip_path, clip_duration, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ev.id, ev.cameraId, ev.kind, ev.label, ev.confidence, ev.trackId, ev.box ? JSON.stringify(ev.box) : null, ev.frameW, ev.frameH, ev.imagePath,
        ev.clipState, ev.clipPath, ev.clipDurationSec, ev.createdAt);
  }

  /**
   * Delete events with their captured frames. Notifications and per-device deliveries
   * cascade in the database; clients are told so they drop them from their inboxes.
   * Pass ids, or `all` (optionally scoped to one camera / kind).
   */
  async delete(q: { ids?: string[]; all?: boolean; cameraId?: string; kind?: string }): Promise<{ eventIds: string[]; notificationIds: string[] }> {
    let rows: Array<{ id: string; image_path: string | null; clip_path: string | null }>;
    if (q.all) {
      const where: string[] = [];
      const args: string[] = [];
      if (q.cameraId) where.push('camera_id = ?'), args.push(q.cameraId);
      if (q.kind) where.push('kind = ?'), args.push(q.kind);
      rows = this.db.prepare(`SELECT id, image_path, clip_path FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(...args) as typeof rows;
    } else {
      const ids = [...new Set(q.ids ?? [])].slice(0, 5000);
      if (!ids.length) return { eventIds: [], notificationIds: [] };
      rows = this.db.prepare(`SELECT id, image_path, clip_path FROM events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as typeof rows;
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
    this.clips?.cancel(eventIds);
    const files = rows.flatMap((r) => [r.image_path, r.clip_path]).filter((f): f is string => !!f);
    await Promise.all(files.map((f) => unlink(f).catch(() => {})));
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
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
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
    clipState: (r.clip_state as ClipState) ?? null,
    clipPath: (r.clip_path as string | null) ?? null,
    clipDurationSec: (r.clip_duration as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}
