#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "    Transcoder R2 Secret Setup (gpu-01)           "
echo "=================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_VARS="${SCRIPT_DIR}/../ansible/group_vars/edge.yml"
CF_FROM_VARS=$(grep -E '^\s*cloudflare_account_id:' "${EDGE_VARS}" 2>/dev/null | awk '{print $2}' | tr -d '"'\''')
DEFAULT_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_FROM_VARS:-2588dff2e56bf889918bc5c7af53ad86}}"
read -p "Cloudflare Account ID [mặc định: ${DEFAULT_ACCOUNT_ID}]: " INPUT_ACCOUNT_ID
CF_ACCOUNT_ID="${INPUT_ACCOUNT_ID:-$DEFAULT_ACCOUNT_ID}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

read -p "transcoder Access Key ID: " TR_KEY_ID
TR_KEY_ID=$(echo "$TR_KEY_ID" | xargs)

read -rsp "transcoder Secret Access Key (ẩn khi nhập): " TR_SECRET
echo ""
TR_SECRET=$(echo "$TR_SECRET" | xargs)

ENV_FILE="${HOME}/.winkey-transcoder.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found!"
  exit 1
fi

# Backup existing env file with strict permissions
BACKUP_FILE="${ENV_FILE}.bak.$(date +%s)"
(
  umask 077
  cp "${ENV_FILE}" "${BACKUP_FILE}"
)

# Safely construct updated environment file under /dev/shm
SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

TMP_NEW=$(mktemp -p "${SHM_DIR}" transcoder-env.XXXXXX)
(
  umask 077
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      S3_ENDPOINT=*)
        echo "S3_ENDPOINT=${R2_ENDPOINT}" >> "${TMP_NEW}"
        ;;
      S3_REGION=*)
        echo "S3_REGION=auto" >> "${TMP_NEW}"
        ;;
      S3_ACCESS_KEY_ID=*)
        echo "S3_ACCESS_KEY_ID=${TR_KEY_ID}" >> "${TMP_NEW}"
        ;;
      S3_SECRET_ACCESS_KEY=*)
        echo "S3_SECRET_ACCESS_KEY=${TR_SECRET}" >> "${TMP_NEW}"
        ;;
      *)
        echo "$line" >> "${TMP_NEW}"
        ;;
    esac
  done < "${ENV_FILE}"

  mv "${TMP_NEW}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
)

echo "-> ${ENV_FILE} updated securely with R2 credentials (chmod 600)."
echo "=================================================="
