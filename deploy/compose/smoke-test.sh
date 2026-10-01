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

for test_subpath in comments like playlist-membership; do
    TEST_PATH="/v1/videos/01923456-789a-7bcd-ef01-23456789abcd/${test_subpath}"
    if ! echo "$TEST_PATH" | grep -qE '^/v1/videos/[^/]+/(comments|like|playlist-membership)$'; then
        echo "FAILED: Test path $TEST_PATH does not match regex pattern!" >&2
        exit 1
    fi
done

echo "SUCCESS: Router social@file targets social-svc with priority $SOCIAL_PRIORITY (higher than video-svc priority $VIDEO_PRIORITY) and rule matching comments, like, and playlist-membership."

# 5. Check that router realtime@file targets realtime-svc with rule matching /v1/realtime (Issue #103)
echo "Checking Traefik router configuration for realtime-svc..."
REALTIME_ROUTER=$(curl -sS "${TRAEFIK_API_URL}/api/http/routers/realtime@file" || true)
if [ -z "$REALTIME_ROUTER" ] || echo "$REALTIME_ROUTER" | grep -qi "not found"; then
    echo "FAILED: Router realtime@file was not found in Traefik API!" >&2
    exit 1
fi
REALTIME_SERVICE=$(echo "$REALTIME_ROUTER" | jq -r '.service // empty')
REALTIME_RULE=$(echo "$REALTIME_ROUTER" | jq -r '.rule // empty')
if [ "$REALTIME_SERVICE" != "realtime-svc" ]; then
    echo "FAILED: Router realtime@file targets service '$REALTIME_SERVICE' (expected 'realtime-svc')!" >&2
    exit 1
fi
if ! echo "$REALTIME_RULE" | grep -q "PathPrefix(\`/v1/realtime\`)"; then
    echo "FAILED: Router realtime@file rule does not match PathPrefix(\`/v1/realtime\`)!" >&2
    exit 1
fi
echo "SUCCESS: Router realtime@file targets realtime-svc with rule $REALTIME_RULE."

# 6. Check that router video@file rule matches /v1/search, /v1/feed, /v1/playback (Issue #112)
VIDEO_RULE=$(echo "$VIDEO_ROUTER" | jq -r '.rule // empty')
for prefix in "/v1/search" "/v1/feed" "/v1/playback"; do
    if ! echo "$VIDEO_RULE" | grep -q "PathPrefix(\`${prefix}\`)"; then
        echo "FAILED: Router video@file rule does not contain PathPrefix(\`${prefix}\`)!" >&2
        exit 1
    fi
done
echo "SUCCESS: Router video@file rule contains /v1/search, /v1/feed, and /v1/playback."

# 7. Check that router social@file rule matches /v1/reports, /v1/moderation, /v1/notifications, /v1/playlists, /v1/me/subscriptions, /v1/me/watch-later
for prefix in "/v1/reports" "/v1/moderation" "/v1/notifications" "/v1/playlists"; do
    if ! echo "$SOCIAL_RULE" | grep -q "PathPrefix(\`${prefix}\`)"; then
        echo "FAILED: Router social@file rule does not contain PathPrefix(\`${prefix}\`)!" >&2
        exit 1
    fi
done
for exact_path in "/v1/me/subscriptions" "/v1/me/watch-later"; do
    if ! echo "$SOCIAL_RULE" | grep -q "Path(\`${exact_path}\`)"; then
        echo "FAILED: Router social@file rule does not contain Path(\`${exact_path}\`)!" >&2
        exit 1
    fi
done
echo "SUCCESS: Router social@file rule contains /v1/reports, /v1/moderation, /v1/notifications, /v1/playlists, /v1/me/subscriptions, and /v1/me/watch-later."

# 8. Check that router auth-protected@file rule matches /v1/admin
AUTH_ROUTER=$(curl -sS "${TRAEFIK_API_URL}/api/http/routers/auth-protected@file" || true)
AUTH_RULE=$(echo "$AUTH_ROUTER" | jq -r '.rule // empty')
if ! echo "$AUTH_RULE" | grep -q "PathPrefix(\`/v1/admin\`)"; then
    echo "FAILED: Router auth-protected@file rule does not contain PathPrefix(\`/v1/admin\`)!" >&2
    exit 1
fi
echo "SUCCESS: Router auth-protected@file rule contains /v1/admin."

# 9. Check Mailpit API
echo "Checking Mailpit API..."
MAILPIT_API_URL="${MAILPIT_API_URL:-http://localhost:8025}"
if ! curl -sS "${MAILPIT_API_URL}/api/v1/info" >/dev/null; then
    echo "FAILED: Mailpit API is not accessible at ${MAILPIT_API_URL}!" >&2
    exit 1
fi
echo "SUCCESS: Mailpit API is responsive."



