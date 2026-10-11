#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export REPO_ROOT
RUN_DIR="${SCRIPT_DIR}/.run"
KEYS_DIR="${RUN_DIR}/keys"
LOGS_DIR="${RUN_DIR}/logs"
CLIP_PATH="${RUN_DIR}/clip.mp4"

RESET=0
SIM=0

for arg in "$@"; do
  case "$arg" in
    --reset)
      RESET=1
      ;;
    --sim)
      SIM=1
      ;;
    *)
      ;;
  esac
done

if [ "${SIM}" -eq 1 ] && ! command -v pnpm >/dev/null 2>&1; then
  echo "[systest] ERROR: 'pnpm' command not found. Please install pnpm (version 12.6.0) before running in --sim mode." >&2
  exit 1
fi

mkdir -p "${KEYS_DIR}" "${LOGS_DIR}" "${RUN_DIR}/report"

if [ "${RESET}" -eq 1 ]; then
  echo "[systest] Resetting dev stack and volumes..."
  docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" down -v --remove-orphans || true
  rm -rf "${RUN_DIR:?}"/*
  mkdir -p "${KEYS_DIR}" "${LOGS_DIR}" "${RUN_DIR}/report"
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

if [ ! -f "${KEYS_DIR}/invite_code.txt" ]; then
  echo "sim-invite-$(openssl rand -hex 8)" > "${KEYS_DIR}/invite_code.txt"
fi

export JWT_PRIVATE_KEY
JWT_PRIVATE_KEY="$(cat "${KEYS_DIR}/jwt_private.pem")"
export COOKIE_SECRET
COOKIE_SECRET="$(cat "${KEYS_DIR}/cookie_secret.txt" | tr -d '[:space:]')"
export MEDIA_LINK_SECRET
MEDIA_LINK_SECRET="$(cat "${KEYS_DIR}/media_link_secret.txt" | tr -d '[:space:]')"
export INVITE_CODE
INVITE_CODE="$(cat "${KEYS_DIR}/invite_code.txt" | tr -d '[:space:]')"

if [ "${SIM}" -eq 1 ]; then
  export REGISTRATION_MODE="invite"
  export INVITE_CODES="${INVITE_CODE}"
else
  export REGISTRATION_MODE="${REGISTRATION_MODE:-open}"
  export INVITE_CODES="${INVITE_CODES:-}"
fi

# 2. Start infra and export Garage S3 keys
echo "[systest] Ensuring infrastructure and S3 keys are ready..."
docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" up -d garage-bootstrap postgres migrate valkey nats nats-bootstrap traefik whoami media-cache mailpit
docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" wait garage-bootstrap >/dev/null 2>&1 || true

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

# 3. Generate 10s 720p test clip if not present
if [ ! -f "${CLIP_PATH}" ]; then
  echo "[systest] Generating 10s 720p test video clip with FFmpeg..."
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y \
      -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
      -f lavfi -i sine=frequency=1000:duration=10 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
      -c:a aac -b:a 128k \
      "${CLIP_PATH}" 2>/dev/null
  else
    docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" run --rm --no-deps \
      --entrypoint ffmpeg --user "$(id -u):$(id -g)" -v "${RUN_DIR}:/out" transcoder \
      -y -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 -f lavfi -i sine=frequency=1000:duration=10 \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 128k /out/clip.mp4
  fi
fi

# 4. Bring up full stack with apps override
echo "[systest] Building and starting all services..."
docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" up -d --build --force-recreate --wait

# 3b. Poll /readyz for services without internal healthcheck (3002, 3003, 8084)
echo "[systest] Polling /readyz endpoints for upload-svc, video-svc, transcoder..."
for port in 3002 3003 8084; do
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

# In --sim mode, also poll web-svc:3000/healthz and gateway :8080/healthz
if [ "${SIM}" -eq 1 ]; then
  echo "[systest] Polling web-svc and gateway health..."
  for _ in $(seq 1 60); do
    if curl -s "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

SUITE_EXIT=0

# 5. Execute 12-scenario API test suite (runs in both default and --sim mode)
echo "[systest] Running 12-scenario API test suite..."
export CLIP_PATH="${CLIP_PATH}"
set +e
node --test "${SCRIPT_DIR}/suite/index.mjs" 2>&1 | tee "${RUN_DIR}/report/systest.tap"
SUITE_EXIT=${PIPESTATUS[0]}
set -e

if [ "${SIM}" -eq 1 ]; then
  echo "==================================================================="
  echo "         SIM1: SIMULATED USERS PIPELINE (ADR-038)                  "
  echo "==================================================================="

  # Step A: Seed
  if [ "${SUITE_EXIT}" -eq 0 ]; then
    echo "[systest] Resetting auth rate limits before seed..."
    "${SCRIPT_DIR}/reset-ratelimits.sh" || true
    echo "[systest] Running deterministic Vietnamese seed (20 users, 40 videos)..."
    node "${SCRIPT_DIR}/seed/seed.mjs" || SUITE_EXIT=$?
  fi

  # Step B: Playwright Personas
  if [ "${SUITE_EXIT}" -eq 0 ]; then
    echo "[systest] Resetting auth rate limits before personas..."
    "${SCRIPT_DIR}/reset-ratelimits.sh" || true
    echo "[systest] Restarting web-svc to clear in-memory sitemap cache..."
    docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" restart web-svc
    for _ in $(seq 1 60); do
      if curl -s "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    echo "[systest] Running Playwright persona journeys against real stack..."
    pnpm --filter e2e exec playwright test --config="${SCRIPT_DIR}/playwright.config.ts" || SUITE_EXIT=$?
  fi

  # Step C: Simulated Concurrency (k6)
  if [ "${SUITE_EXIT}" -eq 0 ]; then
    echo "[systest] Running concurrent simulation profile..."
    "${REPO_ROOT}/loadtest/sim-profile.sh" || SUITE_EXIT=$?
  fi

  # Step D: Performance Budget Comparison
  if [ "${SUITE_EXIT}" -eq 0 ]; then
    echo "[systest] Checking relative performance budget..."
    node "${SCRIPT_DIR}/perf-budget.mjs" || SUITE_EXIT=$?
  fi

  # Step E: Generate summary.md
  node "${SCRIPT_DIR}/build-summary.mjs" || true
fi

# 6. Dump app container logs on failure
if [ "${SUITE_EXIT}" -ne 0 ]; then
  echo "[systest] Suite failed! Dumping logs to ${LOGS_DIR}..."
  for app in auth-svc upload-svc video-svc social-svc realtime-svc transcoder traefik postgres web-svc; do
    docker compose -f "${REPO_ROOT}/deploy/compose/dev.yml" -f "${SCRIPT_DIR}/compose.apps.yml" logs "${app}" > "${LOGS_DIR}/${app}.log" 2>&1 || true
  done
fi

exit "${SUITE_EXIT}"

