import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DetectionFrame, Detector, DetectorState } from '../src/detection/types.js';

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'seccam-test-'));
}

/** A detector that emits whatever frames the test feeds it and "captures" a tiny JPEG. */
export class FakeDetector extends EventEmitter implements Detector {
  snaps: string[] = [];
  constructor(readonly cameraId: string) {
    super();
  }
  start() {
    this.emit('state', 'connected' satisfies DetectorState);
  }
  async stop() {}
  async snapshot(eventId: string, _seq: number, path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    this.snaps.push(eventId);
    return true;
  }
  feed(f: Omit<DetectionFrame, 'cameraId'>) {
    this.emit('frame', { ...f, cameraId: this.cameraId });
  }
}

export async function startApp(dataDir = tempDir(), opts: { baseMs?: number } = {}) {
  const detectors = new Map<string, FakeDetector>();
  const app = await createApp(loadConfig({ dataDir, port: 0, host: '127.0.0.1', mediamtx: { apiPort: 1 } as never }), {
    streaming: false,
    detectorFactory: (id) => {
      const d = new FakeDetector(id);
      detectors.set(id, d);
      return d;
    },
    retryPolicy: { baseMs: opts.baseMs ?? 100, maxMs: 400, expireAfterMs: 3600_000, jitter: 0 },
    notificationTickMs: 25,
    heartbeatMs: 200,
  });
  await app.start();
  const port = (app.app.server.address() as { port: number }).port;
  return { app, port, base: `http://127.0.0.1:${port}`, dataDir, detectors };
}

export async function api<T = any>(base: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(base + path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

export async function setupAndLogin(base: string, deviceName = 'phone', deviceId?: string) {
  await api(base, '/api/setup', { body: { username: 'admin', password: 'correct-horse' } });
  const r = await api(base, '/api/auth/login', { body: { username: 'admin', password: 'correct-horse', deviceName, deviceId } });
  return r.body as { accessToken: string; refreshToken: string; deviceId: string; userId: string };
}

/** WebSocket test client that records every message. */
export class TestClient {
  messages: any[] = [];
  ws!: WebSocket;
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];

  static async connect(base: string, token: string) {
    const c = new TestClient();
    c.ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      c.messages.push(m);
      c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    await new Promise<void>((res, rej) => {
      c.ws.once('open', () => res());
      c.ws.once('error', rej);
    });
    return c;
  }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const hit = this.messages.find(pred);
    if (hit) {
      this.messages.splice(this.messages.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }

  notifications() {
    return this.messages.filter((m) => m.t === 'notification');
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function personFrame(seq: number, id: number | null, conf = 0.9, cls = 'person') {
  return { seq, ts: Date.now(), w: 1280, h: 720, tracks: [{ id, cls, conf, box: [10, 10, 100, 200] as [number, number, number, number] }] };
}

export type { App };
