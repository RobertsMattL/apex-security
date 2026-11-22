#!/usr/bin/env bash
# Builds two looping test clips with people / animals from public sample images
# (Ultralytics' zidane.jpg + bus.jpg, COCO val2017 #39769 "two cats").
set -euo pipefail
cd "$(dirname "$0")/.."
out=data/testmedia; mkdir -p "$out/src"
fetch() { [ -s "$out/src/$1" ] || curl -sSfL -o "$out/src/$1" "$2"; }
fetch people.jpg https://github.com/ultralytics/assets/releases/download/v0.0.0/zidane.jpg
fetch bus.jpg    https://github.com/ultralytics/assets/releases/download/v0.0.0/bus.jpg
fetch cats.jpg   http://images.cocodataset.org/val2017/000000039769.jpg
# 8 s empty scene -> 10 s image A -> 8 s empty -> 10 s image B, 1280x720 30 fps H.264, 1 s GOP.
mk() {
  [ -s "$out/$1" ] && return
  ffmpeg -v error -y \
    -f lavfi -t 8 -i "color=c=0x14181c:s=1280x720:r=30" -loop 1 -t 10 -r 30 -i "$out/src/$2" \
    -f lavfi -t 8 -i "color=c=0x14181c:s=1280x720:r=30" -loop 1 -t 10 -r 30 -i "$out/src/$3" \
    -filter_complex "[0]noise=alls=12:allf=t,format=yuv420p[e0];[2]noise=alls=12:allf=t,format=yuv420p[e1];
[1]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x14181c,noise=alls=6:allf=t,format=yuv420p,setsar=1[p0];
[3]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x14181c,noise=alls=6:allf=t,format=yuv420p,setsar=1[p1];
[e0][p0][e1][p1]concat=n=4:v=1:a=0[v]" -map "[v]" -c:v libx264 -preset veryfast -crf 28 -g 30 -profile:v main -pix_fmt yuv420p "$out/$1"
  echo "built $out/$1"
}
mk driveway.mp4 people.jpg bus.jpg
mk backyard.mp4 cats.jpg people.jpg
