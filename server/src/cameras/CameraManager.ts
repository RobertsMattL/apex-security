import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { tx, type DB } from '../db/database.js';
import type { ListenerRegistry } from '../detection/listeners/index.js';
import type { ListenerSettings } from '../detection/types.js';
import { cameraPath, livePath, type TacticalRtspAdapter } from '../rtsp/TacticalRtspAdapter.js';
import type { Bus } from '../util/bus.js';
import { logger } from '../util/log.js';
import type { Secrets } from '../util/secrets.js';
import type { CameraDto, CameraInput, CameraStatus } from './types.js';

const log = logger('cameras');

interface CameraRow {
  id: string;
  name: string;
  rtsp_url: string;
  username_enc: string | null;
  password_enc: string | null;
  transport: 'automatic' | 'tcp' | 'udp';
  enabled: number;
  notifications_enabled: number;
  created_at: number;
  updated_at: number;
}

export class ValidationError extends Error {
  readonly status = 400;
}

export class NotFoundError extends Error {
  readonly status = 404;
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  video?: { codec: string; width: number; height: number; fps?: number };
  audio?: { codec: string };
  latencyMs: number;
}

/**
 * Camera Manager: camera configuration, credential storage, and the connection
 * lifecycle (each camera is a MediaMTX path; MediaMTX keeps it connected and retries
 * when the camera drops). Status is polled from MediaMTX and published on the bus.
 */
export class CameraManager {
  private status = new Map<string, CameraStatus>();
  private poll?: NodeJS.Timeout;
  private detectorState = new Map<string, { state: CameraStatus['detector']; message?: string }>();
  /** Video codec each viewer path was configured for (decides which SEI types to strip). */
  private liveCodec = new Map<string, string>();

  constructor(
    private db: DB,
    private secrets: Secrets,
    private rtsp: TacticalRtspAdapter,
    private listeners: ListenerRegistry,
    private bus: Bus,
    private config: Config,
  ) {
    rtsp.onReady(() => void this.syncAll());
  }

  start(pollMs = 2000) {
    this.poll = setInterval(() => void this.refreshStatus(), pollMs);
    this.poll.unref();
  }

  stop() {
    clearInterval(this.poll);
  }

  // ---- queries ---------------------------------------------------------------

