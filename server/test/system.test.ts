import { afterEach, describe, expect, it } from 'vitest';
import { backoffMs, DEFAULT_RETRY } from '../src/notifications/NotificationService.js';
import { api, personFrame, setupAndLogin, sleep, startApp, TestClient } from './helpers.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!().catch(() => {});
});

async function boot(dataDir?: string, opts?: { baseMs?: number }) {
  const s = await startApp(dataDir, opts);
  stops.push(() => s.app.stop());
  return s;
}

async function addCamera(s: Awaited<ReturnType<typeof boot>>, token: string, name = 'Driveway') {
  const r = await api(s.base, '/api/cameras', { token, body: { name, rtspUrl: 'rtsp://user:s3cret@10.0.0.9:554/stream1', skipTest: true } });
  expect(r.status).toBe(201);
  await sleep(20); // detection engine reconciles asynchronously
  return { camera: r.body, detector: s.detectors.get(r.body.id)! };
}

describe('retry backoff', () => {
  it('doubles from the base and is capped', () => {
    const p = { ...DEFAULT_RETRY, jitter: 0 };
    expect([1, 2, 3, 4].map((n) => backoffMs(n, p))).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(20, p)).toBe(DEFAULT_RETRY.maxMs);
  });
});

describe('auth and camera credentials', () => {
  it('rejects unauthenticated REST and WebSocket access', async () => {
    const s = await boot();
    expect((await api(s.base, '/api/cameras')).status).toBe(401);
    await expect(TestClient.connect(s.base, 'garbage')).rejects.toThrow(/401/);
  });

  it('only allows setup once and never returns camera credentials', async () => {
    const s = await boot();
    const t = await setupAndLogin(s.base);
    expect((await api(s.base, '/api/setup', { body: { username: 'x', password: 'another-pass' } })).status).toBe(409);
    const { camera } = await addCamera(s, t.accessToken);
    expect(camera.rtspUrl).toBe('rtsp://10.0.0.9:554/stream1');
    expect(camera.hasCredentials).toBe(true);
    expect(JSON.stringify(await api(s.base, '/api/cameras', { token: t.accessToken }))).not.toContain('s3cret');
    expect(s.app.cameras.sourceUrl(camera.id)).toBe('rtsp://user:s3cret@10.0.0.9:554/stream1');
    const raw = s.app.db.prepare('SELECT password_enc FROM cameras').get() as { password_enc: string };
    expect(raw.password_enc).not.toContain('s3cret');
  });

  it('rotates refresh tokens', async () => {
    const s = await boot();
    const t = await setupAndLogin(s.base);
    const r1 = await api(s.base, '/api/auth/refresh', { body: { refreshToken: t.refreshToken } });
    expect(r1.status).toBe(200);
    expect((await api(s.base, '/api/auth/refresh', { body: { refreshToken: t.refreshToken } })).status).toBe(401);
  });
});

