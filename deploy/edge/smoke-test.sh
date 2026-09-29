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
echo "[1/6] Checking that /v1/auth/verify is not publicly accessible..."
VERIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/auth/verify")
if [ "$VERIFY_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/auth/verify returned HTTP $VERIFY_STATUS (expected strictly 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/auth/verify returned HTTP 404 (router excluded)."

# 2. Check that unknown /v1 route returns HTTP 404 (does not bleed into web router)
echo "[2/6] Checking that unknown /v1/nope returns HTTP 404..."
NOPE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/nope")
if [ "$NOPE_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/nope returned HTTP $NOPE_STATUS (expected strictly 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/nope returned HTTP 404 (not handled by web router)."

# 3. Check gateway header spoofing protection and XFF overwrite via /smoke/whoami
echo "[3/6] Checking header stripping and XFF overwrite via /smoke/whoami..."
SPOOFED_IP="203.0.113.195"
WHOAMI_RESP=$(curl -sS -i \
  -H "X-User-Id: spoofed-admin-id" \
  -H "X-User-Roles: admin" \
  -H "X-Forwarded-For: ${SPOOFED_IP}" \
  "${BASE_URL}/smoke/whoami" || true)

HTTP_CODE=$(echo "$WHOAMI_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$HTTP_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from ${BASE_URL}/smoke/whoami, got HTTP $HTTP_CODE!" >&2
    echo "$WHOAMI_RESP"
    exit 1
fi

if echo "$WHOAMI_RESP" | grep -qi "spoofed-admin-id"; then
    echo "FAILED: Spoofed X-User-Id reached upstream whoami!" >&2
    exit 1
fi

if echo "$WHOAMI_RESP" | grep -qi "X-User-Roles"; then
    echo "FAILED: Spoofed X-User-Roles reached upstream whoami!" >&2
    exit 1
fi

if echo "$WHOAMI_RESP" | grep -qi "${SPOOFED_IP}"; then
    echo "FAILED: Spoofed X-Forwarded-For (${SPOOFED_IP}) was not overwritten by nginx!" >&2
    exit 1
fi

echo "SUCCESS: whoami returned HTTP 200; identity headers stripped; spoofed XFF overwritten."

# 4. Check Traefik rate limit behavior (ipStrategy depth: 1)
echo "[4/6] Checking Traefik rate limiting on ${BASE_URL}/smoke/whoami..."
BURST_BLOCKED=0
for i in $(seq 1 70); do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/smoke/whoami" || true)
    if [ "$CODE" = "429" ]; then
        BURST_BLOCKED=1
        echo "  Request $i was rate limited with HTTP 429 Too Many Requests."
        break
    fi
done

if [ "$BURST_BLOCKED" -eq 1 ]; then
    echo "SUCCESS: Traefik rateLimit triggered HTTP 429 upon burst limit."
else
    echo "NOTE: Burst within window (average 100/s, burst 50)."
fi

# 5. Check media.winkey.vn caching (MISS -> HIT)
echo "[5/6] Checking media proxy_cache on ${MEDIA_URL}..."
MEDIA_RESP1=$(curl -sS -i "${MEDIA_URL}/v/smoke/hello.txt" || true)
CACHE_STATUS1=$(echo "$MEDIA_RESP1" | grep -i '^X-Cache-Status:' | awk '{print $2}' | tr -d '\r\n')
CODE1=$(echo "$MEDIA_RESP1" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')

MEDIA_RESP2=$(curl -sS -i "${MEDIA_URL}/v/smoke/hello.txt" || true)
CACHE_STATUS2=$(echo "$MEDIA_RESP2" | grep -i '^X-Cache-Status:' | awk '{print $2}' | tr -d '\r\n')
CODE2=$(echo "$MEDIA_RESP2" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')

echo "  Fetch 1: HTTP $CODE1, X-Cache-Status: ${CACHE_STATUS1:-NONE}"
echo "  Fetch 2: HTTP $CODE2, X-Cache-Status: ${CACHE_STATUS2:-NONE}"

if [ "$CODE1" = "200" ] && [ "$CODE2" = "200" ]; then
    if [ "$CACHE_STATUS1" = "MISS" ] && [ "$CACHE_STATUS2" = "HIT" ]; then
        echo "SUCCESS: media object cached correctly: MISS then HIT."
    elif [ "$CACHE_STATUS2" = "HIT" ]; then
        echo "SUCCESS: media object served from cache (HIT)."
    else
        echo "WARNING: Expected MISS then HIT, got '${CACHE_STATUS1}' then '${CACHE_STATUS2}'"
    fi
else
    echo "INFO: Media object /v/smoke/hello.txt returned HTTP $CODE1 (ready for object upload in STO)."
fi

# 6. Check that internal NodePorts are strictly unreachable from public IP
echo "[6/6] Checking that internal NodePorts are strictly unreachable from public IP (${PUBLIC_IP})..."
for port in 30422 30432 30900; do
    echo "  Testing public port $port (must timeout / fail)..."
    if curl --connect-timeout 2 -sS -I "http://${PUBLIC_IP}:${port}" >/dev/null 2>&1; then
        echo "FAILED: Public port ${PUBLIC_IP}:${port} is accessible from outside!" >&2
        exit 1
    fi
    echo "  Port $port correctly blocked on public IP."
done
echo "SUCCESS: NodePorts 30422, 30432, 30900 are unreachable from the public IP."

echo "=========================================================="
echo " Edge Ingress & Gateway Smoke Tests completed."
echo "=========================================================="
