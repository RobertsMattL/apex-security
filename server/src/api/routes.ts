import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthError, type AuthService, type Principal } from '../auth/AuthService.js';
import type { CameraManager } from '../cameras/CameraManager.js';
import type { Config } from '../config.js';
import type { EventManager } from '../events/EventManager.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import type { TacticalRtspAdapter } from '../rtsp/TacticalRtspAdapter.js';
import type { Secrets } from '../util/secrets.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ApiDeps {
  config: Config;
  auth: AuthService;
  cameras: CameraManager;
  events: EventManager;
  notifications: NotificationService;
  rtsp: TacticalRtspAdapter;
  secrets: Secrets;
  onDeviceRevoked?: (deviceId: string) => void;
}

const IMAGE_URL_TTL_SEC = 3600;

export function signedImageUrl(secrets: Secrets, eventId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + IMAGE_URL_TTL_SEC;
  return `/api/images/${eventId}?exp=${exp}&sig=${secrets.sign(`img:${eventId}:${exp}`)}`;
}

const cameraBody = z.object({
  name: z.string().min(1).max(64),
  rtspUrl: z.string().min(1).max(2048),
  username: z.string().max(256).nullish(),
  password: z.string().max(256).nullish(),
  transport: z.enum(['automatic', 'tcp', 'udp']).optional(),
  enabled: z.boolean().optional(),
});

const settingsBody = z.object({
  notificationsEnabled: z.boolean().optional(),
  listeners: z
    .array(
      z.object({
        kind: z.string(),
        enabled: z.boolean().optional(),
        notify: z.boolean().optional(),
        minConfidence: z.number().min(0.05).max(0.99).optional(),
        cooldownSec: z.number().int().min(0).max(86400).optional(),
      }),
    )
    .optional(),
});

