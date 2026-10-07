#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/tmp/node/bin:/usr/local/bin:${PATH}"

TARGET_URL="${TARGET_URL:-https://winkey.vn}"
LT2_INVITE_CODE="${LT2_INVITE_CODE:-}"
LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD:-}"
LEGACY_SITES="${LEGACY_SITES:-}"

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "==================================================================="
echo "     TASK LT2: PRODUCTION 1,000 CONCURRENT VIEWERS LOAD TEST       "
echo "==================================================================="
echo "Target URL:             ${TARGET_URL}"
echo "Execution Window Rule: 02:00 - 03:30 AM (Vietnam Time, UTC+7, from 2026-10-09)"
echo "Ramp Profile:          50 (5m) -> 200 (5m) -> 500 (5m) -> 1000 (5m) -> 1000 (15m)"
echo "Pass/Fail Criterion:    Aggregate Rebuffer Ratio < 1%, HTTP req failed < 1%"
echo "Safety Rule:           Auto-abort on >5% HTTP errors, legacy site failure"
echo "==================================================================="

# Check for production password requirement
if [[ "${TARGET_URL}" != *"localhost"* && "${TARGET_URL}" != *"127.0.0.1"* ]] && [[ -z "${LOADTEST_USER_PASSWORD}" ]]; then
  echo "ERROR: LOADTEST_USER_PASSWORD environment variable is required for production / non-localhost targets."
  exit 1
fi

# Cleanup trap on signal or exit
cleanup_trap() {
  echo "[lt2] Signal/Exit caught! Terminating background processes and executing automatic data cleanup..."
  if [[ -n "${WATCHDOG_PID:-}" ]]; then
    kill "${WATCHDOG_PID}" 2>/dev/null || true
  fi
  TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" node "${SCRIPT_DIR}/cleanup.mjs" || true
}

trap cleanup_trap EXIT

# 1. Pre-seed 5 temporary lt2 accounts and create lt2_accounts.json (no passwords inside)
echo "[lt2] Pre-seeding 5 temporary lt2 accounts..."
TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" LT2_INVITE_CODE="${LT2_INVITE_CODE}" node "${SCRIPT_DIR}/preseed.mjs"

# 2. Launch background Watchdog for legacy sites if LEGACY_SITES is specified
watchdog_legacy_sites() {
  if [[ -z "${LEGACY_SITES}" ]]; then
    echo "[watchdog] No LEGACY_SITES environment variable specified. Skipping legacy sites watchdog."
    return 0
  fi
  echo "[watchdog] Legacy sites watchdog active (polling every 30s)..."
  while true; do
    sleep 30
    for site in ${LEGACY_SITES}; do
      if ! curl -sS --max-time 10 "${site}" > /dev/null 2>&1; then
        echo "[watchdog] ALERT: Legacy site check failed for ${site}! Immediate auto-abort." >&2
        kill -INT $$ 2>/dev/null || true
        exit 1
      fi
    done
    echo "[watchdog] Legacy sites health check: PASS"
  done
}

watchdog_legacy_sites &
WATCHDOG_PID=$!

echo "[lt2] Executing k6 HLS viewers and API mix parallel load test against ${TARGET_URL}..."

# Run HLS viewers (50 -> 200 -> 500 -> 1000 VUs)
docker run --rm --net=host -v "${SCRIPT_DIR}:/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e EXECUTOR="ramping-vus" \
  "${K6_IMAGE}" \
  run /loadtest/hls-viewers.js &
PID_HLS=$!

# Run API mix in parallel at 5% VU count (3 -> 10 -> 25 -> 50 VUs)
docker run --rm --net=host -v "${SCRIPT_DIR}:/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e EXECUTOR="ramping-vus" \
  -e LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" \
  -e LT2_INVITE_CODE="${LT2_INVITE_CODE}" \
  "${K6_IMAGE}" \
  run /loadtest/api-mix.js &
PID_API=$!

wait ${PID_HLS} ${PID_API}

echo "[lt2] Load test completed. Executing cleanup..."
trap - EXIT
if [[ -n "${WATCHDOG_PID:-}" ]]; then
  kill "${WATCHDOG_PID}" 2>/dev/null || true
fi
TARGET_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" node "${SCRIPT_DIR}/cleanup.mjs"

echo "[lt2] Task LT2 load test execution finished cleanly."
