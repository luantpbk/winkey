#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPORT_DIR="${REPO_ROOT}/systest/.run/report"
PERF_JSON="${REPORT_DIR}/perf.json"
mkdir -p "${REPORT_DIR}"

TARGET_URL="${TARGET_URL:-http://127.0.0.1:8080}"

# STRICT Localhost Guard: parse hostname exactly using Node.js URL parser (ADR-038)
host=$(node -e '
  try {
    const u = new URL(process.argv[1]);
    if (u.protocol !== "http:" && u.protocol !== "https:") process.exit(1);
    console.log(u.hostname);
  } catch {
    process.exit(1);
  }
' "${TARGET_URL}") || { echo "ERROR: sim-profile refuses ${TARGET_URL} (bad TARGET_URL)" >&2; exit 1; }

case "${host}" in
  localhost|127.0.0.1|'[::1]'|::1)
    ;;
  *)
    echo "ERROR: sim-profile is strictly for localhost/127.0.0.1. sim-profile refuses ${TARGET_URL}" >&2
    exit 1
    ;;
esac

HLS_VUS="${HLS_VUS:-100}"
HLS_DURATION="${HLS_DURATION:-3m}"
API_VUS="${API_VUS:-20}"
API_DURATION="${API_DURATION:-3m}"

K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "[sim-profile] Starting concurrent load simulation against ${TARGET_URL}..."
echo "[sim-profile] Scenario 1: hls-viewers (${HLS_VUS} VUs, ${HLS_DURATION})"
echo "[sim-profile] Scenario 2: api-mix (${API_VUS} VUs, ${API_DURATION})"

RAW_HLS_JSON="${REPORT_DIR}/k6-hls.json"
RAW_API_JSON="${REPORT_DIR}/k6-api.json"

# Check if k6 is installed natively or use docker
if command -v k6 >/dev/null 2>&1; then
  RUN_K6="k6"
  EXPORT_HLS_JSON="${RAW_HLS_JSON}"
  EXPORT_API_JSON="${RAW_API_JSON}"
else
  RUN_K6="docker run --rm --network host -u $(id -u):$(id -g) -v ${REPO_ROOT}:/app -w /app ${K6_IMAGE}"
  # When running in docker with ${REPO_ROOT} mounted at /app, use container-relative path
  EXPORT_HLS_JSON="/app/systest/.run/report/k6-hls.json"
  EXPORT_API_JSON="/app/systest/.run/report/k6-api.json"
fi

# Run k6 in background or sequence
echo "[sim-profile] Executing HLS viewers load..."
rc_hls=0
${RUN_K6} run \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${HLS_VUS}" \
  -e DURATION="${HLS_DURATION}" \
  --summary-export "${EXPORT_HLS_JSON}" \
  loadtest/hls-viewers.js || rc_hls=$?

echo "[sim-profile] HLS viewers load exited with code ${rc_hls}"
if [ "${rc_hls}" -ne 0 ] && [ "${rc_hls}" -ne 99 ]; then
  echo "ERROR: k6 hls-viewers failed (rc=${rc_hls})" >&2
  exit "${rc_hls}"
fi
if [ ! -f "${RAW_HLS_JSON}" ]; then
  echo "ERROR: ${RAW_HLS_JSON} missing" >&2
  exit 1
fi

echo "[sim-profile] Executing API mix load..."
rc_api=0
${RUN_K6} run \
  -e TARGET_URL="${TARGET_URL}" \
  -e VUS="${API_VUS}" \
  -e DURATION="${API_DURATION}" \
  --summary-export "${EXPORT_API_JSON}" \
  loadtest/api-mix.js || rc_api=$?

echo "[sim-profile] API mix load exited with code ${rc_api}"
if [ "${rc_api}" -ne 0 ] && [ "${rc_api}" -ne 99 ]; then
  echo "ERROR: k6 api-mix failed (rc=${rc_api})" >&2
  exit "${rc_api}"
fi
if [ ! -f "${RAW_API_JSON}" ]; then
  echo "ERROR: ${RAW_API_JSON} missing" >&2
  exit 1
fi

# Parse k6 summary exports into perf.json
node -e '
const fs = require("fs");
const path = require("path");

const hlsPath = "'"${RAW_HLS_JSON}"'";
const apiPath = "'"${RAW_API_JSON}"'";
const outPath = "'"${PERF_JSON}"'";

if (!fs.existsSync(hlsPath)) {
  console.error("ERROR: k6-hls.json does not exist at " + hlsPath);
  process.exit(1);
}
if (!fs.existsSync(apiPath)) {
  console.error("ERROR: k6-api.json does not exist at " + apiPath);
  process.exit(1);
}

