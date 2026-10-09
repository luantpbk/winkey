#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Node is available
if ! command -v node >/dev/null 2>&1; then
  if [ -x "/tmp/node/bin/node" ]; then
    export PATH="/tmp/node/bin:${PATH}"
  elif [ -x "/usr/local/bin/node" ]; then
    export PATH="/usr/local/bin:${PATH}"
  else
    echo "ERROR: node is required to run the platform watchdog." >&2
    exit 1
  fi
fi

exec node "${SCRIPT_DIR}/watchdog.mjs" "$@"
