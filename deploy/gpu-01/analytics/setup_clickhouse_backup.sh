#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "    ClickHouse R2 Backup Setup (gpu-01: winkey-backup)    "
echo "=========================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_VARS="${SCRIPT_DIR}/../../ansible/group_vars/edge.yml"
CF_FROM_VARS=$(grep -E '^\s*cloudflare_account_id:' "${EDGE_VARS}" 2>/dev/null | awk '{print $2}' | tr -d '"'\''')
DEFAULT_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_FROM_VARS:-2588dff2e56bf889918bc5c7af53ad86}}"

read -p "Cloudflare Account ID [mặc định: ${DEFAULT_ACCOUNT_ID}]: " INPUT_ACCOUNT_ID
CF_ACCOUNT_ID="${INPUT_ACCOUNT_ID:-$DEFAULT_ACCOUNT_ID}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "-> Endpoint R2: ${R2_ENDPOINT}"
echo ""

echo "--- Token: ClickHouse backup (Bucket: winkey-backup, Read & Write) ---"
read -p "Access Key ID: " KEY_ID
KEY_ID=$(echo "$KEY_ID" | xargs)

read -rsp "Secret Access Key (ẩn khi nhập): " KEY_SECRET
echo ""
KEY_SECRET=$(echo "$KEY_SECRET" | xargs)

if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  echo "Error: Key ID and Secret cannot be empty!" >&2
  exit 1
fi

ENV_FILE="${HOME}/.winkey-clickhouse-backup.env"
SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

TMP_FILE=$(mktemp -p "${SHM_DIR}" ch-bk.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_FILE}"
AWS_ACCESS_KEY_ID=${KEY_ID}
AWS_SECRET_ACCESS_KEY=${KEY_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
R2_ENDPOINT=${R2_ENDPOINT}
S3_BUCKET=winkey-backup
EOF
)

cp "${TMP_FILE}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
rm -f "${TMP_FILE}"

echo "-> Thông tin xác thực đã lưu vào ${ENV_FILE} (chmod 600)."

# Ensure rclone is executable
chmod +x "${SCRIPT_DIR}/backup_clickhouse.sh"

echo "=========================================================="
echo " Cấu hình backup ClickHouse đã hoàn tất!"
echo " Chạy kiểm thử: bash ${SCRIPT_DIR}/backup_clickhouse.sh"
echo "=========================================================="
