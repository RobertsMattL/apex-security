import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerRoutes, signedImageUrl } from './api/routes.js';
import { AuthService } from './auth/AuthService.js';
import { CameraManager } from './cameras/CameraManager.js';
import type { Config } from './config.js';
import { openDatabase } from './db/database.js';
import { DetectionEngine, type DetectorFactory } from './detection/DetectionEngine.js';
import { ListenerRegistry } from './detection/listeners/index.js';
import { SidecarDetector } from './detection/SidecarDetector.js';
import { EventManager } from './events/EventManager.js';
import { FfmpegClipRecorder, type ClipRecorder } from './events/ClipRecorder.js';
import { NotificationService, type RetryPolicy } from './notifications/NotificationService.js';
import { TacticalRtspAdapter } from './rtsp/TacticalRtspAdapter.js';
import { Bus } from './util/bus.js';
import { logger } from './util/log.js';
import { Secrets } from './util/secrets.js';
import { Gateway } from './ws/Gateway.js';
import { LiveStreamer } from './live/LiveStreamer.js';
import { registerWebApp } from './api/webapp.js';

const log = logger('app');

export interface AppOptions {
  /** Start MediaMTX / camera streaming (tests turn this off). */
  streaming?: boolean;
  detectorFactory?: DetectorFactory;
  retryPolicy?: RetryPolicy;
  heartbeatMs?: number;
  notificationTickMs?: number;
  /** Event clip recorder; defaults to ffmpeg when streaming is on, none otherwise. */
  clipRecorder?: ClipRecorder | null;
}

/** Wires the modules together. Every module talks to the others through the interfaces it was given. */
export async function createApp(config: Config, opts: AppOptions = {}) {
  const db = openDatabase(join(config.dataDir, 'seccam.db'));
  const secrets = Secrets.load(join(config.dataDir, 'secret.key'));
  const bus = new Bus();
  const registry = new ListenerRegistry();
  const auth = new AuthService(db, secrets);

  const rtsp = new TacticalRtspAdapter(config, secrets, (cameraId, token) => auth.verifyStream(token, cameraId));
  const cameras = new CameraManager(db, secrets, rtsp, registry, bus, config);
  const notifications = new NotificationService(db, cameras, registry, bus, (eventId) => signedImageUrl(secrets, eventId), opts.retryPolicy);
  const clips =
    opts.clipRecorder !== undefined ? opts.clipRecorder : opts.streaming === false ? null : new FfmpegClipRecorder(config.ffmpeg, (id) => rtsp.internalReadUrl(id), config.ffprobe);
  const events = new EventManager(db, cameras, registry, bus, config.dataDir, notifications, clips);
  const factory: DetectorFactory =
    opts.detectorFactory ?? ((cameraId, minConf) => new SidecarDetector(cameraId, rtsp.internalReadUrl(cameraId), config, minConf));
  const detection = new DetectionEngine(cameras, bus, factory, events);

  const https = config.tlsCert && config.tlsKey ? { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) } : null;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false, ...(https ? { https } : {}) });
  const gateway = new Gateway(auth, notifications, bus, { heartbeatMs: opts.heartbeatMs });
  notifications.attach(gateway);
  const live = new LiveStreamer(auth, cameras, rtsp, config.ffmpeg);
  registerWebApp(app);
  registerRoutes(app, { config, auth, cameras, events, notifications, rtsp, secrets, onDeviceRevoked: (id) => gateway.disconnectDevice(id) });

  const start = async () => {
    await app.listen({ host: config.host, port: config.port });
    gateway.attach(app.server as Server);
    live.attach(app.server as Server);
    const proto = https ? 'https' : 'http';
    log.info(`API + WebSocket on ${proto}://${config.host}:${(app.server.address() as { port: number }).port} (ws path /ws, live /live, web app /)`);
    if (!auth.hasUsers()) log.warn('no users yet: POST /api/setup {username, password} or use the app to create the admin account');
    if (opts.streaming !== false) {
      await rtsp.start();
      cameras.start();
      if (config.detector.enabled) detection.start();
      else log.warn('detection disabled (DETECTOR_ENABLED=false)');
    }
    notifications.start(opts.notificationTickMs);
  };

  const stop = async () => {
    notifications.stop();
    cameras.stop();
    gateway.close();
    live.close();
    await detection.stop();
    clips?.stopAll();
    await app.close();
    if (opts.streaming !== false) await rtsp.stop();
    db.close();
  };

  return { app, start, stop, db, bus, auth, cameras, events, notifications, detection, gateway, rtsp, secrets, registry };
}

export type App = Awaited<ReturnType<typeof createApp>>;
