import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..', '..');

loadEnvFile(resolve(projectRoot, '.env'));

const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export interface Config {
  host: string;
  port: number;
  /** Optional TLS: when both are set the API/WebSocket are served over HTTPS/WSS. */
  tlsCert?: string;
  tlsKey?: string;
  dataDir: string;
  /** Host name/IP clients use to reach this server (for RTSP URLs handed to clients). */
  publicHost?: string;
  mediamtx: {
    bin: string;
    rtspPort: number;
    /** RTP/RTCP UDP ports for RTSP-over-UDP readers (rtpPort, rtpPort+1). */
    rtpPort: number;
    apiPort: number;
    /** Set false to use an externally managed MediaMTX (config must point auth at us). */
    manage: boolean;
  };
  detector: {
    python: string;
    script: string;
    yoloDir: string;
    model: string;
    imgsz: number;
    fps: number;
    /** Frames are scaled to this width (hardware decode via ffmpeg) before detection. */
    width: number;
    device?: string;
    tracker?: string;
    enabled: boolean;
  };
  ffprobe: string;
  ffmpeg: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const yoloDir = env.TACTICAL_YOLO_DIR ?? resolve(projectRoot, 'vendor', 'tacticalRtsp', 'yolo');
  const base: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: num(env.PORT, 8780),
    tlsCert: env.TLS_CERT || undefined,
    tlsKey: env.TLS_KEY || undefined,
    dataDir: resolve(env.DATA_DIR ?? resolve(projectRoot, 'data')),
    publicHost: env.PUBLIC_HOST || undefined,
    mediamtx: {
      bin: env.MEDIAMTX ?? 'mediamtx',
      rtspPort: num(env.RTSP_PORT, 8564),
      rtpPort: num(env.RTP_PORT, 8010),
      apiPort: num(env.MEDIAMTX_API_PORT, 9987),
      manage: env.MEDIAMTX_MANAGE !== 'false',
    },
    detector: {
      // tacticalRtsp's own venv (ultralytics + torch); override with DETECTOR_PYTHON.
      python: env.DETECTOR_PYTHON ?? resolve(yoloDir, '.venv', 'bin', 'python'),
      script: resolve(projectRoot, 'detector', 'worker.py'),
      yoloDir,
      model: env.DETECTOR_MODEL ?? 'yolo11s.pt',
      imgsz: num(env.DETECTOR_IMGSZ, 1280),
      fps: num(env.DETECTOR_FPS, 5),
      width: num(env.DETECTOR_WIDTH, 1280),
      device: env.DETECTOR_DEVICE || undefined,
      tracker: env.DETECTOR_TRACKER || undefined,
      enabled: env.DETECTOR_ENABLED !== 'false',
    },
    ffprobe: env.FFPROBE ?? 'ffprobe',
    ffmpeg: env.FFMPEG ?? 'ffmpeg',
  };
  return { ...base, ...overrides, mediamtx: { ...base.mediamtx, ...overrides.mediamtx }, detector: { ...base.detector, ...overrides.detector } };
}

/** KEY=VALUE lines from the project's .env; real environment variables win (same rule as tacticalRtsp). */
function loadEnvFile(path: string) {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    const key = line.slice(0, eq).trim();
    process.env[key] ??= line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}