  list(): CameraDto[] {
    const rows = this.db.prepare('SELECT * FROM cameras ORDER BY created_at').all() as unknown as CameraRow[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: string): CameraDto {
    return this.toDto(this.row(id));
  }

  exists(id: string) {
    return !!this.db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(id);
  }

  name(id: string): string {
    return (this.db.prepare('SELECT name FROM cameras WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'Camera';
  }

  private row(id: string): CameraRow {
    const r = this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id) as CameraRow | undefined;
    if (!r) throw new NotFoundError('camera not found');
    return r;
  }

  listenerSettings(cameraId: string): ListenerSettings[] {
    const rows = this.db.prepare('SELECT * FROM detection_listeners WHERE camera_id = ?').all(cameraId) as Array<{
      kind: string; enabled: number; notify: number; min_confidence: number; cooldown_sec: number;
    }>;
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    return this.listeners.all().map((l) => {
      const r = byKind.get(l.kind);
      return {
        kind: l.kind,
        label: l.label,
        enabled: r ? !!r.enabled : l.defaults.enabled,
        notify: r ? !!r.notify : l.defaults.notify,
        minConfidence: r ? r.min_confidence : l.defaults.minConfidence,
        cooldownSec: r ? r.cooldown_sec : l.defaults.cooldownSec,
      };
    });
  }

  notificationsEnabled(cameraId: string): boolean {
    return !!(this.db.prepare('SELECT notifications_enabled AS n FROM cameras WHERE id = ?').get(cameraId) as { n: number } | undefined)?.n;
  }

  /** True when the camera should have a detector running. */
  wantsDetection(cameraId: string): boolean {
    const r = this.db.prepare('SELECT enabled FROM cameras WHERE id = ?').get(cameraId) as { enabled: number } | undefined;
    return !!r?.enabled && this.listenerSettings(cameraId).some((l) => l.enabled);
  }

  getStatus(id: string): CameraStatus {
    return this.status.get(id) ?? { stream: 'connecting', detector: 'off', since: Date.now() };
  }

  // ---- mutations -------------------------------------------------------------

  async create(input: CameraInput): Promise<CameraDto> {
    const c = normalize(input);
    const id = randomUUID();
    const now = Date.now();
    tx(this.db, () => {
      this.db
        .prepare(`INSERT INTO cameras (id, name, rtsp_url, username_enc, password_enc, transport, enabled, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, c.name, c.rtspUrl, this.enc(c.username), this.enc(c.password), c.transport, c.enabled ? 1 : 0, now, now);
      for (const l of this.listeners.all()) {
        this.db
          .prepare('INSERT INTO detection_listeners (camera_id, kind, enabled, notify, min_confidence, cooldown_sec) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, l.kind, l.defaults.enabled ? 1 : 0, l.defaults.notify ? 1 : 0, l.defaults.minConfidence, l.defaults.cooldownSec);
      }
    });
    this.status.set(id, { stream: c.enabled ? 'connecting' : 'disabled', detector: 'off', since: now });
    await this.applyPath(id);
    const dto = this.get(id);
    this.bus.emit('camera.upserted', dto);
    log.info(`added camera ${c.name} (${id})`);
    return dto;
  }

  async update(id: string, input: Partial<CameraInput>): Promise<CameraDto> {
    const cur = this.row(id);
    const merged = normalize({
      name: input.name ?? cur.name,
      rtspUrl: input.rtspUrl ?? cur.rtsp_url,
      // undefined = keep, null/'' = clear
      username: input.username === undefined ? this.dec(cur.username_enc) : input.username,
      password: input.password === undefined ? this.dec(cur.password_enc) : input.password,
      transport: input.transport ?? cur.transport,
      enabled: input.enabled ?? !!cur.enabled,
    });
    this.db
      .prepare('UPDATE cameras SET name = ?, rtsp_url = ?, username_enc = ?, password_enc = ?, transport = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(merged.name, merged.rtspUrl, this.enc(merged.username), this.enc(merged.password), merged.transport, merged.enabled ? 1 : 0, Date.now(), id);
    await this.applyPath(id);
    const dto = this.get(id);
    this.bus.emit('camera.upserted', dto);
    return dto;
  }

  async remove(id: string) {
    this.row(id);
    this.db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    this.status.delete(id);
    this.liveCodec.delete(id);
    await this.rtsp.removePath(cameraPath(id)).catch((e) => log.warn('remove path failed', e));
    await this.rtsp.removePath(livePath(id)).catch((e) => log.warn('remove path failed', e));
    this.bus.emit('camera.removed', id);
  }

  updateSettings(id: string, patch: { notificationsEnabled?: boolean; listeners?: Array<Partial<ListenerSettings> & { kind: string }> }) {
    this.row(id);
    tx(this.db, () => {
      if (patch.notificationsEnabled !== undefined) {
        this.db.prepare('UPDATE cameras SET notifications_enabled = ?, updated_at = ? WHERE id = ?').run(patch.notificationsEnabled ? 1 : 0, Date.now(), id);
      }
      const current = new Map(this.listenerSettings(id).map((l) => [l.kind, l]));
      for (const p of patch.listeners ?? []) {
        const cur = current.get(p.kind);
        if (!cur) throw new ValidationError(`unknown detection kind: ${p.kind}`);
        const next = { ...cur, ...p };
        if (!(next.minConfidence >= 0.05 && next.minConfidence <= 0.99)) throw new ValidationError('minConfidence must be between 0.05 and 0.99');
        if (!(next.cooldownSec >= 0 && next.cooldownSec <= 300)) throw new ValidationError('cooldownSec (clip length) must be between 0 and 300 seconds');
        this.db
          .prepare(`INSERT INTO detection_listeners (camera_id, kind, enabled, notify, min_confidence, cooldown_sec) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (camera_id, kind) DO UPDATE SET enabled = excluded.enabled, notify = excluded.notify,
                    min_confidence = excluded.min_confidence, cooldown_sec = excluded.cooldown_sec`)
          .run(id, p.kind, next.enabled ? 1 : 0, next.notify ? 1 : 0, next.minConfidence, Math.round(next.cooldownSec));
      }
    });
    const settings = { notificationsEnabled: this.notificationsEnabled(id), listeners: this.listenerSettings(id) };
    this.bus.emit('settings.updated', id, settings);
    return settings;
  }

  setDetectorState(cameraId: string, state: CameraStatus['detector'], message?: string) {
    this.detectorState.set(cameraId, { state, message });
    const cur = this.getStatus(cameraId);
    if (cur.detector !== state || (message && cur.message !== message)) {
      this.publish(cameraId, { ...cur, detector: state, message: message ?? cur.message });
    }
  }

  // ---- connection lifecycle --------------------------------------------------

  /** Full camera URL with credentials. Server-side only. */
  sourceUrl(id: string): string {
    const r = this.row(id);
    return withCredentials(r.rtsp_url, this.dec(r.username_enc), this.dec(r.password_enc));
  }

  private async applyPath(id: string) {
    const r = this.row(id);
    const name = cameraPath(id);
    try {
      if (r.enabled) {
        await this.rtsp.setPath(name, { source: this.sourceUrl(id), rtspTransport: r.transport });
        await this.applyLivePath(id, this.liveCodec.get(id) ?? 'H264');
      } else {
        await this.rtsp.removePath(name);
        await this.rtsp.removePath(livePath(id));
      }
    } catch (e) {
      log.error(`could not configure stream for ${r.name}`, e);
    }
  }

  private async applyLivePath(id: string, codec: string) {
    await this.rtsp.setLivePath(id, codec);
    this.liveCodec.set(id, codec);
  }

  async syncAll() {
    for (const c of this.db.prepare('SELECT id FROM cameras').all() as Array<{ id: string }>) await this.applyPath(c.id);
    log.info('camera paths synced to mediamtx');
  }

  async refreshStatus() {
    let paths;
    try {
      paths = await this.rtsp.listPaths();
    } catch {
      return; // MediaMTX restarting; keep last known
    }
    for (const r of this.db.prepare('SELECT id, enabled FROM cameras').all() as Array<{ id: string; enabled: number }>) {
      const p = paths.get(cameraPath(r.id));
      const cur = this.getStatus(r.id);
      // The viewer path is set up before the camera's codec is known; correct it once it is.
      const codec = p?.ready ? p.tracks.find((t) => /^(H26[45]|AV1|VP[89]|M?JPEG|MPEG-[124] Video)/i.test(t)) : undefined;
      if (r.enabled && codec && this.liveCodec.has(r.id) && this.liveCodec.get(r.id) !== codec) {
        log.info(`camera ${r.id} video is ${codec}; updating viewer stream`);
        await this.applyLivePath(r.id, codec).catch((e) => log.warn('viewer path update failed', e));
      }
      const stream: CameraStatus['stream'] = !r.enabled ? 'disabled' : p?.ready ? 'online' : cur.stream === 'online' ? 'offline' : cur.stream === 'offline' ? 'offline' : 'connecting';
      const next: CameraStatus = {
        ...cur,
        stream,
        tracks: p?.ready ? p.tracks : undefined,
        readers: p?.readers ?? 0,
        detector: this.detectorState.get(r.id)?.state ?? 'off',
      };
      if (next.stream !== cur.stream || next.detector !== cur.detector || next.readers !== cur.readers || String(next.tracks) !== String(cur.tracks)) {
        if (next.stream !== cur.stream) log.info(`camera ${r.id} ${cur.stream} -> ${next.stream}`);
        this.publish(r.id, { ...next, since: next.stream !== cur.stream ? Date.now() : cur.since });
      }
    }
  }

  private publish(id: string, s: CameraStatus) {
    this.status.set(id, s);
    this.bus.emit('camera.status', id, s);
  }

  /** Probe an RTSP URL with ffprobe before saving it. Never logs credentials. */
  probe(input: { rtspUrl: string; username?: string | null; password?: string | null; transport?: string }, timeoutMs = 10000): Promise<ProbeResult> {
    const c = normalize({ name: 'probe', ...input } as CameraInput);
    const url = withCredentials(c.rtspUrl, c.username, c.password);
    const t0 = Date.now();
    const args = ['-v', 'error', '-timeout', String((timeoutMs - 1000) * 1000)];
    if (c.transport !== 'automatic') args.push('-rtsp_transport', c.transport);
    args.push('-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate', '-of', 'json', url);
    return new Promise((resolve) => {
      const p = spawn(this.config.ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `ffprobe unavailable: ${e.message}`, latencyMs: Date.now() - t0 });
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Date.now() - t0;
        if (code !== 0) return resolve({ ok: false, error: describeProbeError(err, code), latencyMs });
        try {
          const streams = (JSON.parse(out).streams ?? []) as Array<Record<string, string | number>>;
          const v = streams.find((s) => s.codec_type === 'video');
          const a = streams.find((s) => s.codec_type === 'audio');
          if (!v) return resolve({ ok: false, error: 'stream has no video track', latencyMs });
          const [n, d] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
          resolve({
            ok: true,
            latencyMs,
            video: { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: d ? Math.round((n / d) * 10) / 10 : undefined },
            audio: a ? { codec: String(a.codec_name) } : undefined,
          });
        } catch {
          resolve({ ok: false, error: 'unreadable probe output', latencyMs });
        }
      });
    });
  }

  // ---- helpers ---------------------------------------------------------------

  private enc(v?: string | null) {
    return v ? this.secrets.encrypt(v) : null;
  }

  private dec(v: string | null) {
    return v ? this.secrets.decrypt(v) : null;
  }

  private toDto(r: CameraRow): CameraDto {
    return {
      id: r.id,
      name: r.name,
      rtspUrl: r.rtsp_url,
      hasCredentials: !!(r.username_enc || r.password_enc),
      transport: r.transport,
      enabled: !!r.enabled,
      notificationsEnabled: !!r.notifications_enabled,
      listeners: this.listenerSettings(r.id),
      status: this.getStatus(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/** Validate an RTSP URL; credentials embedded in the URL are moved into username/password. */
export function normalize(input: CameraInput): Required<Omit<CameraInput, 'username' | 'password'>> & { username: string | null; password: string | null } {
  const name = (input.name ?? '').trim();
  if (!name || name.length > 64) throw new ValidationError('name must be 1-64 characters');
  let url: URL;
  try {
    url = new URL((input.rtspUrl ?? '').trim());
  } catch {
    throw new ValidationError('rtspUrl is not a valid URL');
  }
  if (url.protocol !== 'rtsp:' && url.protocol !== 'rtsps:') throw new ValidationError('rtspUrl must start with rtsp:// or rtsps://');
  if (!url.hostname) throw new ValidationError('rtspUrl needs a host');
  let username = input.username ?? null;
  let password = input.password ?? null;
  if (url.username || url.password) {
    username ||= decodeURIComponent(url.username) || null;
    password ||= decodeURIComponent(url.password) || null;
    url.username = '';
    url.password = '';
  }
  const transport = input.transport ?? 'automatic';
  if (!['automatic', 'tcp', 'udp'].includes(transport)) throw new ValidationError('transport must be automatic, tcp or udp');
  return { name, rtspUrl: url.toString(), username: username || null, password: password || null, transport, enabled: input.enabled ?? true };
}

export function withCredentials(rtspUrl: string, username: string | null, password: string | null) {
  if (!username && !password) return rtspUrl;
  const u = new URL(rtspUrl);
  u.username = encodeURIComponent(username ?? '');
  u.password = encodeURIComponent(password ?? '');
  return u.toString();
}

function describeProbeError(stderr: string, code: number | null): string {
  const s = stderr.replace(/rtsps?:\/\/[^\s'"]+/g, '<url>'); // never echo credentials back
  if (code === null) return 'timed out connecting to camera';
  if (/401|Unauthorized/i.test(s)) return 'camera rejected the credentials (401 Unauthorized)';
  if (/404|Not Found/i.test(s)) return 'stream path not found on camera (404)';
  if (/Connection refused/i.test(s)) return 'connection refused (wrong port or RTSP disabled)';
  if (/timed out|Operation timed out/i.test(s)) return 'timed out connecting to camera';
  if (/resolve|nodename/i.test(s)) return 'host name could not be resolved';
  return s.trim().split('\n').pop()?.slice(0, 200) || `ffprobe failed (${code})`;
}
