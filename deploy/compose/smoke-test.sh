#!/usr/bin/env bash
# Smoke test for Traefik gateway routing & security middleware (ADR-009 / ADR-014)
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
echo "Running Traefik header spoofing smoke test against ${GATEWAY_URL}/smoke/whoami..."

# 1. Send request with spoofed X-User-Id and X-User-Roles
RESP=$(curl -sS -H "X-User-Id: spoofed-admin-id" -H "X-User-Roles: admin" "${GATEWAY_URL}/smoke/whoami")

if echo "$RESP" | grep -i "spoofed-admin-id" >/dev/null; then
    echo "FAILED: Spoofed X-User-Id reached upstream!" >&2
    echo "$RESP"
    exit 1
fi

if echo "$RESP" | grep -i "X-User-Roles: admin" >/dev/null; then
    echo "FAILED: Spoofed X-User-Roles reached upstream!" >&2
    echo "$RESP"
    exit 1
fi

echo "SUCCESS: Spoofed identity headers were cleanly stripped by Traefik middleware before reaching upstream."

# 2. Check that /v1/auth/verify is NOT publicly routed (contract: internal gateway forwardAuth only)
# Traefik should match no router and return 404 Not Found directly
echo "Checking that /v1/auth/verify returns 404..."
VERIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${GATEWAY_URL}/v1/auth/verify")

if [ "$VERIFY_STATUS" != "404" ]; then
    echo "FAILED: /v1/auth/verify returned HTTP $VERIFY_STATUS (expected 404)!" >&2
    exit 1
fi

echo "SUCCESS: /v1/auth/verify is not publicly routed (HTTP 404)."

# 3. Check that unknown /v1 routes return 404 and do not fall through to web service
echo "Checking that unknown /v1/nope returns 404..."
NOPE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${GATEWAY_URL}/v1/nope")

if [ "$NOPE_STATUS" != "404" ]; then
    echo "FAILED: /v1/nope returned HTTP $NOPE_STATUS (expected 404)!" >&2
    exit 1
fi

echo "SUCCESS: /v1/nope returned 404 and did not fall through to web service."

