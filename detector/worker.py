"""Detection sidecar for one camera.

Reuses tacticalRtsp's detection stack unmodified (vendor/tacticalRtsp/yolo):
  - stream.LatestFrame   drop-stale RTSP reader
  - stream.detect        YOLO + BoT-SORT re-ID tracking with voted labels (tracks.TrackLabels)
  - reid_fast.install    fast re-ID features on MPS
  - overlay.render       tactical brackets/labels/HUD, used for the event snapshots

stream.py is imported as a module. It reads its settings from the environment at
import time, so the Node server sets SRC_URL / YOLO_* before spawning this worker.
It never publishes a stream: OUT_URL is a placeholder that is never opened.

Protocol (JSON lines):
  stdout -> server  {"t":"ready"} {"t":"status","state":"connected"|"error","msg"}
                    {"t":"reset"} (new connection: track ids start over)
                    {"t":"det","seq","ts","w","h","tracks":[{"id","cls","conf","box"}]}
                    {"t":"hb","fps","inferMs"} {"t":"snap","id","ok","error"?}
  stdin  <- server  {"t":"snap","id","seq","path","maxWidth"?}
"""

import contextlib
import json
import os
import sys
import threading
import time
from collections import OrderedDict

# The protocol owns the real stdout; everything else printed (Ultralytics, cv2) goes to stderr.
_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

YOLO_DIR = os.environ.get("TACTICAL_YOLO_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "vendor", "tacticalRtsp", "yolo"
)
sys.path.insert(0, os.path.abspath(YOLO_DIR))
os.environ.setdefault("OUT_URL", "rtsp://127.0.0.1:1/unused")  # required by stream.py, never opened
if not os.environ.get("SRC_URL"):
    sys.exit("SRC_URL is required")

DETECT_FPS = float(os.environ.get("DETECT_FPS", "5"))
DETECT_WIDTH = int(os.environ.get("DETECT_WIDTH", "1280"))  # frames are scaled to this before detection
DECODER = os.environ.get("DETECT_DECODER", "ffmpeg")  # "opencv" = tacticalRtsp's LatestFrame
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


def scaled_tracker_config():
    """tacticalRtsp's botsort_reid.yaml counts track_buffer in frames at 30 fps (90 = ~3 s).
    We sample fewer frames per second, so scale it to keep the same time window; otherwise a
    lost track would linger 30/fps times longer and absorb unrelated objects."""
    src = os.path.join(os.path.abspath(YOLO_DIR), "botsort_reid.yaml")
    if os.environ.get("YOLO_TRACKER") or not os.path.exists(src) or DETECT_FPS >= 30:
        return
    lines = []
    for line in open(src):
        if line.strip().startswith("track_buffer:"):
            frames = int(line.split(":", 1)[1].split("#")[0])
            line = f"track_buffer: {max(3, round(frames * DETECT_FPS / 30))} # scaled from {frames} @30fps to {DETECT_FPS:g} fps\n"
        lines.append(line)
    import tempfile
    path = os.path.join(tempfile.gettempdir(), f"seccam_botsort_reid_{DETECT_FPS:g}fps.yaml")
    with open(path, "w") as f:
        f.writelines(lines)
    os.environ["YOLO_TRACKER"] = path


scaled_tracker_config()

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from ultralytics import YOLO  # noqa: E402

import overlay  # noqa: E402  (tacticalRtsp)
import reid_fast  # noqa: E402  (tacticalRtsp)
import stream  # noqa: E402  (tacticalRtsp)

HISTORY = 30  # recent frames kept for snapshot requests

_lock = threading.Lock()
_emit_lock = threading.Lock()
_frames = OrderedDict()  # seq -> (frame, dets)
_perf = {"fps": 0.0, "infer_ms": 0.0}


def emit(obj):
    with _emit_lock:
        _proto.write(json.dumps(obj, separators=(",", ":")) + "\n")
        _proto.flush()


def log(msg):
    print(f"[detector] {msg}", file=sys.stderr, flush=True)