describe('detection events', () => {
  it('fires once per tracked object, honours threshold, cooldown and disabled listeners', async () => {
    const s = await boot();
    const t = await setupAndLogin(s.base);
    const { camera, detector } = await addCamera(s, t.accessToken);
    await api(s.base, `/api/cameras/${camera.id}/settings`, { method: 'PUT', token: t.accessToken, body: { listeners: [{ kind: 'person', cooldownSec: 1, minConfidence: 0.6 }] } });

    detector.feed(personFrame(1, 7, 0.5)); // below threshold
    await sleep(30);
    expect(s.app.events.list({}).length).toBe(0);

    for (let i = 2; i < 10; i++) detector.feed(personFrame(i, 7, 0.9)); // same object, many frames
    await sleep(50);
    expect(s.app.events.list({}).length).toBe(1);

    detector.feed(personFrame(10, 8, 0.9)); // new object inside the cooldown
    await sleep(30);
    expect(s.app.events.list({}).length).toBe(1);

    await sleep(1050);
    detector.feed(personFrame(11, 7, 0.9)); // original object still in view after cooldown: no repeat
    detector.feed(personFrame(12, 8, 0.9)); // suppressed during cooldown: no late event either
    await sleep(30);
    expect(s.app.events.list({}).length).toBe(1);

    detector.feed(personFrame(13, 9, 0.9)); // genuinely new object after cooldown
    await sleep(30);
    expect(s.app.events.list({}).length).toBe(2);

    detector.feed(personFrame(14, 20, 0.95, 'dog')); // animal listener is off by default
    await sleep(30);
    expect(s.app.events.list({ kind: 'animal' }).length).toBe(0);

    const ev = s.app.events.list({})[0];
    expect(ev.imagePath).toMatch(/\.jpg$/);
    expect(detector.snaps).toContain(ev.id);
  });

  it('records events without notifying when notifications are off for the camera', async () => {
    const s = await boot();
    const t = await setupAndLogin(s.base);
    const { camera, detector } = await addCamera(s, t.accessToken);
    await api(s.base, `/api/cameras/${camera.id}/settings`, { method: 'PUT', token: t.accessToken, body: { notificationsEnabled: false } });
    detector.feed(personFrame(1, 1));
    await sleep(50);
    expect(s.app.events.list({}).length).toBe(1);
    expect(s.app.notifications.list(t.deviceId, {}).length).toBe(0);
  });
});