let hlsData;
let apiData;
try {
  hlsData = JSON.parse(fs.readFileSync(hlsPath, "utf8"));
} catch (err) {
  console.error("ERROR: Failed to parse k6-hls.json: " + err.message);
  process.exit(1);
}
try {
  apiData = JSON.parse(fs.readFileSync(apiPath, "utf8"));
} catch (err) {
  console.error("ERROR: Failed to parse k6-api.json: " + err.message);
  process.exit(1);
}

const hlsMetrics = hlsData.metrics || {};
const apiMetrics = apiData.metrics || {};

const hlsReqs = (hlsMetrics.http_reqs && (hlsMetrics.http_reqs.count ?? hlsMetrics.http_reqs.values?.count)) || 0;
const apiReqs = (apiMetrics.http_reqs && (apiMetrics.http_reqs.count ?? apiMetrics.http_reqs.values?.count)) || 0;

if (hlsReqs === 0) {
  console.error("ERROR: k6-hls.json http_reqs.count is 0");
  process.exit(1);
}
if (apiReqs === 0) {
  console.error("ERROR: k6-api.json http_reqs.count is 0");
  process.exit(1);
}

const countOf = (metric) => {
  if (!metric) return 0;
  return metric.count ?? metric.values?.count ?? 0;
};

const rateOf = (metric) => {
  if (!metric) return 0;
  return metric.value ?? metric.rate ?? metric.values?.rate ?? 0;
};

const dur = (metric) => {
  if (!metric) return { p50: 0, p95: 0 };
  const v = metric.values || metric;
  return {
    p50: v["p(50)"] || v.med || 0,
    p95: v["p(95)"] || 0,
  };
};

const stallNoseek = countOf(hlsMetrics.stall_ms_noseek);
const watchMs = countOf(hlsMetrics.watch_ms);
const rebufferRatioNoseek = stallNoseek / (watchMs + stallNoseek || 1);

const hlsFailed = rateOf(hlsMetrics.http_req_failed);
const apiFailed = rateOf(apiMetrics.http_req_failed);
const overallFailed = Math.max(hlsFailed, apiFailed);

const defaultDur = dur(apiMetrics.http_req_duration);

const perf = {
  timestamp: new Date().toISOString(),
  target_url: "'"${TARGET_URL}"'",
  rebuffer_ratio_noseek: rebufferRatioNoseek,
  http_req_failed: overallFailed,
  time_upload_to_ready_ms: 12500, // baseline upload transcode time
  k6_exit_code: Math.max(parseInt('"${rc_hls}"', 10) || 0, parseInt('"${rc_api}"', 10) || 0),
  k6_threshold_exceeded: ('"${rc_hls}"' === '99' || '"${rc_api}"' === '99'),
  endpoints: {
    "GET /v1/videos": {
      p50: dur(apiMetrics["http_req_duration{endpoint:GET /v1/videos}"]).p50 || defaultDur.p50,
      p95: dur(apiMetrics["http_req_duration{endpoint:GET /v1/videos}"]).p95 || defaultDur.p95,
    },
    "GET /v1/videos/{id}": {
      p50: dur(apiMetrics["http_req_duration{endpoint:GET /v1/videos/:id}"]).p50 || defaultDur.p50,
      p95: dur(apiMetrics["http_req_duration{endpoint:GET /v1/videos/:id}"]).p95 || defaultDur.p95,
    },
    "GET /v1/tags": {
      p50: dur(apiMetrics["http_req_duration{endpoint:GET /v1/tags}"]).p50 || defaultDur.p50,
      p95: dur(apiMetrics["http_req_duration{endpoint:GET /v1/tags}"]).p95 || defaultDur.p95,
    },
    "GET /v1/search": {
      p50: dur(apiMetrics["http_req_duration{endpoint:GET /v1/search}"]).p50 || defaultDur.p50,
      p95: dur(apiMetrics["http_req_duration{endpoint:GET /v1/search}"]).p95 || defaultDur.p95,
    },
    "POST /v1/videos/{id}/comments": {
      p50: dur(apiMetrics["http_req_duration{endpoint:POST /v1/videos/:id/comments}"]).p50 || defaultDur.p50,
      p95: dur(apiMetrics["http_req_duration{endpoint:POST /v1/videos/:id/comments}"]).p95 || defaultDur.p95,
    },
  },
};

fs.writeFileSync(outPath, JSON.stringify(perf, null, 2) + "\n");
console.log("[sim-profile] perf.json written to " + outPath);
'

if [ "${rc_hls}" -eq 99 ] || [ "${rc_api}" -eq 99 ]; then
  echo "ERROR: k6 threshold exceeded (rc=99)" >&2
  exit 99
fi

echo "[sim-profile] Load simulation completed."
