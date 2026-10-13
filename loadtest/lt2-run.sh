#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
  CURRENT_TIME=$(TZ="Asia/Ho_Chi_Minh" date +"%H%M" 2>/dev/null || true)
  if [[ -z "${CURRENT_TIME}" || ! "${CURRENT_TIME}" =~ ^[0-9]{4}$ ]]; then
    echo "ERROR: Failed to read or parse Asia/Ho_Chi_Minh time for window gate (fail closed)." >&2
    exit 1
  fi
  now=$((10#$CURRENT_TIME))
  # One-day daytime approval (ADR-034 addendum 2026-10-13): the user may approve a run outside the
  # window for one Asia/Ho_Chi_Minh calendar day by setting LT2_DAYTIME_APPROVED_DATE=YYYY-MM-DD.
  # The watchdog still runs. Any other value, or another day, keeps the gate closed.
  TODAY_VN=$(TZ="Asia/Ho_Chi_Minh" date +"%Y-%m-%d" 2>/dev/null || true)
  if [[ -n "${LT2_DAYTIME_APPROVED_DATE:-}" && "${LT2_DAYTIME_APPROVED_DATE}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ \
        && "${LT2_DAYTIME_APPROVED_DATE}" == "${TODAY_VN}" ]]; then
    echo "WARNING: daytime production run approved for ${TODAY_VN} (LT2_DAYTIME_APPROVED_DATE); window gate skipped, watchdog still enforced." >&2
  elif (( now < 200 || now > 330 )); then
    echo "ERROR: Production run on winkey.vn is strictly gated to 02:00–03:30 Asia/Ho_Chi_Minh timezone window." >&2
    echo "Current VN time (HHMM): ${CURRENT_TIME}" >&2
    exit 1
  fi
fi

RUN_ID="lt2_$(date +%s)_$$"
RUN_DIR="/tmp/winkey_lt2_${RUN_ID}"
mkdir -p "${RUN_DIR}"
ABORT_FILE="${RUN_DIR}/abort.signal"
WATCHDOG_LOG="${RUN_DIR}/watchdog.log"
TELEMETRY_FILE="${RUN_DIR}/telemetry.json"
RESULTS_DIR="${REPO_ROOT}/loadtest/results"
mkdir -p "${RESULTS_DIR}"
chmod 777 "${RESULTS_DIR}" 2>/dev/null || true
HLS_NDJSON="${RESULTS_DIR}/hls.ndjson"
API_NDJSON="${RESULTS_DIR}/api.ndjson"
rm -f "${HLS_NDJSON}" "${API_NDJSON}"
touch "${HLS_NDJSON}" "${API_NDJSON}" 2>/dev/null || true
chmod 666 "${HLS_NDJSON}" "${API_NDJSON}" 2>/dev/null || true
SUMMARY_FILE="${RESULTS_DIR}/lt2-summary.json"

EDGE_METRICS_URL="${EDGE_METRICS_URL:-http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Binstance%3D%22100.113.240.3%3A9100%22%7D}"
K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "Starting error telemetry feeder..."
node "${SCRIPT_DIR}/telemetry-feeder.mjs" \
  --output "${TELEMETRY_FILE}" \
  --api-stream "${API_NDJSON}" \
  --hls-stream "${HLS_NDJSON}" \
  --interval 10 &
FEEDER_PID=$!

echo "Starting platform safety watchdog..."
"${REPO_ROOT}/deploy/lt2/watchdog.sh" \
  --run-id "${RUN_ID}" \
  --pid $$ \
  --abort-file "${ABORT_FILE}" \
  --metrics-url "${EDGE_METRICS_URL}" \
  --error-source "${TELEMETRY_FILE}" \
  --interval 10 > "${WATCHDOG_LOG}" 2>&1 &
WATCHDOG_PID=$!

K6_HLS_CONTAINER="winkey-lt2-hls-${RUN_ID}"
K6_API_CONTAINER="winkey-lt2-api-${RUN_ID}"

cleanup() {
  local exit_code=$?
  trap - SIGINT SIGTERM EXIT
  echo "Cleaning up containers and processes..."
  docker stop "${K6_HLS_CONTAINER}" "${K6_API_CONTAINER}" 2>/dev/null || true
  if [ -n "${FEEDER_PID:-}" ] && kill -0 "${FEEDER_PID}" 2>/dev/null; then
    kill "${FEEDER_PID}" 2>/dev/null || true
  fi
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

echo "Starting k6 hls-viewers container..."
docker run --rm --name "${K6_HLS_CONTAINER}" --net=host \
  -u "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}/loadtest:/work" \
  -w /work \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${VUS:-}" -e DURATION="${DURATION:-}" \
  "${K6_IMAGE}" run --out json=/work/results/hls.ndjson hls-viewers.js &
HLS_PID=$!

echo "Starting k6 api-read container..."
docker run --rm --name "${K6_API_CONTAINER}" --net=host \
  -u "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}/loadtest:/work" \
  -w /work \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${VUS:-}" -e DURATION="${DURATION:-}" \
  "${K6_IMAGE}" run --out json=/work/results/api.ndjson api-read.js &
API_PID=$!

HLS_EXIT=0
API_EXIT=0
wait "${HLS_PID}" || HLS_EXIT=$?
wait "${API_PID}" || API_EXIT=$?

if [ "${HLS_EXIT}" -ne 0 ] || [ "${API_EXIT}" -ne 0 ]; then
  echo "ERROR: Load generator container failed. HLS exit: ${HLS_EXIT}, API exit: ${API_EXIT}" >&2
  exit 1
fi
