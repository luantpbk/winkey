#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/tmp/node/bin:/usr/local/bin:${PATH}"


export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
export NUM_VIDEOS="${NUM_VIDEOS:-5}"
export NUM_USERS="${NUM_USERS:-5}"

echo "==================================================================="
echo "                  WINKEY LOAD TEST SEEDING                         "
echo "==================================================================="
echo "Gateway URL: ${GATEWAY_URL}"
echo "Videos:      ${NUM_VIDEOS}"
echo "Users:       ${NUM_USERS}"
echo "==================================================================="

# Ensure test clip exists
CLIP_PATH="${REPO_ROOT}/systest/.run/clip.mp4"
if [ ! -f "${CLIP_PATH}" ]; then
  echo "[seed.sh] Clip missing at ${CLIP_PATH}, generating 10s 720p test clip..."
  mkdir -p "${REPO_ROOT}/systest/.run"
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y \
      -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
      -f lavfi -i sine=frequency=1000:duration=10 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
      -c:a aac -b:a 128k \
      "${CLIP_PATH}" 2>/dev/null
  else
    docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${REPO_ROOT}/systest/compose.apps.yml" run --rm --no-deps \
      --entrypoint ffmpeg --user "$(id -u):$(id -g)" -v "${REPO_ROOT}/systest/.run:/out" transcoder \
      -y -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 -f lavfi -i sine=frequency=1000:duration=10 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k /out/clip.mp4
  fi
fi
export CLIP_PATH="${CLIP_PATH}"

echo "[seed.sh] Executing Node seed script..."
node "${SCRIPT_DIR}/seed.mjs"
