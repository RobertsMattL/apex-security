import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('clips');

/** Records a short clip of a camera, starting now, for one event. */
export interface ClipRecorder {
  /** Resolves with the recorded duration in seconds, or null if nothing usable was recorded. */
  record(eventId: string, cameraId: string, path: string, seconds: number): Promise<number | null>;
  /** Stop recordings for these events (they were deleted) and drop their files. */
  cancel(eventIds: string[]): void;
  stopAll(): void;
}

/**
 * ffmpeg reads the camera's MediaMTX path (the loopback hop the detector also uses)
 * and stream-copies `seconds` of video into an MP4. No re-encode, so it costs almost
 * nothing; ffmpeg skips packets before the first keyframe so the clip starts clean.
 * `+faststart` puts the index first so browsers and ExoPlayer can play it progressively.
 */
export class FfmpegClipRecorder implements ClipRecorder {
  private active = new Map<string, { proc: ChildProcess; path: string; cancelled: boolean }>();

  constructor(
    private ffmpeg: string,
    private readUrl: (cameraId: string) => string,
    private ffprobe: string,
  ) {}

  record(eventId: string, cameraId: string, path: string, seconds: number): Promise<number | null> {
    mkdirSync(dirname(path), { recursive: true });
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-rtsp_transport', 'tcp',
        '-i', this.readUrl(cameraId),
        '-t', String(seconds),
        '-map', '0:v:0', '-c:v', 'copy', '-an',
        '-movflags', '+faststart',
        '-f', 'mp4', path,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const entry = { proc, path, cancelled: false };
      this.active.set(eventId, entry);
      let err = '';
      proc.stderr!.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
      // Give the RTSP connect and first keyframe some slack before giving up.
      const timer = setTimeout(() => proc.kill('SIGKILL'), (seconds + 20) * 1000);
      const finish = async (code: number | null) => {
        clearTimeout(timer);
        this.active.delete(eventId);
        if (entry.cancelled) return resolve(null);
        const size = (() => { try { return statSync(path).size; } catch { return 0; } })();
        if (code !== 0 || size < 1024) {
          log.warn(`clip for ${eventId.slice(0, 8)} failed (exit ${code}): ${err.trim().replace(/rtsps?:\/\/\S+/g, '<url>') || 'no data'}`);
          await unlink(path).catch(() => {});
          return resolve(null);
        }
        resolve((await this.duration(path)) ?? seconds);
      };
      proc.on('error', () => finish(-1));
      proc.on('close', (code) => void finish(code));
    });
  }

  private duration(path: string): Promise<number | null> {
    return new Promise((resolve) => {
      const p = spawn(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const n = Number.parseFloat(out);
        resolve(Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
      });
    });
  }

  cancel(eventIds: string[]) {
    for (const id of eventIds) {
      const a = this.active.get(id);
      if (!a) continue;
      a.cancelled = true;
      a.proc.kill('SIGKILL');
      void unlink(a.path).catch(() => {});
    }
  }

  stopAll() {
    this.cancel([...this.active.keys()]);
  }
}
