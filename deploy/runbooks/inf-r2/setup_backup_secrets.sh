#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "   Cloudflare R2 Backup Token Setup (winkey-backup)       "
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

# Secure temp directory in /dev/shm with umask 077
SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

echo "--- Token: backup-jobs (Bucket: winkey-backup, Read & Write) ---"
KEY_ID=""
while [ -z "$KEY_ID" ]; do
  read -p "Access Key ID: " KEY_ID
  KEY_ID=$(echo "$KEY_ID" | xargs)
  if [ -z "$KEY_ID" ]; then
    echo "  [!] Access Key ID không được để trống. Vui lòng nhập lại."
  fi
done

SECRET_KEY=""
while [ -z "$SECRET_KEY" ]; do
  read -rsp "Secret Access Key (ẩn khi nhập): " SECRET_KEY
  echo ""
  SECRET_KEY=$(echo "$SECRET_KEY" | xargs)
  if [ -z "$SECRET_KEY" ]; then
    echo "  [!] Secret Access Key không được để trống. Vui lòng nhập lại."
  fi
done

echo "  [OK] Đã nhận thông tin xác thực cho winkey-backup."
echo ""

# 1. Create secret r2-backup-jobs in default namespace
TMP_ENV=$(mktemp -p "${SHM_DIR}" r2-bk.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_ENV}"
AWS_ACCESS_KEY_ID=${KEY_ID}
AWS_SECRET_ACCESS_KEY=${SECRET_KEY}
S3_ACCESS_KEY_ID=${KEY_ID}
S3_SECRET_ACCESS_KEY=${SECRET_KEY}
S3_ENDPOINT=${R2_ENDPOINT}
S3_REGION=auto
S3_BACKUP_BUCKET=winkey-backup
EOF
)

sudo /usr/local/bin/k3s kubectl create secret generic r2-backup-jobs -n default \
  --from-env-file="${TMP_ENV}" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
rm -f "${TMP_ENV}"
echo "-> Secret r2-backup-jobs đã tạo thành công trong namespace default."

# 2. Create secret k3s-etcd-s3 in kube-system namespace for native k3s etcd snapshot
TMP_ETCD_ENV=$(mktemp -p "${SHM_DIR}" etcd-bk.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_ETCD_ENV}"
aws_access_key_id=${KEY_ID}
aws_secret_access_key=${SECRET_KEY}
etcd-s3-access-key=${KEY_ID}
etcd-s3-secret-key=${SECRET_KEY}
EOF
)

sudo /usr/local/bin/k3s kubectl create secret generic k3s-etcd-s3 -n kube-system \
  --from-env-file="${TMP_ETCD_ENV}" \
  --dry-run=client -o yaml | sudo /usr/local/bin/k3s kubectl apply -f -
rm -f "${TMP_ETCD_ENV}"
echo "-> Secret k3s-etcd-s3 đã tạo thành công trong namespace kube-system."
echo ""

# 3. Store /etc/rancher/k3s/etcd-s3.env on host for standalone etcd snapshot script
ETCD_ENV_FILE="/etc/rancher/k3s/etcd-s3.env"
TMP_HOST_ENV=$(mktemp -p "${SHM_DIR}" host-etcd.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_HOST_ENV}"
AWS_ACCESS_KEY_ID=${KEY_ID}
AWS_SECRET_ACCESS_KEY=${SECRET_KEY}
S3_ENDPOINT=${R2_ENDPOINT}
S3_BUCKET=winkey-backup
S3_REGION=auto
S3_FOLDER=etcd
EOF
)
sudo cp "${TMP_HOST_ENV}" "${ETCD_ENV_FILE}"
sudo chmod 600 "${ETCD_ENV_FILE}"
rm -f "${TMP_HOST_ENV}"
echo "-> Cấu hình lưu an toàn tại ${ETCD_ENV_FILE} (chmod 600)."

echo "=========================================================="
echo " Đã lưu tất cả Secret và Cấu hình Backup R2 an toàn!"
echo "=========================================================="