def write_snapshot(req):
    with _lock:
        item = _frames.get(req["seq"]) or (next(reversed(_frames.values())) if _frames else None)
    if item is None:
        return emit({"t": "snap", "id": req["id"], "ok": False, "error": "no frame"})
    frame, dets = item
    img = overlay.render(frame.copy(), dets, model_name=os.path.basename(stream.MODEL), imgsz=stream.IMGSZ,
                         conf=stream.CONF, fps=_perf["fps"], infer_ms=_perf["infer_ms"], tracker=stream.TRACKER_NAME)
    max_w = int(req.get("maxWidth") or 1280)
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
    os.makedirs(os.path.dirname(req["path"]), exist_ok=True)
    tmp = req["path"] + ".tmp.jpg"
    ok = cv2.imwrite(tmp, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if ok:
        os.replace(tmp, req["path"])
    emit({"t": "snap", "id": req["id"], "ok": bool(ok)})


def stdin_loop():
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if req.get("t") == "snap":
                write_snapshot(req)
        except Exception as e:  # never let a bad request kill the worker
            log(f"bad request: {e}")
            if isinstance(req, dict) and req.get("id"):
                emit({"t": "snap", "id": req["id"], "ok": False, "error": str(e)})
    os._exit(0)  # server went away


class FfmpegFrames:
    """Drop-in for stream.LatestFrame that does far less work.

    OpenCV decodes every frame of the full-resolution stream on the CPU (a 1440p camera
    at 20 fps), and we then discard all but DETECT_FPS of them. Here ffmpeg decodes in
    hardware where available (VideoToolbox on macOS), drops frames down to DETECT_FPS
    and scales to DETECT_WIDTH before anything reaches Python.
    """

    # Full GPU path (decode + scale on VideoToolbox, download only DETECT_FPS frames).
    # Cleared if a stream yields nothing that way, falling back to GPU decode + CPU scale.
    gpu_scale = sys.platform == "darwin"

    def __init__(self, url):
        import subprocess
        self.url = url
        w, h = self._probe(url)
        self.w = min(DETECT_WIDTH, w)
        self.h = int(round(h * self.w / w / 2)) * 2
        args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp"]
        if FfmpegFrames.gpu_scale:
            args += ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"]
            vf = f"fps={DETECT_FPS:g},scale_vt={self.w}:{self.h},hwdownload,format=nv12"
        else:
            if sys.platform == "darwin":
                args += ["-hwaccel", "videotoolbox"]
            vf = f"fps={DETECT_FPS:g},scale={self.w}:{self.h}:flags=fast_bilinear"
        args += ["-i", url, "-an", "-sn", "-vf", vf,
                 "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0
        self.alive = True
        threading.Thread(target=self._run, daemon=True).start()

    @staticmethod
    def _probe(url):
        import subprocess
        out = subprocess.run([FFPROBE, "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height", "-of", "csv=p=0", url],
                             capture_output=True, text=True, timeout=15).stdout.strip().splitlines()
        if not out or "," not in out[0]:
            raise RuntimeError("cannot open source (probe failed)")
        w, h = (int(x) for x in out[0].split(",")[:2])
        return w, h

    def _run(self):
        size = self.w * self.h * 3
        buf = bytearray(size)
        view = memoryview(buf)
        while self.alive:
            got = 0
            while got < size:
                n = self.proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got < size:
                break
            frame = np.frombuffer(bytes(buf), np.uint8).reshape(self.h, self.w, 3)
            with self.cond:
                self.frame = frame
                self.seq += 1
                self.cond.notify()
        if self.seq == 0 and FfmpegFrames.gpu_scale:
            FfmpegFrames.gpu_scale = False
            log("GPU scaling produced no frames; falling back to CPU scaling")
        with self.cond:
            self.alive = False
            self.cond.notify()
        self.proc.kill()

    def next(self, after_seq):
        with self.cond:
            while self.alive and self.seq <= after_seq:
                if not self.cond.wait(timeout=8):
                    raise RuntimeError("no frames from source for 8s")
            if not self.alive:
                raise RuntimeError("source stream ended")
            return self.frame, self.seq

    def close(self):
        self.alive = False
        self.proc.kill()


def run(model):
    src = stream.LatestFrame(stream.SRC_URL) if DECODER == "opencv" else FfmpegFrames(stream.SRC_URL)
    emit({"t": "status", "state": "connected"})
    emit({"t": "reset"})
    stream.track_labels.reset()
    persist, seq, last_run, last_hb = False, 0, 0.0, 0.0
    fps, infer_ms = 0.0, 0.0
    interval = 1.0 / DETECT_FPS if DETECT_FPS > 0 else 0
    try:
        while True:
            frame, seq = src.next(seq)
            now = time.time()
            if now - last_run < interval:
                continue
            fps = 0.8 * fps + 0.2 / max(now - last_run, 1e-6) if last_run else 0.0
            last_run = now
            t0 = time.time()
            dets = stream.detect(model, frame, persist)
            persist = True
            infer_ms = (time.time() - t0) * 1000
            _perf.update(fps=fps, infer_ms=infer_ms)
            with _lock:
                _frames[seq] = (frame, dets)
                while len(_frames) > HISTORY:
                    _frames.popitem(last=False)
            if dets:
                h, w = frame.shape[:2]
                emit({"t": "det", "seq": seq, "ts": int(now * 1000), "w": w, "h": h, "tracks": [
                    {"id": tid, "cls": cls, "conf": round(conf, 3), "box": [round(v) for v in box]}
                    for box, conf, cls, tid in dets
                ]})
            if now - last_hb > 5:
                emit({"t": "hb", "fps": round(fps, 1), "inferMs": round(infer_ms, 1)})
                last_hb = now
    finally:
        src.close()


def main():
    with contextlib.redirect_stdout(sys.stderr):
        model = YOLO(stream.MODEL)
        if stream.TRACKER != "none":
            reid_fast.install(model)
        stream.detect(model, np.zeros((stream.IMGSZ, stream.IMGSZ, 3), np.uint8), persist=False)
    log(f"model={stream.MODEL} device={stream.DEVICE} imgsz={stream.IMGSZ} conf={stream.CONF} "
        f"tracker={stream.TRACKER_NAME} fps={DETECT_FPS}")
    emit({"t": "ready", "model": stream.MODEL, "device": stream.DEVICE})
    threading.Thread(target=stdin_loop, daemon=True).start()
    while True:
        try:
            run(model)
        except (RuntimeError, OSError) as e:
            emit({"t": "status", "state": "error", "msg": str(e)})
            time.sleep(3)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        main()
