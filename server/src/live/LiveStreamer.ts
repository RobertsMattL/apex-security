import { spawn } from 'node:child_process';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthService } from '../auth/AuthService.js';
import type { CameraManager } from '../cameras/CameraManager.js';
import type { TacticalRtspAdapter } from '../rtsp/TacticalRtspAdapter.js';
import { logger } from '../util/log.js';

const log = logger('live');

/**
 * Browser live view, using the same technique as tacticalRtsp's web-app/server.js:
 * ffmpeg remuxes the camera's H.264 (no re-encode) from our MediaMTX path into
 * fragmented MP4, sent over a WebSocket and played with Media Source Extensions.
 *
 *   ws://host/live?camera=<id>&token=<access token>
 *   first message: {"codec":"avc1.4D4029"} then binary fMP4 boxes
 */
export class LiveStreamer {
  private wss = new WebSocketServer({ noServer: true });

  constructor(
    private auth: AuthService,
    private cameras: CameraManager,
    private rtsp: TacticalRtspAdapter,
    private ffmpeg: string,
  ) {}

  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket, head));
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/live') return;
    const cameraId = url.searchParams.get('camera') ?? '';
    try {
      await this.auth.verifyAccess(url.searchParams.get('token') ?? '');
      if (!this.cameras.exists(cameraId)) throw new Error('no camera');
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.stream(ws, cameraId, req.socket.remoteAddress ?? '?'));
  }

  private stream(ws: WebSocket, cameraId: string, peer: string) {
    log.info(`viewer ${peer} -> ${cameraId.slice(0, 8)}`);
    const ff = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-rtsp_transport', 'tcp', // loopback hop to MediaMTX
      '-i', this.rtsp.internalReadUrl(cameraId),
      '-an', '-c:v', 'copy',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '50000',
      'pipe:1',
    ]);

    // Split stdout into whole top-level MP4 boxes; send the codec string from moov first.
    let pending = Buffer.alloc(0);
    let boxes: Buffer[] = [];
    let sentCodec = false;
    ff.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(0);
        if (size < 8 || pending.length < size) break;
        boxes.push(pending.subarray(0, size));
        pending = pending.subarray(size);
      }
      if (!boxes.length || ws.readyState !== WebSocket.OPEN) return;
      if (!sentCodec) {
        const moov = boxes.find((b) => b.toString('ascii', 4, 8) === 'moov');
        if (!moov) return;
        ws.send(JSON.stringify({ codec: avcCodecString(moov) }));
        sentCodec = true;
      }
      const out = Buffer.concat(boxes);
      boxes = [];
      if (ws.bufferedAmount > 4 * 1024 * 1024) return; // viewer can't keep up: drop rather than lag
      ws.send(out);
    });
    ff.stderr.on('data', (d) => log.debug(`[ffmpeg] ${d.toString().trim().replace(/rtsps?:\/\/\S+/g, '<url>')}`));
    ff.on('exit', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'stream ended');
    });
    ws.on('close', () => ff.kill('SIGKILL'));
    ws.on('error', () => ff.kill('SIGKILL'));
  }

  close() {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }
}

/** RFC 6381 codec string (e.g. avc1.4D4029) from the avcC box (as in tacticalRtsp). */
function avcCodecString(moov: Buffer) {
  const i = moov.indexOf('avcC');
  if (i === -1) return 'avc1.4D4029';
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(moov[i + 5])}${hex(moov[i + 6])}${hex(moov[i + 7])}`;
}
