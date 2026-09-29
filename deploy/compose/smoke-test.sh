#!/usr/bin/env bash
# Smoke test for Traefik header stripping middleware (ADR-009 / ADR-014)
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
echo "Running Traefik header spoofing smoke test against ${GATEWAY_URL}/smoke/whoami..."

# Send request with spoofed X-User-Id and X-User-Roles
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
