#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/tmp/node/bin:/usr/local/bin:${PATH}"

TARGET_URL="${TARGET_URL:-https://winkey.vn}"
LT2_INVITE_CODE="${LT2_INVITE_CODE:-}"
LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD:-}"
LEGACY_SITES="${LEGACY_SITES:-}"
COLLECTOR_PORT="${COLLECTOR_PORT:-9999}"

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "==================================================================="
echo "     TASK LT2: PRODUCTION 1,000 CONCURRENT VIEWERS LOAD TEST       "
echo "==================================================================="
echo "Target URL:             ${TARGET_URL}"
echo "Execution Window Rule: 02:00 - 03:30 AM (Vietnam Time, UTC+7, from 2026-10-09)"
echo "Ramp Profile:          50 (5m) -> 200 (5m) -> 500 (5m) -> 1000 (5m) -> 1000 (15m)"
echo "Pass/Fail Criterion:    Aggregate Rebuffer Ratio < 1%, HTTP req failed < 1%"
echo "Safety Rule:           Auto-abort on >5% HTTP errors, RAM < 1GiB, legacy site failure"
echo "==================================================================="

RUN_ID="lt2_$(date +%s)_$$"
CONTAINER_HLS="k6_hls_${RUN_ID}"
CONTAINER_API="k6_api_${RUN_ID}"

is_production=0
if [[ "${TARGET_URL}" != *"localhost"* && "${TARGET_URL}" != *"127.0.0.1"* && "${TARGET_URL}" != *"[::1]"* ]]; then
  is_production=1
fi

# Check execution window (02:00 - 03:30 AM Vietnam time, UTC+7) starting Oct 9, 2026
current_vn_time=$(TZ="Asia/Ho_Chi_Minh" date +"%H%M" 2>/dev/null || date +"%H%M")
if [[ "${is_production}" -eq 1 ]]; then
  if [[ "${current_vn_time}" -lt "0200" || "${current_vn_time}" -gt "0330" ]]; then
    echo "ERROR: Production load test requested outside approved window (02:00 - 03:30 AM VN). Bypassing is PROHIBITED on production." >&2
    exit 1
  fi
elif [[ "${ALLOW_OUTSIDE_WINDOW:-false}" != "true" ]]; then
  if [[ "${current_vn_time}" -lt "0200" || "${current_vn_time}" -gt "0330" ]]; then
    echo "ERROR: Current time (${current_vn_time} VN) is outside approved window (02:00 - 03:30 AM VN)." >&2
    echo "Set ALLOW_OUTSIDE_WINDOW=true to bypass window enforcement for dry runs." >&2
    exit 1
  fi
fi

# Check for production password requirement
if [[ "${is_production}" -eq 1 && -z "${LOADTEST_USER_PASSWORD}" ]]; then
  echo "ERROR: LOADTEST_USER_PASSWORD environment variable is required for production targets." >&2
  exit 1
fi

# 1. Start Comment Collector service in background to log posted comment IDs in real-time
echo "[lt2] Starting comment collector on port ${COLLECTOR_PORT}..."
COLLECTOR_PORT="${COLLECTOR_PORT}" node "${SCRIPT_DIR}/comment-collector.mjs" &
COLLECTOR_PID=$!

# Fail-closed check: Ensure comment collector is responding on healthz
collector_ok=0
for i in {1..5}; do
  if curl -s "http://127.0.0.1:${COLLECTOR_PORT}/healthz" > /dev/null 2>&1; then
    collector_ok=1
    break
  fi
  sleep 1
done

if [[ "${collector_ok}" -ne 1 ]]; then
  echo "ERROR: Comment collector failed to respond on port ${COLLECTOR_PORT}. Fail-closed abort." >&2
  exit 1
fi

# Abort and Cleanup Trap: Stops BOTH generators of THIS run immediately on signal/exit
abort_all() {
  echo "[lt2] Abort/Exit signal caught! Stopping BOTH k6 generators (${CONTAINER_HLS}, ${CONTAINER_API})..."

  # Stop background Watchdog and Collector
  if [[ -n "${WATCHDOG_PID:-}" ]]; then kill -9 "${WATCHDOG_PID}" 2>/dev/null || true; fi
  if [[ -n "${COLLECTOR_PID:-}" ]]; then kill -9 "${COLLECTOR_PID}" 2>/dev/null || true; fi

  # Kill k6 background processes and specific docker containers
  if [[ -n "${PID_HLS:-}" ]]; then kill -9 "${PID_HLS}" 2>/dev/null || true; fi
  if [[ -n "${PID_API:-}" ]]; then kill -9 "${PID_API}" 2>/dev/null || true; fi

  docker stop "${CONTAINER_HLS}" "${CONTAINER_API}" 2>/dev/null || true

  echo "[lt2] Executing data cleanup (deleteMe & comment purge with recovery retention)..."
  TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" node "${SCRIPT_DIR}/cleanup.mjs" || true
}

