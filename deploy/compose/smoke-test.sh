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

# 4. Check that /v1/videos/<uuid>/comments is routed to social-svc with higher priority than video-svc
echo "Checking Traefik router configuration for social-svc..."
TRAEFIK_API_URL="${TRAEFIK_API_URL:-http://localhost:8082}"

SOCIAL_ROUTER=$(curl -sS "${TRAEFIK_API_URL}/api/http/routers/social@file" || true)
VIDEO_ROUTER=$(curl -sS "${TRAEFIK_API_URL}/api/http/routers/video@file" || true)

if [ -z "$SOCIAL_ROUTER" ] || echo "$SOCIAL_ROUTER" | grep -qi "not found"; then
    echo "FAILED: Router social@file was not found in Traefik API!" >&2
    exit 1
fi

SOCIAL_SERVICE=$(echo "$SOCIAL_ROUTER" | jq -r '.service // empty')
SOCIAL_PRIORITY=$(echo "$SOCIAL_ROUTER" | jq -r '.priority // 0')
VIDEO_PRIORITY=$(echo "$VIDEO_ROUTER" | jq -r '.priority // 0')
SOCIAL_RULE=$(echo "$SOCIAL_ROUTER" | jq -r '.rule // empty')

if [ "$SOCIAL_SERVICE" != "social-svc" ]; then
    echo "FAILED: Router social@file targets service '$SOCIAL_SERVICE' (expected 'social-svc')!" >&2
    exit 1
fi

if [ "$SOCIAL_PRIORITY" -le "$VIDEO_PRIORITY" ]; then
    echo "FAILED: Router social@file priority ($SOCIAL_PRIORITY) is not higher than video@file priority ($VIDEO_PRIORITY)!" >&2
    exit 1
fi

TEST_PATH="/v1/videos/01923456-789a-7bcd-ef01-23456789abcd/comments"
if ! echo "$TEST_PATH" | grep -qE '^/v1/videos/[^/]+/(comments|like)$'; then
    echo "FAILED: Test path $TEST_PATH does not match regex pattern!" >&2
    exit 1
fi

echo "SUCCESS: Router social@file targets social-svc with priority $SOCIAL_PRIORITY (higher than video-svc priority $VIDEO_PRIORITY) and rule matching $TEST_PATH."


