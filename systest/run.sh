#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_DIR="${SCRIPT_DIR}/.run"
KEYS_DIR="${RUN_DIR}/keys"
LOGS_DIR="${RUN_DIR}/logs"
CLIP_PATH="${RUN_DIR}/clip.mp4"

RESET=0

for arg in "$@"; do
  case "$arg" in
    --reset)
      RESET=1
      ;;
    *)
      ;;
  esac
done

mkdir -p "${KEYS_DIR}" "${LOGS_DIR}"

if [ "${RESET}" -eq 1 ]; then
  echo "[systest] Resetting dev stack and volumes..."
  docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" down -v --remove-orphans || true
  rm -rf "${RUN_DIR:?}"/*
  mkdir -p "${KEYS_DIR}" "${LOGS_DIR}"
fi

# 1. Secret Generation (openssl)
if [ ! -f "${KEYS_DIR}/jwt_private.pem" ]; then
  echo "[systest] Generating RSA JWT keys and secrets in .run/keys/..."
  openssl genrsa -out "${KEYS_DIR}/jwt_private.pem" 2048 2>/dev/null
  openssl rsa -in "${KEYS_DIR}/jwt_private.pem" -pubout -out "${KEYS_DIR}/jwt_public.pem" 2>/dev/null
fi

if [ ! -f "${KEYS_DIR}/cookie_secret.txt" ]; then
  openssl rand -hex 32 > "${KEYS_DIR}/cookie_secret.txt"
fi

if [ ! -f "${KEYS_DIR}/media_link_secret.txt" ]; then
  openssl rand -hex 32 > "${KEYS_DIR}/media_link_secret.txt"
fi

export JWT_PRIVATE_KEY
JWT_PRIVATE_KEY="$(cat "${KEYS_DIR}/jwt_private.pem")"
export COOKIE_SECRET
COOKIE_SECRET="$(cat "${KEYS_DIR}/cookie_secret.txt" | tr -d '[:space:]')"
export MEDIA_LINK_SECRET
MEDIA_LINK_SECRET="$(cat "${KEYS_DIR}/media_link_secret.txt" | tr -d '[:space:]')"

# 2. Start infra and export Garage S3 keys
echo "[systest] Ensuring infrastructure and S3 keys are ready..."
docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" up -d garage-bootstrap postgres migrate valkey nats nats-bootstrap traefik whoami media-cache

GEN_ENV="${REPO_ROOT}/deploy/compose/.generated.env"
for _ in $(seq 1 30); do
  if [ -f "${GEN_ENV}" ]; then
    break
  fi
  sleep 1
done

if [ -f "${GEN_ENV}" ]; then
  set -a
  # shellcheck source=/dev/null
  source "${GEN_ENV}"
  set +a
  export S3_ACCESS_KEY="${S3_ACCESS_KEY:-${AWS_ACCESS_KEY_ID:-GK000000000000000000000000}}"
  export S3_SECRET_KEY="${S3_SECRET_KEY:-${AWS_SECRET_ACCESS_KEY:-0000000000000000000000000000000000000000000000000000000000000000}}"
fi

# 3. Bring up full stack with apps override
echo "[systest] Building and starting all services..."
docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" up -d --build --wait

# 3b. Poll /readyz for services without internal healthcheck (3002, 3003, 8081)
echo "[systest] Polling /readyz endpoints for upload-svc, video-svc, transcoder..."
for port in 3002 3003 8081; do
  READY=0
  for _ in $(seq 1 120); do
    if curl -s "http://127.0.0.1:${port}/readyz" | grep -q '"status":"ok"' || curl -s "http://127.0.0.1:${port}/readyz" | grep -q '"status":"UP"'; then
      READY=1
      break
    fi
    sleep 1
  done
  if [ "${READY}" -ne 1 ]; then
    echo "[systest] ERROR: Service on port ${port} did not become ready in 120s" >&2
    exit 1
  fi
done

# 4. Generate 10s 720p test clip if not present
if [ ! -f "${CLIP_PATH}" ]; then
  echo "[systest] Generating 10s 720p test video clip with transcoder FFmpeg..."
  docker run --rm -v "${RUN_DIR}:/out" transcoder \
    ffmpeg -y \
    -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
    -f lavfi -i sine=frequency=1000:duration=10 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    /out/clip.mp4 2>/dev/null
fi

# 5. Execute Node 22 system test suite
echo "[systest] Running end-to-end black box test suite..."
SUITE_EXIT=0
export CLIP_PATH="${CLIP_PATH}"

node --test "${SCRIPT_DIR}/suite/index.mjs" || SUITE_EXIT=$?

# 6. Dump app container logs on failure
if [ "${SUITE_EXIT}" -ne 0 ]; then
  echo "[systest] Suite failed! Dumping logs to ${LOGS_DIR}..."
  for app in auth-svc upload-svc video-svc social-svc realtime-svc transcoder traefik postgres; do
    docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" logs "${app}" > "${LOGS_DIR}/${app}.log" 2>&1 || true
  done
fi

exit "${SUITE_EXIT}"
