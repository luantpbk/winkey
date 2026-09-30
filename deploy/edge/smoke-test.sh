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
echo "[1/10] Checking that /v1/auth/verify is not publicly accessible..."
VERIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/auth/verify")
if [ "$VERIFY_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/auth/verify returned HTTP $VERIFY_STATUS (expected strictly 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/auth/verify returned HTTP 404 (router excluded)."

# 2. Check that unknown /v1 route returns HTTP 404 (does not bleed into web router)
echo "[2/10] Checking that unknown /v1/nope returns HTTP 404..."
NOPE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/nope")
if [ "$NOPE_STATUS" != "404" ]; then
    echo "FAILED: ${BASE_URL}/v1/nope returned HTTP $NOPE_STATUS (expected strictly 404)!" >&2
    exit 1
fi
echo "SUCCESS: ${BASE_URL}/v1/nope returned HTTP 404 (not handled by web router)."

# 3. Check gateway header spoofing protection and client IP assertion via /smoke/whoami
echo "[3/10] Checking header stripping and client IP assertion via /smoke/whoami..."
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
echo "[4/10] Checking Traefik rate limiting on ${BASE_URL}/smoke/whoami..."
echo "  Firing 150 concurrent requests (threshold: average 100/s, burst 50)..."

TMP_DIR=$(mktemp -d)
RESP_LOG="${TMP_DIR}/rate_limit_codes.txt"

# Concurrently fire requests (prefer curl -Z for true parallel burst)
if curl -h all 2>&1 | grep -q -- '--parallel'; then
    NULL_DEV="/dev/null"
    if [[ "${OSTYPE:-}" =~ (msys|cygwin|win32) || "$(uname -s 2>/dev/null)" =~ (MINGW|MSYS|CYGWIN) ]]; then
        NULL_DEV="nul"
    fi
    CONFIG_FILE="${TMP_DIR}/curl_config.txt"
    for i in $(seq 1 150); do
        echo "url = \"${BASE_URL}/smoke/whoami\"" >> "$CONFIG_FILE"
        echo "output = \"${NULL_DEV}\"" >> "$CONFIG_FILE"
    done
    curl -s -Z --parallel-max 100 -w "%{http_code}\n" --config "$CONFIG_FILE" > "$RESP_LOG"
else
    for i in $(seq 1 150); do
        curl -s -o /dev/null -w "%{http_code}\n" "${BASE_URL}/smoke/whoami" > "${TMP_DIR}/code_${i}.txt" &
    done
    wait
    cat "${TMP_DIR}"/code_*.txt > "$RESP_LOG"
fi

COUNT_429=$(grep -c "^429$" "$RESP_LOG" || true)
COUNT_200=$(grep -c "^200$" "$RESP_LOG" || true)
COUNT_OTHER=$(grep -vE '^(200|429)$' "$RESP_LOG" | grep -c . || true)
OTHER_CODES=$(grep -vE '^(200|429)$' "$RESP_LOG" | tr '\n' ' ' || true)
rm -rf "$TMP_DIR"

if [ "$COUNT_OTHER" -gt 0 ]; then
    echo "  Results: $COUNT_200 OK (200), $COUNT_429 Rate Limited (429), $COUNT_OTHER Other ($OTHER_CODES)"
else
    echo "  Results: $COUNT_200 OK (200), $COUNT_429 Rate Limited (429), 0 Other"
fi
if [ "$COUNT_429" -le 0 ]; then
    echo "FAILED: Traefik rateLimit did NOT trigger HTTP 429 under 150 concurrent requests!" >&2
    exit 1
fi
echo "SUCCESS: Traefik rateLimit engaged ($COUNT_429 requests received HTTP 429 Too Many Requests)."

# 5. Check media proxy_cache on media.winkey.vn (MISS/HIT -> HIT)
echo "[5/10] Checking media proxy_cache on ${MEDIA_URL}..."
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

    if [ "$CACHE_STATUS1" != "MISS" ] && [ "$CACHE_STATUS1" != "HIT" ]; then
        echo "FAILED: Expected cache status MISS or HIT, got '$CACHE_STATUS1'!" >&2
        exit 1
    fi
    if [ "$CACHE_STATUS2" != "HIT" ]; then
        echo "FAILED: Expected cache status HIT on second fetch, got '$CACHE_STATUS2'!" >&2
        exit 1
    fi
    echo "SUCCESS: media object cached correctly: ${CACHE_STATUS1} then ${CACHE_STATUS2}."
fi

# 6. Check that internal NodePorts are strictly unreachable from public IP
echo "[6/10] Checking that internal NodePorts are strictly unreachable from public IP (${PUBLIC_IP})..."
for port in 30422 30432 30900; do
    echo "  Testing public port $port (must timeout / fail)..."
    if timeout 3 bash -c "exec 3<>/dev/tcp/${PUBLIC_IP}/${port}" 2>/dev/null; then
        echo "FAILED: TCP ${PUBLIC_IP}:${port} is open from outside!" >&2
        exit 1
    fi
    echo "  Port $port: TCP connect refused/timed out (OK)."
done
echo "SUCCESS: NodePorts 30422, 30432, 30900 are unreachable from the public IP."

# 7. Check user lifecycle: register -> login -> GET /v1/auth/me (200)
echo "[7/10] Checking user authentication lifecycle (register -> login -> /v1/auth/me)..."
TEST_ID="$(date +%s)_$RANDOM"
TEST_EMAIL="smoke_${TEST_ID}@winkey.vn"
TEST_PASS="P@ssw0rd123_${TEST_ID}"
TEST_HANDLE="usr_${TEST_ID}"

echo "  Registering user $TEST_EMAIL..."
REG_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASS}\", \"handle\": \"${TEST_HANDLE}\", \"display_name\": \"Smoke Tester\"}")
REG_CODE=$(echo "$REG_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$REG_CODE" != "201" ]; then
    echo "FAILED: Expected HTTP 201 from /v1/auth/register, got $REG_CODE!" >&2
    echo "$REG_RESP"
    exit 1
