#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${HOME}/.winkey-clickhouse-backup.env"
CH_ENV="${HOME}/winkey/deploy/gpu-01/analytics/.env"

if [ -f "${ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
else
  echo "ERROR: Backup environment file ${ENV_FILE} not found!" >&2
  echo "Run setup_clickhouse_backup.sh first." >&2
  exit 1
fi

if [ -f "${CH_ENV}" ]; then
  CLICKHOUSE_PASSWORD=$(grep -E '^CLICKHOUSE_PASSWORD=' "${CH_ENV}" | cut -d= -f2- | tr -d '"'\''')
fi

if [ -z "${CLICKHOUSE_PASSWORD:-}" ]; then
  echo "ERROR: CLICKHOUSE_PASSWORD could not be retrieved from ${CH_ENV}!" >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_NAME="ch_backup_${TIMESTAMP}"
BACKUP_DIR="/srv/winkey-analytics/backup"
ARCHIVE_PATH="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"

echo "=========================================================="
echo " Starting ClickHouse Backup to Cloudflare R2 (winkey-backup) "
echo " Backup ID: ${BACKUP_NAME}"
echo "=========================================================="

# 1. Native ClickHouse Backup to NVMe backup disk
echo "-> 1. Triggering native ClickHouse backup to Disk('backups')..."
docker exec winkey-analytics-clickhouse clickhouse-client -u winkey --password "${CLICKHOUSE_PASSWORD}" \
  --query "BACKUP DATABASE winkey TO Disk('backups', '${BACKUP_NAME}')"

echo "  [OK] ClickHouse native backup created successfully."

# 2. Compress the backup to .tar.gz inside container
echo "-> 2. Compressing backup directory to ${ARCHIVE_PATH}..."
docker exec winkey-analytics-clickhouse tar -czf "/var/lib/clickhouse/backup/${BACKUP_NAME}.tar.gz" -C "/var/lib/clickhouse/backup" "${BACKUP_NAME}"
docker exec winkey-analytics-clickhouse rm -rf "/var/lib/clickhouse/backup/${BACKUP_NAME}"
echo "  [OK] Compression complete. Size: $(du -h "${ARCHIVE_PATH}" | cut -f1)"

# 3. Upload to Cloudflare R2 using rclone
echo "-> 3. Uploading archive to Cloudflare R2 (winkey-backup/clickhouse/)..."

RCLONE_BIN="$(command -v rclone || echo "/usr/local/bin/rclone")"
if [ ! -x "${RCLONE_BIN}" ] && [ -x "/tmp/rclone" ]; then
  RCLONE_BIN="/tmp/rclone"
fi

if [ ! -x "${RCLONE_BIN}" ]; then
  echo "ERROR: rclone binary not found! Please ensure rclone is installed." >&2
  exit 1
fi

export RCLONE_CONFIG_R2_TYPE="s3"
export RCLONE_CONFIG_R2_PROVIDER="Cloudflare"
export RCLONE_CONFIG_R2_REGION="auto"
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT}"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}"

"${RCLONE_BIN}" copy "${ARCHIVE_PATH}" "R2:winkey-backup/clickhouse/" --fast-list -v
echo "  [OK] Archive uploaded to Cloudflare R2."

# 4. Enforce Retention on R2: Retain exactly 3 ClickHouse backups
echo "-> 4. Checking R2 retention (keeping 3 newest ClickHouse backups)..."
ALL_BACKUPS=$("${RCLONE_BIN}" lsf "R2:winkey-backup/clickhouse/" --files-only | grep '^ch_backup_.*\.tar\.gz$' | sort)
COUNT=$(echo "${ALL_BACKUPS}" | grep -c '^ch_backup_' || true)

echo "  Found ${COUNT} backup(s) on R2."
if [ "${COUNT}" -gt 3 ]; then
  DELETE_COUNT=$((COUNT - 3))
  TO_DELETE=$(echo "${ALL_BACKUPS}" | head -n "${DELETE_COUNT}")
  for b in ${TO_DELETE}; do
    echo "  Pruning old backup: ${b}"
    "${RCLONE_BIN}" delete "R2:winkey-backup/clickhouse/${b}"
  done
  echo "  [OK] Pruned ${DELETE_COUNT} old backup(s)."
fi

# 5. Clean local NVMe backup file
docker exec winkey-analytics-clickhouse rm -f "/var/lib/clickhouse/backup/${BACKUP_NAME}.tar.gz"
echo "  [OK] Cleaned local NVMe temporary archive."

echo "=========================================================="
echo " ClickHouse backup completed successfully!"
echo " Current backups on R2 (winkey-backup/clickhouse/):"
"${RCLONE_BIN}" lsf "R2:winkey-backup/clickhouse/"
echo "=========================================================="
