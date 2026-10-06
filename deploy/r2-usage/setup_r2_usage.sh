#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "    Cloudflare R2 Usage Exporter Setup (INF-R2b)          "
echo "=========================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_VARS="${SCRIPT_DIR}/../ansible/group_vars/edge.yml"
CF_FROM_VARS=$(grep -E '^\s*cloudflare_account_id:' "${EDGE_VARS}" 2>/dev/null | awk '{print $2}' | tr -d '"'\''')
DEFAULT_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_FROM_VARS:-2588dff2e56bf889918bc5c7af53ad86}}"

read -p "Cloudflare Account ID [mặc định: ${DEFAULT_ACCOUNT_ID}]: " INPUT_ACCOUNT_ID
CF_ACCOUNT_ID="${INPUT_ACCOUNT_ID:-$DEFAULT_ACCOUNT_ID}"
echo "-> Account ID: ${CF_ACCOUNT_ID}"
echo ""

CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
if [ -z "$CF_TOKEN" ]; then
  echo "Token yêu cầu quyền: Account -> Analytics -> Read"
  while [ -z "$CF_TOKEN" ]; do
    read -rsp "Cloudflare API Token (ẩn khi nhập): " CF_TOKEN
    echo ""
    CF_TOKEN=$(echo "$CF_TOKEN" | xargs)
    if [ -z "$CF_TOKEN" ]; then
      echo "  [!] Token không được để trống. Vui lòng nhập lại."
    fi
  done
  echo "  [OK] Đã nhận Cloudflare API Token."
else
  echo "  [OK] Đã nhận Cloudflare API Token từ biến môi trường."
fi
echo ""

SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

TMP_ENV=$(mktemp -p "${SHM_DIR}" r2-usg.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_ENV}"
CLOUDFLARE_ACCOUNT_ID=${CF_ACCOUNT_ID}
CF_ACCOUNT_ID=${CF_ACCOUNT_ID}
CLOUDFLARE_API_TOKEN=${CF_TOKEN}
CF_API_TOKEN=${CF_TOKEN}
EXPORTER_PORT=9095
SCRAPE_INTERVAL_SECONDS=900
R2_BUCKETS=winkey-raw,winkey-media,winkey-pg-backup,winkey-backup
EOF
)

# Create secret in observability namespace for the Kubernetes deployment
if command -v /usr/local/bin/k3s >/dev/null 2>&1; then
  sudo /usr/local/bin/k3s kubectl create namespace observability --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
  sudo /usr/local/bin/k3s kubectl create secret generic r2-usage-secrets -n observability \
    --from-env-file="${TMP_ENV}" \
    --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
  echo "-> Đã tạo Secret r2-usage-secrets trong namespace observability."
elif command -v kubectl >/dev/null 2>&1; then
  kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic r2-usage-secrets -n observability \
    --from-env-file="${TMP_ENV}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "-> Đã tạo Secret r2-usage-secrets trong namespace observability."
fi

rm -f "${TMP_ENV}"

echo "=========================================================="
echo " Cấu hình r2-usage đã hoàn tất thành công!"
echo "=========================================================="
