#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="/mnt/hdd_storage/winkey/vault"
ARCHIVE_DIR="${VAULT_DIR}/archive"
DATE_STR="$(date +%Y%m%d)"
PROM_FILE="/var/lib/prometheus/node-exporter/winkey_vault.prom"
FALLBACK_PROM="${VAULT_DIR}/winkey_vault.prom"

RCLONE_BIN="/usr/local/bin/rclone"
if [ ! -x "${RCLONE_BIN}" ]; then
  echo "ERROR: /usr/local/bin/rclone not found or not executable!" >&2
  echo "Please ensure root-owned rclone v1.69.1 is installed at /usr/local/bin with verified checksum." >&2
  exit 1
fi

echo "=========================================================="
echo "    Interim Vault Nightly Sync (gpu-01: R2 -> HDD)        "
echo "    Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')                "
echo "=========================================================="

mkdir -p "${VAULT_DIR}" "${ARCHIVE_DIR}"

BUCKETS=("winkey-media" "winkey-pg-backup" "winkey-backup")
SYNC_FAILED=0

for b in "${BUCKETS[@]}"; do
  echo ""
  echo ">>> [Syncing] Bucket: ${b} -> ${VAULT_DIR}/${b}"
  mkdir -p "${VAULT_DIR}/${b}"
  mkdir -p "${ARCHIVE_DIR}/${DATE_STR}/${b}"

  if "${RCLONE_BIN}" sync "r2_vault:${b}" "${VAULT_DIR}/${b}" \
      --backup-dir "${ARCHIVE_DIR}/${DATE_STR}/${b}" \
      --fast-list \
      --transfers 8 \
      --stats 30s \
      -v; then
    echo "  [OK] Successfully synced ${b}."
  else
    echo "  [ERROR] Sync failed for ${b}!" >&2
    SYNC_FAILED=1
  fi
done

# Prune archives older than 14 days
echo ""
echo ">>> [Retention] Pruning archives older than 14 days in ${ARCHIVE_DIR}..."
find "${ARCHIVE_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true
echo "  [OK] 14-day retention enforced."

NOW_TS="$(date +%s)"
TARGET_PROM="${PROM_FILE}"
if [ ! -w "$(dirname "${PROM_FILE}")" ] && [ ! -w "${PROM_FILE}" ]; then
  TARGET_PROM="${FALLBACK_PROM}"
fi

# Retrieve previous last success timestamp to carry forward on failure
PREV_LAST_SUCCESS=0
if [ -f "${TARGET_PROM}" ]; then
  PREV_LAST_SUCCESS=$(grep -E '^winkey_vault_last_success_timestamp_seconds ' "${TARGET_PROM}" 2>/dev/null | awk '{print $2}' || echo 0)
fi
PREV_LAST_SUCCESS="${PREV_LAST_SUCCESS:-0}"

if [ "${SYNC_FAILED}" -eq 0 ]; then
  echo ""
  echo ">>> Updating Prometheus textfile metrics (SUCCESS)..."
  LAST_SUCCESS_TS="${NOW_TS}"
  SYNC_STATUS=1
else
  echo ""
  echo ">>> Updating Prometheus textfile metrics (FAILURE)..."
  LAST_SUCCESS_TS="${PREV_LAST_SUCCESS}"
  SYNC_STATUS=0
fi

METRICS_CONTENT="# HELP winkey_vault_last_success_timestamp_seconds Unix timestamp of the last successful interim vault sync
# TYPE winkey_vault_last_success_timestamp_seconds gauge
winkey_vault_last_success_timestamp_seconds ${LAST_SUCCESS_TS}
# HELP winkey_vault_sync_success Indicates if the latest interim vault sync succeeded
# TYPE winkey_vault_sync_success gauge
winkey_vault_sync_success ${SYNC_STATUS}
"

# Atomic rewrite via temp file and mv
TMP_PROM="${TARGET_PROM}.tmp.$$"
echo "${METRICS_CONTENT}" > "${TMP_PROM}"
mv -f "${TMP_PROM}" "${TARGET_PROM}"
echo "  [OK] Metrics atomically written to ${TARGET_PROM}."

if [ "${SYNC_FAILED}" -eq 0 ]; then
  echo "=========================================================="
  echo " Vault synchronization completed successfully!"
  echo "=========================================================="
else
  echo "ERROR: One or more buckets failed to sync!" >&2
  exit 1
fi
