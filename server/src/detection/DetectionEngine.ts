import type { CameraManager } from '../cameras/CameraManager.js';
import type { Bus } from '../util/bus.js';
import { logger } from '../util/log.js';
import type { Detector } from './types.js';

const log = logger('detection');

export type DetectorFactory = (cameraId: string, minConfidence: number) => Detector;

export interface FrameSink {
  handleFrame(frame: import('./types.js').DetectionFrame, detector: Detector): void;
  resetCamera(cameraId: string): void;
}

/**
 * Detection Engine: keeps exactly one detector running for each enabled camera that
 * has at least one detection listener enabled, and feeds their frames to the event
 * manager. Detectors run out of process, so inference never blocks streaming or the
 * WebSocket gateway.
 */
export class DetectionEngine {
  private detectors = new Map<string, { det: Detector; minConf: number }>();
  private reconciling = new Map<string, Promise<void>>();

  constructor(
    private cameras: CameraManager,
    private bus: Bus,
    private factory: DetectorFactory,
    private sink: FrameSink,
  ) {
    bus.on('camera.upserted', (c) => this.reconcile(c.id));
    bus.on('camera.removed', (id) => this.reconcile(id));
    bus.on('settings.updated', (id) => this.reconcile(id));
  }

  start() {
    for (const c of this.cameras.list()) this.reconcile(c.id);
  }

  async stop() {
    await Promise.all([...this.detectors.values()].map((d) => d.det.stop()));
    this.detectors.clear();
  }

  /** Serialised per camera so rapid setting changes don't race. */
  reconcile(cameraId: string): Promise<void> {
    const prev = this.reconciling.get(cameraId) ?? Promise.resolve();
    const next = prev.then(() => this.doReconcile(cameraId)).catch((e) => log.error(`reconcile ${cameraId}`, e));
    this.reconciling.set(cameraId, next);
    return next;
  }

  private async doReconcile(cameraId: string) {
    const running = this.detectors.get(cameraId);
    const want = this.cameras.exists(cameraId) && this.cameras.wantsDetection(cameraId);
    const minConf = want ? Math.min(...this.cameras.listenerSettings(cameraId).filter((l) => l.enabled).map((l) => l.minConfidence)) : 1;

    // The detector pre-filters at min(0.25, lowest threshold): restart only if a threshold dropped below that.
    if (running && (!want || minConf < Math.min(0.25, running.minConf))) {
      this.detectors.delete(cameraId);
      await running.det.stop();
      if (this.cameras.exists(cameraId)) this.cameras.setDetectorState(cameraId, 'off');
      log.info(`detector stopped for ${cameraId}`);
    }
    if (want && !this.detectors.has(cameraId)) {
      const det = this.factory(cameraId, minConf);
      det.on('frame', (f) => this.sink.handleFrame(f, det));
      det.on('reset', () => this.sink.resetCamera(cameraId));
      det.on('state', (s, msg) => {
        if (!this.cameras.exists(cameraId)) return;
        const mapped = s === 'connected' ? 'running' : s === 'error' ? 'error' : s === 'stopped' ? 'off' : 'starting';
        this.cameras.setDetectorState(cameraId, mapped, msg);
      });
      this.detectors.set(cameraId, { det, minConf });
      det.start();
      log.info(`detector started for ${cameraId}`);
    }
  }

  isRunning(cameraId: string) {
    return this.detectors.has(cameraId);
  }
}