trap abort_all EXIT SIGINT SIGTERM

# 2. Pre-seed 5 temporary lt2 accounts and create lt2_accounts.json (no passwords or tokens inside)
echo "[lt2] Pre-seeding 5 temporary lt2 accounts..."
TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" LT2_INVITE_CODE="${LT2_INVITE_CODE}" node "${SCRIPT_DIR}/preseed.mjs"

# 3. Launch background Watchdog for legacy sites and system RAM
watchdog_loop() {
  echo "[watchdog] Watchdog active (polling legacy sites and host RAM every 30s)..."
  while true; do
    sleep 30

    # Legacy sites health check (must verify all 4 legacy sites if provided)
    if [[ -n "${LEGACY_SITES}" ]]; then
      for site in ${LEGACY_SITES}; do
        if ! curl -sS --max-time 10 "${site}" > /dev/null 2>&1; then
          echo "[watchdog] ALERT: Legacy site check failed for ${site}! Immediate auto-abort." >&2
          kill -INT $$ 2>/dev/null || true
          exit 1
        fi
      done
      echo "[watchdog] Legacy sites health check: PASS"
    fi

    # Host RAM check (available memory >= 1 GiB)
    if [[ -f /proc/meminfo ]]; then
      avail_kb=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
      if [[ -n "${avail_kb}" && "${avail_kb}" -lt 1048576 ]]; then
        echo "[watchdog] ALERT: Available RAM fell below 1 GiB (${avail_kb} kB)! Immediate auto-abort." >&2
        kill -INT $$ 2>/dev/null || true
        exit 1
      fi
    fi
  done
}

watchdog_loop &
WATCHDOG_PID=$!

echo "[lt2] Executing k6 HLS viewers and API mix parallel load test against ${TARGET_URL}..."

# Run HLS viewers (50 -> 200 -> 500 -> 1000 VUs)
docker run --rm --name "${CONTAINER_HLS}" --net=host -v "${SCRIPT_DIR}:/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e EXECUTOR="ramping-vus" \
  "${K6_IMAGE}" \
  run /loadtest/hls-viewers.js &
PID_HLS=$!

# Run API mix in parallel at 5% VU count (3 -> 10 -> 25 -> 50 VUs)
docker run --rm --name "${CONTAINER_API}" --net=host -v "${SCRIPT_DIR}:/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e EXECUTOR="ramping-vus" \
  -e COLLECTOR_URL="http://127.0.0.1:${COLLECTOR_PORT}" \
  -e LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" \
  -e LT2_INVITE_CODE="${LT2_INVITE_CODE}" \
  "${K6_IMAGE}" \
  run /loadtest/api-mix.js &
PID_API=$!

set +e
wait ${PID_HLS}
EXIT_HLS=$?

wait ${PID_API}
EXIT_API=$?
set -e

echo "[lt2] Load test workloads finished (HLS exit: ${EXIT_HLS}, API exit: ${EXIT_API}). Draining collector & running cleanup..."
trap - EXIT
if [[ -n "${WATCHDOG_PID:-}" ]]; then kill -9 "${WATCHDOG_PID}" 2>/dev/null || true; fi

# Drain comment collector before cleanup
sleep 2
if [[ -n "${COLLECTOR_PID:-}" ]]; then kill -SIGTERM "${COLLECTOR_PID}" 2>/dev/null || true; fi

set +e
TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" node "${SCRIPT_DIR}/cleanup.mjs"
EXIT_CLEANUP=$?
set -e

if [[ ${EXIT_HLS} -ne 0 || ${EXIT_API} -ne 0 || ${EXIT_CLEANUP} -ne 0 ]]; then
  echo "ERROR: Task LT2 load test failed (HLS: ${EXIT_HLS}, API: ${EXIT_API}, Cleanup: ${EXIT_CLEANUP})." >&2
  exit 1
fi

echo "[lt2] Task LT2 load test execution finished cleanly."