fi

echo "  Logging in as $TEST_EMAIL..."
LOGIN_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASS}\"}")
LOGIN_CODE=$(echo "$LOGIN_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$LOGIN_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from /v1/auth/login, got $LOGIN_CODE!" >&2
    echo "$LOGIN_RESP"
    exit 1
fi
ACCESS_TOKEN=$(echo "$LOGIN_RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$ACCESS_TOKEN" ]; then
    echo "FAILED: No access_token found in login response!" >&2
    exit 1
fi

echo "  Calling GET /v1/auth/me with Bearer token..."
ME_RESP=$(curl -sS -i "${BASE_URL}/v1/auth/me" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")
ME_CODE=$(echo "$ME_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$ME_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from /v1/auth/me, got $ME_CODE!" >&2
    echo "$ME_RESP"
    exit 1
fi
if ! echo "$ME_RESP" | grep -q "${TEST_EMAIL}"; then
    echo "FAILED: /v1/auth/me did not contain user email ($TEST_EMAIL)!" >&2
    exit 1
fi
echo "SUCCESS: User registered, logged in, and /v1/auth/me returned HTTP 200."

# 8. Check video listing and search
echo "[8/10] Checking video listing and search APIs..."
echo "  Calling GET /v1/videos..."
VIDEOS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/videos")
if [ "$VIDEOS_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from /v1/videos, got $VIDEOS_CODE!" >&2
    exit 1
fi

echo "  Calling GET /v1/search?q=test..."
SEARCH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/search?q=test")
if [ "$SEARCH_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from /v1/search?q=test, got $SEARCH_CODE!" >&2
    exit 1
fi
echo "SUCCESS: /v1/videos and /v1/search returned HTTP 200."

# 9. Check realtime ticket issuance & WebSocket upgrade (101)
echo "[9/10] Checking realtime ticket issuance and WebSocket upgrade..."
TICKET_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/realtime/ticket" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")
TICKET_CODE=$(echo "$TICKET_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$TICKET_CODE" != "201" ] && [ "$TICKET_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 201 from /v1/realtime/ticket, got $TICKET_CODE!" >&2
    echo "$TICKET_RESP"
    exit 1
fi
TICKET=$(echo "$TICKET_RESP" | grep -o '"ticket":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TICKET" ]; then
    echo "FAILED: No ticket found in realtime ticket response!" >&2
    exit 1
fi

echo "  Attempting WebSocket upgrade on /v1/realtime?ticket=..."
WS_RESP=$(curl -sS -i -N \
  --http1.1 \
  --max-time 3 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "${BASE_URL}/v1/realtime?ticket=${TICKET}" || true)
WS_CODE=$(echo "$WS_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$WS_CODE" != "101" ]; then
    echo "FAILED: Expected HTTP 101 Switching Protocols from WebSocket upgrade, got $WS_CODE!" >&2
    echo "$WS_RESP"
    exit 1
fi
echo "SUCCESS: Realtime ticket issued and WebSocket upgraded to HTTP 101."

# 10. Check multipart upload initiation, presigned PUT to Garage, and completion
echo "[10/10] Checking direct-to-storage multipart upload..."
INIT_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/uploads" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"title": "Smoke Test Video", "filename": "smoke.mp4", "content_type": "video/mp4", "size_bytes": 1024}')
INIT_CODE=$(echo "$INIT_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$INIT_CODE" != "201" ]; then
    echo "FAILED: Expected HTTP 201 from /v1/uploads, got $INIT_CODE!" >&2
    echo "$INIT_RESP"
    exit 1
fi
VIDEO_ID=$(echo "$INIT_RESP" | grep -o '"video_id":"[^"]*"' | cut -d'"' -f4)
echo "  Created upload with video_id: $VIDEO_ID"

echo "  Presigning part 1..."
PARTS_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/uploads/${VIDEO_ID}/parts" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"part_numbers": [1]}')
PARTS_CODE=$(echo "$PARTS_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$PARTS_CODE" != "200" ]; then
    echo "FAILED: Expected HTTP 200 from /v1/uploads/${VIDEO_ID}/parts, got $PARTS_CODE!" >&2
    echo "$PARTS_RESP"
    exit 1
fi
PART_URL=$(echo "$PARTS_RESP" | grep -o '"url":"[^"]*"' | head -n1 | cut -d'"' -f4)

echo "  Uploading 1024 bytes of dummy payload to presigned URL on Garage..."
TMP_PAYLOAD=$(mktemp)
dd if=/dev/urandom of="$TMP_PAYLOAD" bs=1024 count=1 status=none
PUT_RESP=$(curl -sS -i -X PUT --data-binary @"$TMP_PAYLOAD" "$PART_URL")
rm -f "$TMP_PAYLOAD"
PUT_CODE=$(echo "$PUT_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$PUT_CODE" != "200" ]; then
    echo "FAILED: Direct S3 PUT failed with HTTP $PUT_CODE!" >&2
    echo "$PUT_RESP"
    exit 1
fi
ETAG=$(echo "$PUT_RESP" | grep -i '^ETag:' | awk '{print $2}' | tr -d '\r\n"')
echo "  Uploaded part 1 (ETag: $ETAG)"

echo "  Completing multipart upload..."
COMP_RESP=$(curl -sS -i -X POST "${BASE_URL}/v1/uploads/${VIDEO_ID}/complete" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"parts\": [{\"part_number\": 1, \"etag\": \"${ETAG}\"}]}")
COMP_CODE=$(echo "$COMP_RESP" | grep -E '^HTTP/' | head -n1 | awk '{print $2}')
if [ "$COMP_CODE" != "202" ]; then
    echo "FAILED: Expected HTTP 202 from /v1/uploads/${VIDEO_ID}/complete, got $COMP_CODE!" >&2
    echo "$COMP_RESP"
    exit 1
fi
echo "SUCCESS: Multipart upload completed (HTTP 202 Accepted); raw file saved to Garage S3."

echo "=========================================================="
echo " All Winkey Edge & Application Plane Smoke Tests PASSED!"
echo "=========================================================="
