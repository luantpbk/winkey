#!/bin/bash
TARGET="${1:-http://100.113.240.3:30080}"
HOST_HEADER="${2:-winkey-media.winkey.vn}"
VID="01a0f6df-f3ab-77f9-a673-03efade93dff"

FILES=(
  "v/${VID}/a1/hls/master.m3u8"
  "v/${VID}/a1/hls/720p/seg_00000.m4s"
  "v/${VID}/a1/hls/720p/init_0.mp4"
  "v/${VID}/a1/thumb/poster.jpg"
  "v/${VID}/a1/storyboard/storyboard.vtt"
)

for file in "${FILES[@]}"; do
  echo "=========================================================="
  echo "FILE: ${file}"
  echo "=========================================================="
  curl -sI -H "Host: ${HOST_HEADER}" "${TARGET}/${file}"
  echo ""
done
