#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "      Interim Vault Setup (gpu-01: R2 -> HDD)             "
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

echo "--- Token: Vault (Tất cả bucket hoặc 3 bucket sao lưu, READ-ONLY) ---"
read -p "Access Key ID: " KEY_ID
KEY_ID=$(echo "$KEY_ID" | xargs)

read -rsp "Secret Access Key (ẩn khi nhập): " KEY_SECRET
echo ""
KEY_SECRET=$(echo "$KEY_SECRET" | xargs)

if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  echo "Error: Key ID and Secret cannot be empty!" >&2
  exit 1
fi

RCLONE_CONF_DIR="${HOME}/.config/rclone"
RCLONE_CONF="${RCLONE_CONF_DIR}/rclone.conf"
mkdir -p "${RCLONE_CONF_DIR}"

SHM_DIR="/dev/shm"
if [ ! -d "${SHM_DIR}" ] || [ ! -w "${SHM_DIR}" ]; then
  SHM_DIR="/tmp"
fi

TMP_CONF=$(mktemp -p "${SHM_DIR}" rclone-v.XXXXXX)
(
  umask 077
  cat <<EOF > "${TMP_CONF}"
[r2_vault]
type = s3
provider = Cloudflare
access_key_id = ${KEY_ID}
secret_access_key = ${KEY_SECRET}
endpoint = ${R2_ENDPOINT}
region = auto
acl = private
EOF
)

cp "${TMP_CONF}" "${RCLONE_CONF}"
chmod 600 "${RCLONE_CONF}"
rm -f "${TMP_CONF}"

echo "-> Cấu hình rclone r2_vault đã lưu tại ${RCLONE_CONF} (chmod 600)."

# Ensure sync_vault.sh is executable
chmod +x "${SCRIPT_DIR}/sync_vault.sh"

echo ""
echo "=========================================================="
echo " HƯỚNG DẪN CÀI ĐẶT SYSTEMD TIMER (CHẠY BẰNG SUDO):        "
echo "=========================================================="
echo "1. Đảm bảo rclone có trong /usr/local/bin:"
echo "   sudo cp /tmp/rclone /usr/local/bin/rclone && sudo chmod 755 /usr/local/bin/rclone"
echo ""
echo "2. Copy cấu hình rclone sang thư mục của user winkey:"
echo "   sudo mkdir -p /home/winkey/.config/rclone"
echo "   sudo cp ${RCLONE_CONF} /home/winkey/.config/rclone/rclone.conf"
echo "   sudo chown -R winkey:winkey /home/winkey/.config"
echo "   sudo chmod 600 /home/winkey/.config/rclone/rclone.conf"
echo ""
echo "3. Cấp quyền thư mục metrics cho user winkey:"
echo "   sudo chown root:winkey /var/lib/prometheus/node-exporter"
echo "   sudo chmod 775 /var/lib/prometheus/node-exporter"
echo ""
echo "4. Cài đặt systemd service và timer:"
echo "   sudo cp ${SCRIPT_DIR}/winkey-vault.service /etc/systemd/system/"
echo "   sudo cp ${SCRIPT_DIR}/winkey-vault.timer /etc/systemd/system/"
echo "   sudo systemctl daemon-reload"
echo "   sudo systemctl enable --now winkey-vault.timer"
echo ""
echo "5. Kiểm tra chạy thử ngay lập tức:"
echo "   sudo systemctl start winkey-vault.service"
echo "   sudo journalctl -u winkey-vault.service -n 50 --no-pager"
echo "=========================================================="
