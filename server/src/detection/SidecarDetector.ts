import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Config } from '../config.js';
import { logger } from '../util/log.js';
import type { DetectionFrame, Detector, DetectorState, TrackedObject } from './types.js';

const log = logger('detector');

/**
 * Runs detector/worker.py (tacticalRtsp's YOLO + BoT-SORT stack) for one camera and
 * speaks its JSON-lines protocol. The worker reads the camera from MediaMTX, so the
 * camera itself only ever has one connection. Restarts with backoff if it dies.
 */
export class SidecarDetector extends EventEmitter implements Detector {
  private proc?: ChildProcess;
  private stopped = false;
  private backoff = 2000;
  private pendingSnaps = new Map<string, (ok: boolean) => void>();
  private state: DetectorState = 'stopped';

  constructor(
    readonly cameraId: string,
    private readUrl: string,
    private config: Config,
    private minConfidence: number,
  ) {
    super();
  }

  start() {
    this.stopped = false;
    this.spawn();
  }

  private setState(s: DetectorState, msg?: string) {
    this.state = s;
    this.emit('state', s, msg);
  }

  private spawn() {
    const d = this.config.detector;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SRC_URL: this.readUrl,
      TACTICAL_YOLO_DIR: d.yoloDir,
      RTSP_TRANSPORT: 'tcp', // local hop to MediaMTX: TCP is lossless and cheap on loopback
      YOLO_MODEL: d.model,
      YOLO_IMGSZ: String(d.imgsz),
      // stream.detect filters by this; listeners apply their own (higher) thresholds after.
      YOLO_CONF: String(Math.min(0.25, this.minConfidence)),
      DETECT_FPS: String(d.fps),
      PYTHONUNBUFFERED: '1',
    };
    if (d.device) env.YOLO_DEVICE = d.device;
    if (d.tracker) env.YOLO_TRACKER = d.tracker;
    this.setState('starting');
    const proc = spawn(d.python, ['-u', d.script], { cwd: d.yoloDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      if (line.trim()) log.debug(`[${this.cameraId.slice(0, 8)}] ${line.replace(/rtsps?:\/\/\S+/g, '<url>')}`);
      if (/Traceback|Error|error/.test(line) && !/retrying/.test(line)) log.warn(`[${this.cameraId.slice(0, 8)}] ${line.replace(/rtsps?:\/\/\S+/g, '<url>').slice(0, 300)}`);
    });
    proc.on('error', (e) => {
      log.error(`cannot start detector (${d.python})`, e);
    });
    proc.on('exit', (code, signal) => {
      for (const done of this.pendingSnaps.values()) done(false);
      this.pendingSnaps.clear();
      if (this.stopped) return this.setState('stopped');
      this.setState('error', `detector exited (${code ?? signal})`);
      log.warn(`detector for ${this.cameraId} exited (${code ?? signal}); restarting in ${this.backoff}ms`);
      setTimeout(() => !this.stopped && this.spawn(), this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'ready':
        log.info(`detector ready for ${this.cameraId} (model=${msg.model} device=${msg.device})`);
        this.setState('ready');
        break;
      case 'status':
        if (msg.state === 'connected') {
          this.backoff = 2000;
          this.setState('connected');
        } else this.setState('error', String(msg.msg ?? 'error'));
        break;
      case 'reset':
        this.emit('reset');
        break;
      case 'det':
        this.emit('frame', {
          cameraId: this.cameraId,
          seq: msg.seq as number,
          ts: msg.ts as number,
          w: msg.w as number,
          h: msg.h as number,
          tracks: msg.tracks as TrackedObject[],
        } satisfies DetectionFrame);
        break;
      case 'snap': {
        const done = this.pendingSnaps.get(msg.id as string);
        this.pendingSnaps.delete(msg.id as string);
        done?.(!!msg.ok);
        break;
      }
      case 'hb':
        if (this.state !== 'connected') this.setState('connected');
        break;
    }
  }

  snapshot(eventId: string, seq: number, path: string): Promise<boolean> {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSnaps.delete(eventId);
        resolve(false);
      }, 5000);
      this.pendingSnaps.set(eventId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      proc.stdin!.write(JSON.stringify({ t: 'snap', id: eventId, seq, path }) + '\n');
    });
  }

  async stop() {
    this.stopped = true;
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 3000).unref();
    });
  }
}
