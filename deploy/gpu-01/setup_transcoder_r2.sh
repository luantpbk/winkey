#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "    Transcoder R2 Secret Setup (gpu-01)           "
echo "=================================================="
echo ""
DEFAULT_ACCOUNT_ID="2588dff2e56bf889918bc5c7af53ad86"
read -p "Cloudflare Account ID [mặc định: ${DEFAULT_ACCOUNT_ID}]: " INPUT_ACCOUNT_ID
CF_ACCOUNT_ID="${INPUT_ACCOUNT_ID:-$DEFAULT_ACCOUNT_ID}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
read -p "transcoder Access Key ID: " TR_KEY_ID
TR_KEY_ID=$(echo "$TR_KEY_ID" | xargs)
read -p "transcoder Secret Access Key: " TR_SECRET
TR_SECRET=$(echo "$TR_SECRET" | xargs)
echo ""

ENV_FILE="${HOME}/.winkey-transcoder.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found!"
  exit 1
fi

# Backup existing env file
cp "${ENV_FILE}" "${ENV_FILE}.bak.$(date +%s)"
chmod 600 "${ENV_FILE}.bak."*

# Update S3 configuration
sed -i "s|^S3_ENDPOINT=.*|S3_ENDPOINT=${R2_ENDPOINT}|" "${ENV_FILE}"
sed -i "s|^S3_REGION=.*|S3_REGION=auto|" "${ENV_FILE}"
sed -i "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=${TR_KEY_ID}|" "${ENV_FILE}"
sed -i "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=${TR_SECRET}|" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "-> ${ENV_FILE} updated with R2 credentials (chmod 600)."
echo "=================================================="
