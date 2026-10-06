#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="/mnt/hdd_storage/winkey/vault"
ARCHIVE_DIR="${VAULT_DIR}/archive"
DATE_STR="$(date +%Y%m%d)"
PROM_FILE="/var/lib/prometheus/node-exporter/winkey_vault.prom"
FALLBACK_PROM="${VAULT_DIR}/winkey_vault.prom"

RCLONE_BIN="$(command -v rclone || echo "/usr/local/bin/rclone")"
if [ ! -x "${RCLONE_BIN}" ] && [ -x "/tmp/rclone" ]; then
  RCLONE_BIN="/tmp/rclone"
fi

if [ ! -x "${RCLONE_BIN}" ]; then
  echo "ERROR: rclone binary not found! Please ensure rclone is installed." >&2
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
if [ "${SYNC_FAILED}" -eq 0 ]; then
  echo ""
  echo ">>> Updating Prometheus textfile metrics (SUCCESS)..."
  METRICS_CONTENT="# HELP winkey_vault_last_success_timestamp_seconds Unix timestamp of the last successful interim vault sync
# TYPE winkey_vault_last_success_timestamp_seconds gauge
winkey_vault_last_success_timestamp_seconds ${NOW_TS}
# HELP winkey_vault_sync_success Indicates if the latest interim vault sync succeeded
# TYPE winkey_vault_sync_success gauge
winkey_vault_sync_success 1
"
  if [ -w "$(dirname "${PROM_FILE}")" ] || [ -w "${PROM_FILE}" ]; then
    echo "${METRICS_CONTENT}" > "${PROM_FILE}.tmp" && mv -f "${PROM_FILE}.tmp" "${PROM_FILE}"
    echo "  [OK] Metrics written to ${PROM_FILE}."
  else
    echo "${METRICS_CONTENT}" > "${FALLBACK_PROM}.tmp" && mv -f "${FALLBACK_PROM}.tmp" "${FALLBACK_PROM}"
    echo "  [NOTE] Metrics written to fallback location ${FALLBACK_PROM}."
  fi

  echo "=========================================================="
  echo " Vault synchronization completed successfully!"
  echo "=========================================================="
else
  echo ""
  echo ">>> Updating Prometheus textfile metrics (FAILURE)..."
  METRICS_CONTENT="# HELP winkey_vault_sync_success Indicates if the latest interim vault sync succeeded
# TYPE winkey_vault_sync_success gauge
winkey_vault_sync_success 0
"
  if [ -w "$(dirname "${PROM_FILE}")" ] || [ -w "${PROM_FILE}" ]; then
    echo "${METRICS_CONTENT}" >> "${PROM_FILE}"
  fi
  echo "ERROR: One or more buckets failed to sync!" >&2
  exit 1
fi