/** REST API: setup/auth, cameras, settings, events, notifications, images, internal MediaMTX auth hook. */
export function registerRoutes(app: FastifyInstance, d: ApiDeps) {
  const requireAuth = async (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new AuthError('missing bearer token');
    req.principal = await d.auth.verifyAccess(token);
  };
  const me = (req: FastifyRequest) => req.principal!;

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid request', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
  });

  // ---- public --------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, setupRequired: !d.auth.hasUsers(), time: Date.now() }));

  app.post('/api/setup', async (req, reply) => {
    if (d.auth.hasUsers()) throw new AuthError('setup already completed', 409);
    const b = z.object({ username: z.string().min(1).max(64), password: z.string().min(8).max(256) }).parse(req.body);
    await d.auth.createUser(b.username, b.password);
    reply.code(201).send({ ok: true });
  });

  const attempts = new Map<string, number[]>();
  app.post('/api/auth/login', async (req) => {
    // Brute-force guard: 10 attempts per minute per client address.
    const ip = req.ip;
    const recent = (attempts.get(ip) ?? []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= 10) throw new AuthError('too many login attempts; try again in a minute', 429);
    attempts.set(ip, [...recent, Date.now()]);
    const b = z
      .object({ username: z.string(), password: z.string(), deviceName: z.string().max(64).default('device'), platform: z.string().max(32).optional(), deviceId: z.string().uuid().optional() })
      .parse(req.body);
    return d.auth.login(b.username, b.password, { name: b.deviceName, platform: b.platform, deviceId: b.deviceId });
  });

  app.post('/api/auth/refresh', async (req) => {
    const b = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
    return d.auth.refresh(b.refreshToken);
  });

  // MediaMTX authHTTPAddress hook. MediaMTX runs on this host, so only accept loopback callers.
  app.post('/internal/mediamtx/auth', async (req, reply) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return reply.code(403).send();
    const ok = await d.rtsp.authorize((req.body ?? {}) as Record<string, string>);
    return reply.code(ok ? 200 : 401).send();
  });

  // Images: signed URL (for image loaders / notification thumbnails) or bearer token.
  app.get('/api/images/:eventId', async (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const q = req.query as { exp?: string; sig?: string };
    const signed = q.exp && q.sig && Number(q.exp) * 1000 > Date.now() && d.secrets.verify(`img:${eventId}:${q.exp}`, q.sig);
    if (!signed) await requireAuth(req);
    const ev = d.events.get(eventId);
    if (!ev?.imagePath || !existsSync(ev.imagePath)) return reply.code(404).send({ error: 'image not found' });
    reply.header('Cache-Control', 'private, max-age=86400, immutable').type('image/jpeg');
    return reply.send(createReadStream(ev.imagePath));
  });

  // ---- authenticated -------------------------------------------------------

  app.register(async (r) => {
    r.addHook('onRequest', requireAuth);

    r.get('/api/me', async (req) => ({ ...me(req), devices: d.auth.listDevices(me(req).userId) }));
    r.get('/api/devices', async (req) => d.auth.listDevices(me(req).userId));
    r.delete('/api/devices/:id', async (req) => {
      const { id } = req.params as { id: string };
      d.auth.revokeDevice(me(req).userId, id);
      d.onDeviceRevoked?.(id);
      return { ok: true };
    });

    r.get('/api/bootstrap', async (req) => ({
      serverTime: Date.now(),
      deviceId: me(req).deviceId,
      cameras: d.cameras.list(),
      notifications: d.notifications.list(me(req).deviceId, { limit: 50 }),
      unread: d.notifications.unreadCount(me(req).deviceId),
    }));

    // Cameras
    r.get('/api/cameras', async () => d.cameras.list());
    r.get('/api/cameras/:id', async (req) => d.cameras.get((req.params as { id: string }).id));
    r.post('/api/cameras/test', async (req) => {
      const b = cameraBody.pick({ rtspUrl: true, username: true, password: true, transport: true }).parse(req.body);
      return d.cameras.probe(b);
    });
    /** Re-test a saved camera using its stored credentials. */
    r.post('/api/cameras/:id/test', async (req) => {
      const id = (req.params as { id: string }).id;
      const url = d.cameras.sourceUrl(id);
      return d.cameras.probe({ rtspUrl: url, transport: d.cameras.get(id).transport });
    });
    r.post('/api/cameras', async (req, reply) => {
      const b = cameraBody.extend({ skipTest: z.boolean().optional() }).parse(req.body);
      if (!b.skipTest) {
        const probe = await d.cameras.probe(b);
        if (!probe.ok) return reply.code(422).send({ error: `connection test failed: ${probe.error}`, probe });
      }
      reply.code(201);
      return d.cameras.create(b);
    });
    r.patch('/api/cameras/:id', async (req) => d.cameras.update((req.params as { id: string }).id, cameraBody.partial().parse(req.body)));
    r.delete('/api/cameras/:id', async (req) => {
      await d.cameras.remove((req.params as { id: string }).id);
      return { ok: true };
    });
    r.get('/api/cameras/:id/settings', async (req) => {
      const id = (req.params as { id: string }).id;
      const c = d.cameras.get(id);
      return { notificationsEnabled: c.notificationsEnabled, listeners: c.listeners };
    });
    r.put('/api/cameras/:id/settings', async (req) => d.cameras.updateSettings((req.params as { id: string }).id, settingsBody.parse(req.body)));

    r.post('/api/cameras/:id/stream-token', async (req) => {
      const id = (req.params as { id: string }).id;
      d.cameras.get(id);
      const token = await d.auth.streamToken(me(req), id);
      const host = d.config.publicHost ?? req.hostname.replace(/:\d+$/, '');
      return { url: d.rtsp.clientReadUrl(id, host, token), username: 'stream', token, expiresInSec: 600 };
    });

    r.get('/api/cameras/:id/snapshot', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      d.cameras.get(id);
      const jpg = await snapshots.get(id, () => grabFrame(d.config.ffmpeg, d.rtsp.internalReadUrl(id)));
      if (!jpg) return reply.code(503).send({ error: 'camera offline' });
      reply.header('Cache-Control', 'no-store').type('image/jpeg');
      return reply.send(jpg);
    });

    // Events & notifications
    r.get('/api/events', async (req) => {
      const q = z
        .object({ cameraId: z.string().optional(), kind: z.string().optional(), before: z.coerce.number().optional(), limit: z.coerce.number().optional() })
        .parse(req.query);
      return d.events.list(q).map((e) => ({ ...e, imagePath: undefined, imageUrl: e.imagePath ? signedImageUrl(d.secrets, e.id) : null, cameraName: d.cameras.name(e.cameraId) }));
    });
    r.get('/api/events/:id', async (req, reply) => {
      const e = d.events.get((req.params as { id: string }).id);
      if (!e) return reply.code(404).send({ error: 'event not found' });
      return { ...e, imagePath: undefined, imageUrl: e.imagePath ? signedImageUrl(d.secrets, e.id) : null, cameraName: d.cameras.name(e.cameraId) };
    });
    r.get('/api/notifications', async (req) => {
      const q = z
        .object({ unread: z.coerce.boolean().optional(), cameraId: z.string().optional(), before: z.coerce.number().optional(), limit: z.coerce.number().optional() })
        .parse(req.query);
      return d.notifications.list(me(req).deviceId, q);
    });
    r.get('/api/notifications/:id/deliveries', async (req) => d.notifications.deliveryStates((req.params as { id: string }).id));
    // REST fallbacks for clients that are offline from the socket.
    r.post('/api/notifications/ack', async (req) => {
      const b = z.object({ ids: z.array(z.string()).max(500) }).parse(req.body);
      return { updated: d.notifications.ack(me(req).deviceId, b.ids) };
    });
    r.post('/api/notifications/read', async (req) => {
      const b = z.object({ ids: z.array(z.string()).max(500) }).parse(req.body);
      d.notifications.ack(me(req).deviceId, b.ids);
      return { read: d.notifications.markRead(me(req).userId, b.ids) };
    });
  });
}

/** Tiny per-camera cache so many dashboard clients share one frame grab. */
const snapshots = {
  cache: new Map<string, { at: number; jpg: Buffer | null; pending?: Promise<Buffer | null> }>(),
  async get(id: string, grab: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const c = this.cache.get(id);
    if (c?.pending) return c.pending;
    if (c && Date.now() - c.at < 5000) return c.jpg;
    const pending = grab().then((jpg) => {
      this.cache.set(id, { at: Date.now(), jpg });
      return jpg;
    });
    this.cache.set(id, { at: c?.at ?? 0, jpg: c?.jpg ?? null, pending });
    return pending;
  },
};

function grabFrame(ffmpeg: string, url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
  });
}

