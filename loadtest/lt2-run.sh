#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="/tmp/node/bin:/usr/local/bin:${PATH}"

TARGET_URL="${TARGET_URL:-http://127.0.0.1:8080}"
VUS="${VUS:-1000}"
DURATION="${DURATION:-5m}"
LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD:-Password123!}"

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "==================================================================="
echo "     TASK LT2: PRODUCTION 1,000 CONCURRENT VIEWERS LOAD TEST       "
echo "==================================================================="
echo "Target URL:             ${TARGET_URL}"
echo "Target VUs:            ${VUS}"
echo "Test Duration:         ${DURATION}"
echo "Execution Window Rule: 02:00 - 03:30 AM (Vietnam Time, UTC+7)"
echo "Safety Rule:           Auto-abort on >5% HTTP errors or >1% rebuffer ratio"
echo "==================================================================="

trap 'echo "[lt2] Signal/Exit caught! Executing automatic data cleanup..."; GATEWAY_URL="${TARGET_URL}" node "${SCRIPT_DIR}/cleanup.mjs"' EXIT

# Step 1: Seeding
echo "[lt2] Step 1/3: Seeding test users and video assets..."
GATEWAY_URL="${TARGET_URL}" LOADTEST_USER_PASSWORD="${LOADTEST_USER_PASSWORD}" NUM_VIDEOS=10 NUM_USERS=50 "${SCRIPT_DIR}/seed.sh"

# Step 2: Executing k6 Load Test
echo "[lt2] Step 2/3: Executing k6 HLS streaming load test (${VUS} VUs)..."
docker run --rm --net=host -v "${SCRIPT_DIR}:/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${VUS}" \
  -e DURATION="${DURATION}" \
  "${K6_IMAGE}" \
  run /loadtest/hls-viewers.js

# Step 3: Cleanup
echo "[lt2] Step 3/3: Cleaning up test data on target environment..."
GATEWAY_URL="${TARGET_URL}" node "${SCRIPT_DIR}/cleanup.mjs"

trap - EXIT
echo "[lt2] Task LT2 load test execution finished."
