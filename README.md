# Apex Security — Tactical Security Camera System

A self-hosted security camera server and Android app built on top of [tacticalRtsp](vendor/tacticalRtsp) (git submodule).

```
RTSP camera ──> MediaMTX (tacticalRtsp's streaming layer, managed by the server)
                  │  path cam_<id>, auto-reconnect, fan-out
                  ├──> detector/worker.py ─ tacticalRtsp yolo/: YOLO + BoT-SORT re-ID + overlay
                  │        │  JSON lines: detections, snapshots (JPEG with tactical overlay)
                  │        ▼
                  │    Event Manager (de-dup per track, threshold, cooldown) ──> SQLite + data/events/*.jpg
                  │        ▼
                  │    Notification Service (per-device delivery, retries w/ backoff, receipts)
                  │        ▼
                  │    WebSocket Gateway  ──────────────>  Android app  ── ack / read ──┐
                  │                                                                     │
                  └──> Android live view (RTSP, short-lived stream token) <─────────────┘
```

## What is reused from tacticalRtsp (unmodified)

| tacticalRtsp | Used for |
|---|---|
| MediaMTX (`pi/mediamtx.yml` approach) | The server runs its own MediaMTX and drives it through the MediaMTX API: one path per camera, automatic source reconnection, fan-out to every viewer and the detector. |
| `yolo/stream.py` `LatestFrame`, `detect()` | Imported by `detector/worker.py`: drop-stale RTSP reader and YOLO + tracker call. |
| `yolo/botsort_reid.yaml`, `reid_fast.py`, `tracks.py` | BoT-SORT with re-identification and voted class labels: each tracked object fires at most one event. The worker scales `track_buffer` to its sample rate. |
| `yolo/overlay.py` | Brackets, labels and HUD drawn on each event's captured frame. |
| `yolo/.venv`, `yolo11s.pt` | The detector runs on tacticalRtsp's Python environment (`DETECTOR_PYTHON`). |

To pick up tacticalRtsp updates: `git submodule update --remote vendor/tacticalRtsp`.

## Layout

```
server/      Node 22 + TypeScript backend
  src/rtsp/TacticalRtspAdapter.ts     MediaMTX lifecycle, paths via API, reader auth hook
  src/cameras/CameraManager.ts        camera CRUD, encrypted credentials, ffprobe test, status
  src/detection/                      DetectionEngine, SidecarDetector, listener registry (person, animal)
  src/events/EventManager.ts          per-track de-dup, thresholds, cooldowns, frame capture, persistence
  src/notifications/                  NotificationService: delivery state machine + retries
  src/ws/Gateway.ts                   authenticated WebSocket, heartbeats, receipts
  src/api/routes.ts                   REST API, signed image URLs, stream tokens
  src/db/database.ts                  SQLite (node:sqlite) + migrations
  test/                               vitest: auth, de-dup/cooldown, delivery/retry/ack/read, restart survival
detector/worker.py                    detection sidecar (one process per camera)
android/                              Kotlin + Jetpack Compose app
scripts/fake-camera.sh                simulated IP cameras (MediaMTX + looped clips, with RTSP auth)
scripts/make-test-media.sh            builds test clips with people / animals
```

## Running

Requirements: Node ≥ 22.13, `ffmpeg`/`ffprobe`, `mediamtx` (`brew install mediamtx`), and a tacticalRtsp YOLO venv.

```bash
git submodule update --init
cp .env.example .env          # set DETECTOR_PYTHON / DETECTOR_MODEL (see comments)
cd server && npm install && npm run dev
```

The server listens on `:8780` (HTTP + WebSocket `/ws`) and starts MediaMTX on RTSP `:8564`, with its API on `127.0.0.1:9987`. These defaults avoid tacticalRtsp's own MediaMTX ports (8554/9997), so both can run at once.

First run: open the app, enter `http://<this-machine-lan-ip>:8780`, tap **Probe**, then create the admin account. Or use curl:

```bash
curl -XPOST localhost:8780/api/setup -H 'content-type: application/json' -d '{"username":"admin","password":"..."}'
```

Try it without a camera:

```bash
scripts/fake-camera.sh   # rtsp://cam:camPass1@127.0.0.1:8654/driveway and /backyard
```

Then add those URLs as cameras in the app. The backyard clip has cats (enable animal detection) and both clips have people.

### Android

```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Notification reliability

- Every detection notification has a UUID and one `deliveries` row per registered device (`pending → delivered → received → read`, or `expired` after 7 days).
- **delivered**: written to the device's socket. **received**: the device acked it, which the app does after saving it locally. **read**: the user opened it. Read state syncs to the user's other devices.
- Unacked deliveries are resent with exponential backoff (2 s, 4 s … capped at 5 min) while the device is connected. Everything un-acked is flushed when a device reconnects. State lives in SQLite, so restarts lose nothing.
- The app keys its inbox on the notification id, so redeliveries never duplicate in the UI.
- WebSocket messages carry a signed, expiring image URL (`/api/images/:eventId?exp&sig`), never image bytes.

## Security

- All REST, WebSocket, image and stream access is authenticated: JWT access tokens (15 min) plus rotating per-device refresh tokens, and a login rate limit.
- Camera credentials are encrypted at rest (AES-256-GCM, key in `data/secret.key`). They're never returned by the API and are only ever sent to MediaMTX over localhost.
- Live view: the app asks for a 10-minute stream token and uses it as the RTSP password against the server's MediaMTX. MediaMTX calls back to the server (`authMethod: http`) to validate it. Tokens are bound to one camera, and are kept short (~35 chars) because many RTSP clients truncate long passwords.
- TLS: set `TLS_CERT`/`TLS_KEY` to serve HTTPS/WSS. Plain HTTP is meant for a trusted LAN only.

## Tests

```bash
cd server && npm test
```
