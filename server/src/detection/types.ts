/** One object reported by a detector for one frame. */
export interface TrackedObject {
  /** Tracker id (stable across frames), or null when tracking is off. */
  id: number | null;
  /** Detector class name, e.g. "person", "dog" (COCO for the stock YOLO models). */
  cls: string;
  conf: number;
  /** [x1, y1, x2, y2] in source-frame pixels. */
  box: [number, number, number, number];
}

export interface DetectionFrame {
  cameraId: string;
  seq: number;
  ts: number;
  w: number;
  h: number;
  tracks: TrackedObject[];
}

/**
 * A detection listener maps detector classes onto one event kind ("person", "animal", ...).
 * Add a new category by registering another listener; per-camera settings rows are
 * created on demand with the listener's defaults, so no schema change is needed.
 */
export interface DetectionListener {
  kind: string;
  label: string;
  matches(cls: string): boolean;
  defaults: { enabled: boolean; notify: boolean; minConfidence: number; cooldownSec: number };
}

export interface ListenerSettings {
  kind: string;
  label: string;
  enabled: boolean;
  notify: boolean;
  minConfidence: number;
  cooldownSec: number;
}

/** A source of detections for one camera (the tacticalRtsp sidecar today; other models later). */
export interface Detector {
  readonly cameraId: string;
  start(): void;
  stop(): Promise<void>;
  /** Ask the detector to write the frame for `seq` (with overlay) as a JPEG. */
  snapshot(eventId: string, seq: number, path: string): Promise<boolean>;
  on(event: 'frame', fn: (f: DetectionFrame) => void): this;
  on(event: 'reset', fn: () => void): this;
  on(event: 'state', fn: (state: DetectorState, msg?: string) => void): this;
}

export type DetectorState = 'starting' | 'ready' | 'connected' | 'error' | 'stopped';
