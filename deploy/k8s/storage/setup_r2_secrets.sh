#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "    Cloudflare R2 Secure Token Setup (edge-1)     "
echo "=================================================="
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

# Secure temp directory in /dev/shm with umask 077
SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

create_secret_from_env() {
  local secret_name="$1"
  local env_content="$2"

  local tmp_env
  tmp_env=$(mktemp -p "${SHM_DIR}" r2-sec.XXXXXX)
  (
    umask 077
    echo "${env_content}" > "${tmp_env}"
  )

  sudo /usr/local/bin/k3s kubectl create secret generic "${secret_name}" -n default \
    --from-env-file="${tmp_env}" \
    --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -

  rm -f "${tmp_env}"
  echo "-> Secret ${secret_name} đã lưu an toàn."
  echo ""
}

prompt_token() {
  local name="$1"
  local scope="$2"
  local key_var="$3"
  local sec_var="$4"

  echo "--- Token: ${name} (${scope}) ---"
  local key=""
  while [ -z "$key" ]; do
    read -p "Access Key ID: " key
    key=$(echo "$key" | xargs)
    if [ -z "$key" ]; then
      echo "  [!] Access Key ID không được để trống. Vui lòng nhập lại."
    fi
  done

  local sec=""
  while [ -z "$sec" ]; do
    read -rsp "Secret Access Key (ẩn khi nhập): " sec
    echo ""
    sec=$(echo "$sec" | xargs)
    if [ -z "$sec" ]; then
      echo "  [!] Secret Access Key không được để trống. Vui lòng nhập lại."
    fi
  done

  eval "$key_var='$key'"
  eval "$sec_var='$sec'"
  echo "  [OK] Đã nhận key cho ${name}."
  echo ""
}

# 1. upload-svc (winkey-raw)
prompt_token "upload-svc" "winkey-raw" UP_KEY_ID UP_SECRET
create_secret_from_env "r2-upload-svc" "AWS_ACCESS_KEY_ID=${UP_KEY_ID}
AWS_SECRET_ACCESS_KEY=${UP_SECRET}
S3_ACCESS_KEY_ID=${UP_KEY_ID}
S3_SECRET_ACCESS_KEY=${UP_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_PUBLIC_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_RAW_BUCKET=winkey-raw"

# 2. video-svc (winkey-media)
prompt_token "video-svc" "winkey-media" VID_KEY_ID VID_SECRET
create_secret_from_env "r2-video-svc" "AWS_ACCESS_KEY_ID=${VID_KEY_ID}
AWS_SECRET_ACCESS_KEY=${VID_SECRET}
S3_ACCESS_KEY_ID=${VID_KEY_ID}
S3_SECRET_ACCESS_KEY=${VID_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_MEDIA_BUCKET=winkey-media"

# 3. media-origin (winkey-media read-only)
prompt_token "media-origin" "winkey-media (read-only)" MO_KEY_ID MO_SECRET
create_secret_from_env "r2-media-origin" "S3_ACCESS_KEY_ID=${MO_KEY_ID}
S3_SECRET_ACCESS_KEY=${MO_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto"

# 4. CNPG barman (winkey-pg-backup)
prompt_token "CNPG barman" "winkey-pg-backup" PG_KEY_ID PG_SECRET
create_secret_from_env "r2-pg-backup" "AWS_ACCESS_KEY_ID=${PG_KEY_ID}
AWS_SECRET_ACCESS_KEY=${PG_SECRET}
S3_ACCESS_KEY_ID=${PG_KEY_ID}
S3_SECRET_ACCESS_KEY=${PG_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_BACKUP_BUCKET=winkey-pg-backup"

# 5. backup jobs (winkey-backup)
prompt_token "backup jobs" "winkey-backup" BJ_KEY_ID BJ_SECRET
create_secret_from_env "r2-backup-jobs" "AWS_ACCESS_KEY_ID=${BJ_KEY_ID}
AWS_SECRET_ACCESS_KEY=${BJ_SECRET}
S3_ACCESS_KEY_ID=${BJ_KEY_ID}
S3_SECRET_ACCESS_KEY=${BJ_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_BACKUP_BUCKET=winkey-backup"

# 6. Migration token (All buckets hoặc admin)
prompt_token "Migration & Vault" "Tất cả 4 bucket" MIG_KEY_ID MIG_SECRET
create_secret_from_env "r2-migration" "S3_ACCESS_KEY_ID=${MIG_KEY_ID}
S3_SECRET_ACCESS_KEY=${MIG_SECRET}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto"

echo "=================================================="
echo " Đã lưu tất cả Secret R2 thành công!"
echo "=================================================="
