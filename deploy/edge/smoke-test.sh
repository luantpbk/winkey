#!/usr/bin/env bash
# Smoke test for Winkey Edge Ingress & Gateway (ADR-009, ADR-014, ADR-015)
# Can be run from any machine with public Internet access.
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:-138.2.93.173}"
BASE_URL="${BASE_URL:-https://winkey.vn}"
MEDIA_URL="${MEDIA_URL:-https://media.winkey.vn}"
S3_URL="${S3_URL:-https://s3.winkey.vn}"
SKIP_MEDIA="${SKIP_MEDIA:-0}"

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

# 3. Check gateway header spoofing protection and client IP assertion via /smoke/whoami
echo "[3/6] Checking header stripping and client IP assertion via /smoke/whoami..."
CLIENT_IP=$(curl -sS https://api.ipify.org 2>/dev/null || curl -sS https://ifconfig.me 2>/dev/null || true)
if [ -z "$CLIENT_IP" ]; then
    echo "FAILED: Could not detect client public IP to verify X-Forwarded-For!" >&2
    exit 1
fi
echo "  Detected client public IP: $CLIENT_IP"

SPOOFED_IP="203.0.113.195"
WHOAMI_RESP=$(curl -sS -i \
  -H "X-User-Id: spoofed-admin-id" \
  -H "X-User-Roles: admin" \
  -H "X-Forwarded-For: ${SPOOFED_IP}" \
  "${BASE_URL}/smoke/whoami")

HTTP_CODE=$(echo "$WHOAMI_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$HTTP_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from ${BASE_URL}/smoke/whoami, got HTTP $HTTP_CODE!" >&2
    echo "$WHOAMI_RESP"
    exit 1
fi

# Assert spoofed headers stripped
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

# Assert whoami received the actual client IP (proves trustedIPs + depth: 1 works)
if ! echo "$WHOAMI_RESP" | grep -qE "(X-Forwarded-For|X-Real-Ip):.*${CLIENT_IP}"; then
    echo "FAILED: Upstream whoami did not see real client IP ($CLIENT_IP)!" >&2
    echo "Upstream received headers:"
    echo "$WHOAMI_RESP" | grep -iE 'X-Forwarded|X-Real' || true
    exit 1
fi
echo "SUCCESS: whoami returned 200; identity headers stripped; upstream sees real client IP ($CLIENT_IP)."

# 4. Check Traefik rate limit behavior (ipStrategy depth: 1)
echo "[4/6] Checking Traefik rate limiting on ${BASE_URL}/smoke/whoami..."
echo "  Firing 150 concurrent requests (threshold: average 100/s, burst 50)..."

TMP_DIR=$(mktemp -d)
RESP_LOG="${TMP_DIR}/rate_limit_codes.txt"

# Concurrently fire requests (prefer curl -Z for true parallel burst)
if curl -h all 2>&1 | grep -q -- '--parallel'; then
    CONFIG_FILE="${TMP_DIR}/curl_config.txt"
    for i in $(seq 1 150); do
        echo "url = \"${BASE_URL}/smoke/whoami\"" >> "$CONFIG_FILE"
    done
    curl -s -Z --parallel-max 100 -w "%{http_code}\n" -o /dev/null --config "$CONFIG_FILE" > "$RESP_LOG"
else
    for i in $(seq 1 150); do
        curl -s -o /dev/null -w "%{http_code}\n" "${BASE_URL}/smoke/whoami" > "${TMP_DIR}/code_${i}.txt" &
    done
    wait
    cat "${TMP_DIR}"/code_*.txt > "$RESP_LOG"
fi

COUNT_429=$(grep -c "^429$" "$RESP_LOG" || true)
COUNT_200=$(grep -c "^200$" "$RESP_LOG" || true)
rm -rf "$TMP_DIR"

echo "  Results: $COUNT_200 OK (200), $COUNT_429 Rate Limited (429)"
if [ "$COUNT_429" -le 0 ]; then
    echo "FAILED: Traefik rateLimit did NOT trigger HTTP 429 under 150 concurrent requests!" >&2
    exit 1
fi
echo "SUCCESS: Traefik rateLimit engaged ($COUNT_429 requests received HTTP 429 Too Many Requests)."

# 5. Check media proxy_cache on media.winkey.vn (MISS -> HIT)
echo "[5/6] Checking media proxy_cache on ${MEDIA_URL}..."
if [ "${SKIP_MEDIA}" = "1" ]; then
    echo "SKIP: Media proxy_cache test skipped via SKIP_MEDIA=1 (pending task STO)."
else
    MEDIA_RESP1=$(curl -sS -i "${MEDIA_URL}/v/smoke/hello.txt" || true)
    CACHE_STATUS1=$(echo "$MEDIA_RESP1" | grep -i '^X-Cache-Status:' | awk '{print $2}' | tr -d '\r\n')
    CODE1=$(echo "$MEDIA_RESP1" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')

    MEDIA_RESP2=$(curl -sS -i "${MEDIA_URL}/v/smoke/hello.txt" || true)
    CACHE_STATUS2=$(echo "$MEDIA_RESP2" | grep -i '^X-Cache-Status:' | awk '{print $2}' | tr -d '\r\n')
    CODE2=$(echo "$MEDIA_RESP2" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')

    echo "  Fetch 1: HTTP $CODE1, X-Cache-Status: ${CACHE_STATUS1:-NONE}"
    echo "  Fetch 2: HTTP $CODE2, X-Cache-Status: ${CACHE_STATUS2:-NONE}"

    if [ "$CODE1" != "200" ] || [ "$CODE2" != "200" ]; then
        echo "FAILED: Expected HTTP 200 from ${MEDIA_URL}/v/smoke/hello.txt, got $CODE1 / $CODE2 (set SKIP_MEDIA=1 if STO not yet deployed)!" >&2
        exit 1
    fi

    if [ "$CACHE_STATUS1" != "MISS" ] || [ "$CACHE_STATUS2" != "HIT" ]; then
        echo "FAILED: Expected cache status MISS then HIT, got '$CACHE_STATUS1' then '$CACHE_STATUS2'!" >&2
        exit 1
    fi
    echo "SUCCESS: media object cached correctly: MISS then HIT."
fi

# 6. Check that internal NodePorts are strictly unreachable from public IP
echo "[6/6] Checking that internal NodePorts are strictly unreachable from public IP (${PUBLIC_IP})..."
for port in 30422 30432 30900; do
    echo "  Testing public port $port (must timeout / fail)..."
    if timeout 3 bash -c "exec 3<>/dev/tcp/${PUBLIC_IP}/${port}" 2>/dev/null; then
        echo "FAILED: TCP ${PUBLIC_IP}:${port} is open from outside!" >&2
        exit 1
    fi
    echo "  Port $port: TCP connect refused/timed out (OK)."
done
echo "SUCCESS: NodePorts 30422, 30432, 30900 are unreachable from the public IP."

echo "=========================================================="
echo " All Edge Ingress & Gateway Smoke Tests PASSED!"
echo "=========================================================="
