#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "    Cloudflare R2 Secure Token Setup (edge-1)     "
echo "=================================================="
echo ""

DEFAULT_ACCOUNT_ID="2588dff2e56bf889918bc5c7af53ad86"
read -p "Cloudflare Account ID [mặc định: ${DEFAULT_ACCOUNT_ID}]: " INPUT_ACCOUNT_ID
CF_ACCOUNT_ID="${INPUT_ACCOUNT_ID:-$DEFAULT_ACCOUNT_ID}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "-> Endpoint R2: ${R2_ENDPOINT}"
echo ""

prompt_token() {
  local name="$1"
  local scope="$2"
  local key_var="$3"
  local sec_var="$4"

  echo "--- Token: ${name} (${scope}) ---"
  local key=""
  while [ -z "$key" ]; do
    read -p "Access Key ID: " key
    if [ -z "$key" ]; then
      echo "  [!] Access Key ID không được để trống. Vui lòng nhập lại."
    fi
  done

  local sec=""
  while [ -z "$sec" ]; do
    read -p "Secret Access Key: " sec
    sec=$(echo "$sec" | xargs)
    if [ -z "$sec" ]; then
      echo "  [!] Secret Access Key không được để trống. Vui lòng nhập lại."
    fi
  done

  key=$(echo "$key" | xargs)
  eval "$key_var='$key'"
  eval "$sec_var='$sec'"
  echo "  [OK] Đã nhận key cho ${name}."
  echo ""
}

# 1. upload-svc (winkey-raw)
prompt_token "upload-svc" "winkey-raw" UP_KEY_ID UP_SECRET
sudo /usr/local/bin/k3s kubectl create secret generic r2-upload-svc -n default \
  --from-literal=AWS_ACCESS_KEY_ID="${UP_KEY_ID}" \
  --from-literal=AWS_SECRET_ACCESS_KEY="${UP_SECRET}" \
  --from-literal=S3_ACCESS_KEY_ID="${UP_KEY_ID}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${UP_SECRET}" \
  --from-literal=S3_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_PUBLIC_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_REGION="auto" \
  --from-literal=S3_RAW_BUCKET="winkey-raw" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
echo "-> Secret r2-upload-svc đã lưu."
echo ""

# 2. video-svc (winkey-media)
prompt_token "video-svc" "winkey-media" VID_KEY_ID VID_SECRET
sudo /usr/local/bin/k3s kubectl create secret generic r2-video-svc -n default \
  --from-literal=AWS_ACCESS_KEY_ID="${VID_KEY_ID}" \
  --from-literal=AWS_SECRET_ACCESS_KEY="${VID_SECRET}" \
  --from-literal=S3_ACCESS_KEY_ID="${VID_KEY_ID}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${VID_SECRET}" \
  --from-literal=S3_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_REGION="auto" \
  --from-literal=S3_MEDIA_BUCKET="winkey-media" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
echo "-> Secret r2-video-svc đã lưu."
echo ""

# 3. media-origin (winkey-media read-only)
prompt_token "media-origin" "winkey-media (read-only)" MO_KEY_ID MO_SECRET
sudo /usr/local/bin/k3s kubectl create secret generic r2-media-origin -n default \
  --from-literal=S3_ACCESS_KEY_ID="${MO_KEY_ID}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${MO_SECRET}" \
  --from-literal=S3_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_REGION="auto" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
echo "-> Secret r2-media-origin đã lưu."
echo ""

# 4. CNPG barman (winkey-pg-backup)
prompt_token "CNPG barman" "winkey-pg-backup" PG_KEY_ID PG_SECRET
sudo /usr/local/bin/k3s kubectl create secret generic r2-pg-backup -n default \
  --from-literal=AWS_ACCESS_KEY_ID="${PG_KEY_ID}" \
  --from-literal=AWS_SECRET_ACCESS_KEY="${PG_SECRET}" \
  --from-literal=S3_ACCESS_KEY_ID="${PG_KEY_ID}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${PG_SECRET}" \
  --from-literal=S3_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_REGION="auto" \
  --from-literal=S3_BACKUP_BUCKET="winkey-pg-backup" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
echo "-> Secret r2-pg-backup đã lưu."
echo ""

# 5. Migration token (All buckets hoặc admin)
prompt_token "Migration & Vault" "Tất cả 4 bucket" MIG_KEY_ID MIG_SECRET
sudo /usr/local/bin/k3s kubectl create secret generic r2-migration -n default \
  --from-literal=S3_ACCESS_KEY_ID="${MIG_KEY_ID}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${MIG_SECRET}" \
  --from-literal=S3_ENDPOINT="${R2_ENDPOINT}" \
  --from-literal=S3_REGION="auto" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
echo "-> Secret r2-migration đã lưu."
echo ""

echo "=================================================="
echo " Đã lưu tất cả Secret R2 thành công!"
echo " Bạn có thể chạy /tmp/check_r2_config.sh để kiểm tra."
echo "=================================================="