describe('notification delivery', () => {
  it('delivers, retries until acked, then stops; read syncs to other devices', async () => {
    const s = await boot();
    const phone = await setupAndLogin(s.base, 'phone');
    const tablet = (await api(s.base, '/api/auth/login', { body: { username: 'admin', password: 'correct-horse', deviceName: 'tablet' } })).body;
    const { detector } = await addCamera(s, phone.accessToken);

    const a = await TestClient.connect(s.base, phone.accessToken);
    const b = await TestClient.connect(s.base, tablet.accessToken);
    await a.next((m) => m.t === 'welcome');

    detector.feed(personFrame(1, 1));
    const first = await a.next((m) => m.t === 'notification');
    expect(first.n.title).toBe('HUMAN DETECTED');
    expect(first.n.cameraName).toBe('Driveway');
    expect(first.n.imageUrl).toMatch(/^\/api\/images\/.+\?exp=\d+&sig=/);
    expect(JSON.stringify(first)).not.toMatch(/\/9j\/|base64/); // no image bytes over the socket

    // No ack from phone: it is resent with backoff.
    const again = await a.next((m) => m.t === 'notification', 1500);
    expect(again.n.id).toBe(first.n.id);

    // Tablet acks immediately: stop resending to it.
    const tb = await b.next((m) => m.t === 'notification');
    b.send({ t: 'ack', ids: [tb.n.id] });
    await b.next((m) => m.t === 'ack.ok');

    a.send({ t: 'ack', ids: [first.n.id] });
    await a.next((m) => m.t === 'ack.ok');
    a.messages.length = 0;
    b.messages.length = 0;
    await sleep(600);
    expect(a.notifications().length).toBe(0);
    expect(b.notifications().length).toBe(0);

    const states = s.app.notifications.deliveryStates(first.n.id) as Array<{ state: string; attempts: number }>;
    expect(states.map((x) => x.state).sort()).toEqual(['received', 'received']);

    // Read on the phone -> read for the user everywhere, pushed to the tablet.
    a.send({ t: 'read', ids: [first.n.id] });
    const readMsg = await b.next((m) => m.t === 'notification.read');
    expect(readMsg.id).toBe(first.n.id);
    expect((s.app.notifications.deliveryStates(first.n.id) as Array<{ state: string }>).every((x) => x.state === 'read')).toBe(true);

    // The signed image URL works without a bearer token; a tampered one does not.
    expect((await fetch(s.base + first.n.imageUrl)).status).toBe(200);
    expect((await fetch(s.base + first.n.imageUrl.replace(/sig=./, 'sig=x'))).status).toBe(401);
    a.close();
    b.close();
  });

  it('flushes pending notifications on reconnect and survives a server restart', async () => {
    const s1 = await startApp(undefined, { baseMs: 60_000 });
    const t = await setupAndLogin(s1.base);
    const { detector } = await addCamera(s1, t.accessToken);
    detector.feed(personFrame(1, 1)); // device offline
    await sleep(50);
    const [pending] = s1.app.notifications.list(t.deviceId, {});
    expect(pending.state).toBe('pending');

    // Delivered once, then the client drops without acking.
    const c1 = await TestClient.connect(s1.base, t.accessToken);
    expect((await c1.next((m) => m.t === 'notification')).n.id).toBe(pending.id);
    c1.ws.terminate();
    await s1.app.stop();

    // Restart on the same data directory.
    const s2 = await boot(s1.dataDir);
    const refreshed = (await api(s2.base, '/api/auth/refresh', { body: { refreshToken: t.refreshToken } })).body;
    const c2 = await TestClient.connect(s2.base, refreshed.accessToken);
    const welcome = await c2.next((m) => m.t === 'welcome');
    expect(welcome.unread).toBe(1);
    const n = await c2.next((m) => m.t === 'notification');
    expect(n.n.id).toBe(pending.id);
    c2.send({ t: 'ack', ids: [n.n.id] });
    await c2.next((m) => m.t === 'ack.ok');
    expect((s2.app.notifications.deliveryStates(n.n.id) as Array<{ state: string; attempts: number }>)[0]).toMatchObject({ state: 'received', attempts: 2 });
    c2.close();
  });

  it('terminates clients that stop answering heartbeats', async () => {
    const s = await boot();
    const t = await setupAndLogin(s.base);
    const c = await TestClient.connect(s.base, t.accessToken);
    // Stop replying to pings by removing ws's automatic pong.
    (c.ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners('ping');
    const closed = new Promise((r) => c.ws.once('close', r));
    await closed;
    expect(s.app.gateway.isConnected(t.deviceId)).toBe(false);
  });
});

describe('event deletion', () => {
  it('deletes single and bulk events with frames, notifications and deliveries, and tells clients', async () => {
    const { existsSync } = await import('node:fs');
    const s = await boot();
    const t = await setupAndLogin(s.base);
    const a = await addCamera(s, t.accessToken, 'Front');
    const b = await addCamera(s, t.accessToken, 'Back');
    for (const cam of [a, b]) {
      await api(s.base, `/api/cameras/${cam.camera.id}/settings`, { method: 'PUT', token: t.accessToken, body: { listeners: [{ kind: 'person', cooldownSec: 0 }] } });
      for (let i = 1; i <= 3; i++) { cam.detector.feed(personFrame(i, i)); await sleep(20); }
    }
    await sleep(80);
    expect(s.app.events.list({}).length).toBe(6);
    const client = await TestClient.connect(s.base, t.accessToken);

    const one = s.app.events.list({ cameraId: a.camera.id })[0];
    expect(existsSync(one.imagePath!)).toBe(true);
    expect((await api(s.base, `/api/events/${one.id}`, { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(existsSync(one.imagePath!)).toBe(false);
    const msg = await client.next((m) => m.t === 'events.deleted');
    expect(msg.eventIds).toEqual([one.id]);
    expect(msg.notificationIds.length).toBe(1);
    expect((await api(s.base, `/api/events/${one.id}`, { method: 'DELETE', token: t.accessToken })).status).toBe(404);

    // "Select all" scoped to one camera leaves the other camera alone.
    const r = await api(s.base, '/api/events/delete', { token: t.accessToken, body: { all: true, cameraId: a.camera.id } });
    expect(r.body.deleted).toBe(2);
    expect(s.app.events.list({}).map((e) => e.cameraId)).toEqual([b.camera.id, b.camera.id, b.camera.id]);
    const orphans = s.app.db.prepare('SELECT COUNT(*) AS c FROM deliveries d LEFT JOIN notifications n ON n.id = d.notification_id WHERE n.id IS NULL').get() as { c: number };
    expect(orphans.c).toBe(0);

    expect((await api(s.base, '/api/events/delete', { token: t.accessToken, body: {} })).status).toBe(400);
    client.close();
  });
});
