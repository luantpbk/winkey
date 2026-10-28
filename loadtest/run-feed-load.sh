#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPORT_DIR="${REPO_ROOT}/systest/.run/report"
RESULTS_DIR="${SCRIPT_DIR}/results"
mkdir -p "${REPORT_DIR}" "${RESULTS_DIR}"

TARGET_URL="${TARGET_URL:-http://127.0.0.1:8080}"
VUS="${VUS:-20}"
DURATION="${DURATION:-1m}"
K6_IMAGE="grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603"

echo "==================================================================="
echo "     SOC-2a: FEEDS LOAD TESTING & PG_STAT_STATEMENTS ANALYSIS      "
echo "==================================================================="
echo "[feed-load] Target: ${TARGET_URL}"
echo "[feed-load] Virtual Users: ${VUS}, Duration: ${DURATION}"

# 1. Production safety window gate (02:00-03:30 Asia/Ho_Chi_Minh)
if [[ "${TARGET_URL}" =~ winkey\.vn ]]; then
  echo "[feed-load] Checking production safety window for ${TARGET_URL}..."
  current_hour=$(TZ="Asia/Ho_Chi_Minh" date +%H)
  current_min=$(TZ="Asia/Ho_Chi_Minh" date +%M)
  current_time_val=$(( 10#$current_hour * 60 + 10#$current_min ))
  # 02:00 = 120, 03:30 = 210
  if [ "${current_time_val}" -lt 120 ] || [ "${current_time_val}" -gt 210 ]; then
    echo "ERROR: Production load tests strictly forbidden outside 02:00-03:30 ICT window!" >&2
    echo "Current ICT time: $(TZ="Asia/Ho_Chi_Minh" date '+%Y-%m-%d %H:%M:%S %Z')" >&2
    exit 1
  fi
fi

# 2. Seed data if seed-feeds.json missing or requested
if [ ! -f "${SCRIPT_DIR}/seed-feeds.json" ] || [ "${FORCE_SEED:-0}" -eq 1 ]; then
  echo "[feed-load] Seeding 2,000 users and 100,000 posts via PostgreSQL batch..."
  node "${SCRIPT_DIR}/seed-posts.mjs"
fi

# 3. Reset pg_stat_statements before test
echo "[feed-load] Resetting pg_stat_statements metrics..."
docker exec -i winkey-postgres psql -U postgres -d winkey -c "SELECT pg_stat_statements_reset();" >/dev/null 2>&1 || true

# 4. Execute k6 load test
SUMMARY_JSON="${RESULTS_DIR}/feed-load-summary.json"
echo "[feed-load] Running k6 feed-load scenario (${VUS} VUs, ${DURATION})..."

set +e
if command -v k6 >/dev/null 2>&1; then
  k6 run \
    -e TARGET_URL="${TARGET_URL}" \
    -e VUS="${VUS}" \
    -e DURATION="${DURATION}" \
    --summary-export "${SUMMARY_JSON}" \
    "${SCRIPT_DIR}/feed-load.js"
else
  docker run --rm --network host \
    -u "$(id -u):$(id -g)" \
    -v "${REPO_ROOT}:/app" \
    -w /app \
    "${K6_IMAGE}" run \
    -e TARGET_URL="${TARGET_URL}" \
    -e VUS="${VUS}" \
    -e DURATION="${DURATION}" \
    --summary-export "/app/loadtest/results/feed-load-summary.json" \
    loadtest/feed-load.js
fi
K6_EXIT=$?
set -e

# 5. Extract slowest queries from pg_stat_statements
echo ""
echo "==================================================================="
echo "              TOP SLOWEST QUERIES (pg_stat_statements)             "
echo "==================================================================="
PG_STAT_OUTPUT=$(docker exec -i winkey-postgres psql -U postgres -d winkey -c "
  SELECT
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round(total_exec_time::numeric, 2) AS total_ms,
    calls,
    round((100.0 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct_time,
    regexp_replace(query, '\s+', ' ', 'g') AS normalized_query
  FROM pg_stat_statements
  WHERE query NOT LIKE '%pg_stat%' AND query NOT LIKE '%vacuum%'
  ORDER BY mean_exec_time DESC
  LIMIT 10;
")
echo "${PG_STAT_OUTPUT}"
echo "${PG_STAT_OUTPUT}" > "${RESULTS_DIR}/pg_stat_statements.txt"

echo "[feed-load] Done. Summary written to ${SUMMARY_JSON}."
if [ ${K6_EXIT} -ne 0 ] && [ ${K6_EXIT} -ne 99 ]; then
  exit ${K6_EXIT}
fi
exit 0
