#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/etc/rancher/k3s/etcd-s3.env"

if [ -f "${ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
elif sudo [ -f "${ENV_FILE}" ]; then
  # Read with sudo if permission denied
  eval "$(sudo cat "${ENV_FILE}")"
else
  # Fallback to reading from k8s secret if env file not present
  if sudo /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=$(sudo /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
    AWS_SECRET_ACCESS_KEY=$(sudo /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)
    S3_ENDPOINT=$(sudo /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.S3_ENDPOINT}' | base64 -d)
    S3_BUCKET=$(sudo /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.S3_BACKUP_BUCKET}' | base64 -d)
    S3_FOLDER="etcd"
    S3_REGION="auto"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_ENDPOINT S3_BUCKET S3_FOLDER S3_REGION
  else
    echo "ERROR: Neither ${ENV_FILE} nor k8s secret r2-backup-jobs was found!" >&2
    echo "Run setup_backup_secrets.sh first." >&2
    exit 1
  fi
fi

export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

echo "=========================================================="
echo "    K3s etcd Snapshot to Cloudflare R2 (winkey-backup)    "
echo "=========================================================="
echo "Endpoint:  ${S3_ENDPOINT}"
echo "Bucket:    ${S3_BUCKET}"
echo "Folder:    ${S3_FOLDER}"
echo "Retention: 7 snapshots"
echo "Compress:  true"
echo ""

# Trigger snapshot save with S3 upload and retention
sudo /usr/local/bin/k3s etcd-snapshot save \
  --name "etcd-daily" \
  --snapshot-compress \
  --s3 \
  --s3-endpoint "${S3_ENDPOINT}" \
  --s3-bucket "${S3_BUCKET}" \
  --s3-folder "${S3_FOLDER}" \
  --s3-region "${S3_REGION}" \
  --s3-retention 7

echo ""
echo "=== S3 Snapshot List (winkey-backup/etcd) ==="
sudo /usr/local/bin/k3s etcd-snapshot ls \
  --s3 \
  --s3-endpoint "${S3_ENDPOINT}" \
  --s3-bucket "${S3_BUCKET}" \
  --s3-folder "${S3_FOLDER}" \
  --s3-region "${S3_REGION}"

echo ""
echo "[OK] etcd snapshot saved and verified on Cloudflare R2!"
