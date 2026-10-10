#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  if [ -x "/tmp/node/bin/node" ]; then
    export PATH="/tmp/node/bin:${PATH}"
  elif [ -x "/usr/local/bin/node" ]; then
    export PATH="/usr/local/bin:${PATH}"
  fi
fi

TARGET_URL="${TARGET_URL:-https://winkey.vn}"

# Window safety gate: refuse execution on winkey.vn outside 02:00–03:30 Asia/Ho_Chi_Minh
if [[ "${TARGET_URL}" == *"winkey.vn"* ]]; then
  CURRENT_TIME=$(TZ="Asia/Ho_Chi_Minh" date +"%H%M")
  if [[ "${CURRENT_TIME}" -lt 0200 || "${CURRENT_TIME}" -gt 0330 ]]; then
    echo "ERROR: Production run on winkey.vn is strictly gated to 02:00–03:30 Asia/Ho_Chi_Minh timezone window." >&2
    echo "Current VN time: $(TZ="Asia/Ho_Chi_Minh" date +"%Y-%m-%d %H:%M:%S %Z")" >&2
    exit 1
  fi
fi

RUN_ID="lt2_$(date +%s)_$$"
RUN_DIR="/tmp/winkey_lt2_${RUN_ID}"
mkdir -p "${RUN_DIR}"
ABORT_FILE="${RUN_DIR}/abort.signal"
WATCHDOG_LOG="${RUN_DIR}/watchdog.log"
TELEMETRY_FILE="${RUN_DIR}/telemetry.json"
SUMMARY_FILE="results/lt2-summary.json"

cat <<EOF > "${TELEMETRY_FILE}"
{
  "version": "1.0",
  "timestamp": $(date +%s),
  "windowSec": 60,
  "workloads": {
    "api_mix": { "requests": 0, "failed": 0 },
    "hls_viewers": { "requests": 0, "failed": 0 }
  }
}
EOF

EDGE_METRICS_URL="${EDGE_METRICS_URL:-http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Binstance%3D%22100.113.240.3%3A9100%22%7D}"

echo "Starting platform safety watchdog..."
./deploy/lt2/watchdog.sh \
  --run-id "${RUN_ID}" \
  --pid $$ \
  --abort-file "${ABORT_FILE}" \
  --metrics-url "${EDGE_METRICS_URL}" \
  --error-source "${TELEMETRY_FILE}" > "${WATCHDOG_LOG}" 2>&1 &
WATCHDOG_PID=$!

K6_HLS_CONTAINER="winkey-lt2-hls-${RUN_ID}"
K6_API_CONTAINER="winkey-lt2-api-${RUN_ID}"

cleanup() {
  local exit_code=$?
  trap - SIGINT SIGTERM EXIT
  echo "Cleaning up containers and processes..."
  docker stop "${K6_HLS_CONTAINER}" "${K6_API_CONTAINER}" 2>/dev/null || true
  if [ -n "${WATCHDOG_PID:-}" ] && kill -0 "${WATCHDOG_PID}" 2>/dev/null; then
    kill "${WATCHDOG_PID}" 2>/dev/null || true
  fi
  if [ -f "${ABORT_FILE}" ]; then
    echo "WATCHDOG ABORT DETECTED!" >&2
    cat "${ABORT_FILE}" >&2
    echo "" >&2
    exit_code=1
  fi
  if [ -f "${SUMMARY_FILE}" ]; then
    echo "Summary location: ${SUMMARY_FILE}"
    SUMMARY_PASSED=$(node -e "try { const s = JSON.parse(require('fs').readFileSync('${SUMMARY_FILE}', 'utf8')); console.log(s.passed === true ? 'true' : 'false'); } catch (_) { console.log('false'); }")
    if [ "${SUMMARY_PASSED}" != "true" ]; then
      echo "ERROR: Summary gate failed (passed=false in ${SUMMARY_FILE})" >&2
      exit_code=1
    fi
  else
    echo "Summary location: (none generated)"
  fi
  exit "${exit_code}"
}
trap cleanup SIGINT SIGTERM EXIT

PREFLIGHT_PASSED=0
for i in $(seq 1 30); do
  if ! kill -0 "${WATCHDOG_PID}" 2>/dev/null; then
    echo "ERROR: Watchdog process died unexpectedly during preflight." >&2
    cat "${WATCHDOG_LOG}" >&2
    exit 1
  fi
  if [ -f "${ABORT_FILE}" ]; then
    echo "ERROR: Watchdog aborted during preflight." >&2
    cat "${ABORT_FILE}" >&2
    exit 1
  fi
  if grep -q "\[WATCHDOG\] Preflight PASSED" "${WATCHDOG_LOG}" 2>/dev/null; then
    PREFLIGHT_PASSED=1
    break
  fi
  sleep 0.5
done

if [ "${PREFLIGHT_PASSED}" -ne 1 ]; then
  echo "ERROR: Watchdog preflight timed out." >&2
  cat "${WATCHDOG_LOG}" >&2
  exit 1
fi
echo "Watchdog preflight PASSED."

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"
mkdir -p results

echo "Starting k6 hls-viewers container..."
docker run --rm --name "${K6_HLS_CONTAINER}" --net=host \
  -v "$(pwd):/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${VUS:-}" -e DURATION="${DURATION:-}" \
  "${K6_IMAGE}" run /loadtest/hls-viewers.js &
HLS_PID=$!

echo "Starting k6 api-read container..."
docker run --rm --name "${K6_API_CONTAINER}" --net=host \
  -v "$(pwd):/loadtest" \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${VUS:-}" -e DURATION="${DURATION:-}" \
  "${K6_IMAGE}" run /loadtest/api-read.js &
API_PID=$!

HLS_EXIT=0
API_EXIT=0
wait "${HLS_PID}" || HLS_EXIT=$?
wait "${API_PID}" || API_EXIT=$?

if [ "${HLS_EXIT}" -ne 0 ] || [ "${API_EXIT}" -ne 0 ]; then
  echo "ERROR: Load generator container failed. HLS exit: ${HLS_EXIT}, API exit: ${API_EXIT}" >&2
  exit 1
fi
