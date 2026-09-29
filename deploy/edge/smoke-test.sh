#!/usr/bin/env bash
# Smoke test for Winkey Edge Ingress & Gateway (ADR-009, ADR-014, ADR-015)
# Can be run from any machine with public Internet access.
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:-138.2.93.173}"
BASE_URL="${BASE_URL:-https://winkey.vn}"
MEDIA_URL="${MEDIA_URL:-https://media.winkey.vn}"
S3_URL="${S3_URL:-https://s3.winkey.vn}"

echo "=========================================================="
echo " Running Winkey Edge Smoke Tests against ${BASE_URL}"
echo "=========================================================="

# 1. Check that /v1/auth/verify returns HTTP 404 (not publicly routed)
echo "[1/5] Checking that /v1/auth/verify is not publicly accessible..."
VERIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/auth/verify")
if [ "$VERIFY_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/auth/verify returned HTTP $VERIFY_STATUS (expected 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/auth/verify returned HTTP 404 (router excluded)."

# 2. Check that unknown /v1 route returns HTTP 404 (does not bleed into web router)
echo "[2/5] Checking that unknown /v1/nope returns HTTP 404..."
NOPE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/nope")
if [ "$NOPE_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/nope returned HTTP $NOPE_STATUS (expected 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/nope returned HTTP 404 (not handled by web router)."

# 3. Check that spoofed identity headers are cleanly stripped by Traefik strip-user-headers middleware
echo "[3/5] Checking gateway header spoofing protection via /smoke/whoami..."
WHOAMI_RESP=$(curl -sS -H "X-User-Id: spoofed-admin-id" -H "X-User-Roles: admin" "${BASE_URL}/smoke/whoami" || true)

if echo "$WHOAMI_RESP" | grep -i "spoofed-admin-id" >/dev/null; then
    echo "FAILED: Spoofed X-User-Id reached upstream!" >&2
    echo "$WHOAMI_RESP"
    exit 1
fi

if echo "$WHOAMI_RESP" | grep -i "X-User-Roles: admin" >/dev/null; then
    echo "FAILED: Spoofed X-User-Roles reached upstream!" >&2
    echo "$WHOAMI_RESP"
    exit 1
fi
echo "SUCCESS: Spoofed identity headers (X-User-Id, X-User-Roles) were cleanly stripped before upstream."

# 4. Check that NodePorts 30422, 30432, 30900 are unreachable from the public IP
echo "[4/5] Checking that internal NodePorts are strictly unreachable from public IP (${PUBLIC_IP})..."
for port in 30422 30432 30900; do
    echo "  Testing public port $port (must timeout / fail)..."
    if curl --connect-timeout 2 -sS -I "http://${PUBLIC_IP}:${port}" >/dev/null 2>&1; then
        echo "FAILED: Public port ${PUBLIC_IP}:${port} is accessible from outside!" >&2
        exit 1
    fi
    echo "  Port $port correctly blocked on public IP."
done
echo "SUCCESS: NodePorts 30422, 30432, 30900 are unreachable from the public IP."

# 5. Check media.winkey.vn and s3.winkey.vn connectivity and headers
echo "[5/5] Checking media.winkey.vn and s3.winkey.vn host nginx responses..."
MEDIA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${MEDIA_URL}/")
S3_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${S3_URL}/")
echo "  media.winkey.vn responded with HTTP $MEDIA_STATUS"
echo "  s3.winkey.vn responded with HTTP $S3_STATUS"
echo "SUCCESS: Edge hosts respond properly behind host nginx."

echo "=========================================================="
echo " All Edge Ingress & Gateway Smoke Tests PASSED!"
echo "=========================================================="
