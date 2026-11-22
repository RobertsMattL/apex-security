#!/usr/bin/env bash
# Simulates IP cameras: a separate MediaMTX on :8654 (needs RTSP auth, like a real camera)
# with looped test clips published as rtsp://cam:camPass1@127.0.0.1:8654/<name>.
#   scripts/fake-camera.sh                      # driveway + backyard
#   scripts/fake-camera.sh path/to/clip.mp4 ... # your own clips (path name = file name)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${FAKECAM_PORT:-8654}
dir=data/fakecam; mkdir -p "$dir"
if [ $# -eq 0 ]; then scripts/make-test-media.sh; set -- data/testmedia/driveway.mp4 data/testmedia/backyard.mp4; fi
cat > "$dir/mediamtx.yml" <<YML
logLevel: warn
rtspAddress: :$PORT
rtspTransports: [tcp]
rtmp: no
hls: no
webrtc: no
srt: no
moq: no
api: no
authInternalUsers:
  - user: any
    ips: ["127.0.0.1", "::1"]
    permissions: [{action: publish}]
  - user: cam
    pass: camPass1
    permissions: [{action: read}]
paths:
  all_others:
YML
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
mediamtx "$dir/mediamtx.yml" & pids+=($!)
sleep 1
for clip in "$@"; do
  name=$(basename "${clip%.*}")
  ( while true; do
      ffmpeg -v error -re -stream_loop -1 -i "$clip" -c copy -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:$PORT/$name" || true
      sleep 1
    done ) & pids+=($!)
  echo "fake camera: rtsp://cam:camPass1@127.0.0.1:$PORT/$name"
done
wait
