#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/etc/rancher/k3s/etcd-s3.env"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
  set +a
elif /usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default >/dev/null 2>&1; then
  AWS_ACCESS_KEY_ID=$(/usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
  AWS_SECRET_ACCESS_KEY=$(/usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)
  S3_ENDPOINT=$(/usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.S3_ENDPOINT}' | base64 -d)
  S3_BUCKET=$(/usr/local/bin/k3s kubectl get secret r2-backup-jobs -n default -o jsonpath='{.data.S3_BACKUP_BUCKET}' | base64 -d)
  S3_FOLDER="etcd"
  S3_REGION="auto"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_ENDPOINT S3_BUCKET S3_FOLDER S3_REGION
else
  echo "ERROR: Neither ${ENV_FILE} nor k8s secret r2-backup-jobs was found!" >&2
  echo "Run setup_backup_secrets.sh first." >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

echo "=========================================================="
echo "    K3s etcd Snapshot to Cloudflare R2 (winkey-backup)    "
echo "=========================================================="
# Strip scheme if present (k3s minio-based S3 client requires hostname without scheme)
ENDPOINT_HOST=$(echo "${S3_ENDPOINT}" | sed -e 's|^https://||' -e 's|^http://||' -e 's|/.*$||')

echo "Endpoint:  ${ENDPOINT_HOST}"
echo "Bucket:    ${S3_BUCKET}"
echo "Folder:    ${S3_FOLDER}"
echo "Retention: 7 snapshots"
echo "Compress:  true"
echo ""

# Trigger snapshot save with S3 upload and retention
/usr/local/bin/k3s etcd-snapshot save \
  --name "etcd-daily" \
  --snapshot-compress \
  --s3 \
  --s3-endpoint "${ENDPOINT_HOST}" \
  --s3-bucket "${S3_BUCKET}" \
  --s3-folder "${S3_FOLDER}" \
  --s3-region "${S3_REGION}" \
  --s3-retention 7

echo ""
echo "=== S3 Snapshot List (winkey-backup/etcd) ==="
/usr/local/bin/k3s etcd-snapshot ls \
  --s3 \
  --s3-endpoint "${ENDPOINT_HOST}" \
  --s3-bucket "${S3_BUCKET}" \
  --s3-folder "${S3_FOLDER}" \
  --s3-region "${S3_REGION}"

echo ""
echo "[OK] etcd snapshot saved and verified on Cloudflare R2!"
