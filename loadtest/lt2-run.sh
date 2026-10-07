#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/tmp/node/bin:/usr/local/bin:${PATH}"

TARGET_URL="${TARGET_URL:-https://winkey.vn}"
LT2_INVITE_CODE="${LT2_INVITE_CODE:-}"
LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD:-}"

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "==================================================================="
echo "     TASK LT2: PRODUCTION 1,000 CONCURRENT VIEWERS LOAD TEST       "
echo "==================================================================="
echo "Target URL:             ${TARGET_URL}"
echo "Execution Window Rule: 02:00 - 03:30 AM (Vietnam Time, UTC+7, from 2026-10-09)"
echo "Ramp Profile:          50 (5m) -> 200 (5m) -> 500 (5m) -> 1000 (5m) -> 1000 (15m)"
echo "Safety Rule:           Auto-abort on >5% HTTP errors or >1% rebuffer ratio"
echo "==================================================================="

# Check for production password requirement
if [[ "${TARGET_URL}" != *"localhost"* && "${TARGET_URL}" != *"127.0.0.1"* ]] && [[ -z "${LOADTEST_USER_PASSWORD}" ]]; then
  echo "ERROR: LOADTEST_USER_PASSWORD environment variable is required for production / non-localhost targets."
  exit 1
fi

trap 'echo "[lt2] Signal/Exit caught! Executing automatic data cleanup (deleteMe & comment purge)..."; TARGET_URL="${TARGET_URL}" node "${SCRIPT_DIR}/cleanup.mjs"' EXIT

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
TARGET_URL="${TARGET_URL}" node "${SCRIPT_DIR}/cleanup.mjs"

trap - EXIT
echo "[lt2] Task LT2 load test execution finished cleanly."
