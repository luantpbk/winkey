#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/deploy/compose/dev.yml"

# Guard: strictly local compose only (refuse any non-localhost / non-127.0.0.1 TARGET_URL)
if [ -n "${TARGET_URL:-}" ]; then
  host=$(node -e '
    try {
      const u = new URL(process.argv[1]);
      console.log(u.hostname);
    } catch {
      process.exit(1);
    }
  ' "${TARGET_URL}" 2>/dev/null) || {
    echo "ERROR: bad TARGET_URL for reset-ratelimits: ${TARGET_URL}" >&2
    exit 1
  }

  case "$host" in
    localhost|127.0.0.1|'[::1]'|::1)
      ;;
    *)
      echo "ERROR: reset-ratelimits refuses non-local TARGET_URL: ${TARGET_URL}" >&2
      exit 1
      ;;
  esac
fi

# Guard: ensure local dev compose file exists
if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "[reset-ratelimits] Compose file ${COMPOSE_FILE} not found, skipping" >&2
  exit 0
fi

# Guard: docker must be available and running
if ! command -v docker >/dev/null 2>&1; then
  echo "[reset-ratelimits] docker CLI not found, skipping" >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "[reset-ratelimits] Docker daemon not running or accessible, skipping" >&2
  exit 0
fi

# Guard: check if valkey service container is running
if ! docker compose -f "${COMPOSE_FILE}" ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^valkey$'; then
  echo "[reset-ratelimits] Valkey service container is not running, skipping" >&2
  exit 0
fi

echo "[reset-ratelimits] Deleting rl:* rate limit keys in compose Valkey..."
docker compose -f "${COMPOSE_FILE}" exec -T valkey sh -c "valkey-cli --scan --pattern 'rl:*' | xargs -r valkey-cli del"
echo "[reset-ratelimits] Rate limits successfully cleared"
