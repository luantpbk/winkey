#!/usr/bin/env bash
# deploy/edge/manifest-drift.sh
# Detects drift between canonical repository manifests and host manifests
# in /var/lib/rancher/k3s/server/manifests/ on edge nodes (ADR-009, ADR-015, task EDGE).
#
# Prevents recurrence of Incident #350/#351 where host k3s auto-deploy manifests
# overwrote live cluster resources on node reboot.
#
# NOTE: Winkey manifests (ingressroute, middlewares, nodeports, clusterip-services, whoami)
# in /var/lib/rancher/k3s/server/manifests/ have been RETIRED in favor of direct
# 'kubectl apply -f /var/lib/rancher/k3s/edge-manifests/'.
# In --check mode, this script asserts that NO winkey-*.yaml manifests remain in
# the k3s auto-deploy directory (exiting 1 if any exist) and verifies traefik-config.yaml.
#
# Usage:
#   ./deploy/edge/manifest-drift.sh [--check]              # Check drift locally (default, exit 1 on drift)
#   ./deploy/edge/manifest-drift.sh --sync                 # Reconcile host manifests to match repo
#   ./deploy/edge/manifest-drift.sh --remote edge-1        # Check drift remotely via SSH
#   ./deploy/edge/manifest-drift.sh --remote edge-1 --sync # Sync canonical repo manifests to remote host

set -euo pipefail

MODE="check"
REMOTE_HOST="${REMOTE_HOST:-}"
SSH_USER="${SSH_USER:-opc}"
MANIFESTS_DIR="${MANIFESTS_DIR:-/var/lib/rancher/k3s/server/manifests}"
TAILSCALE_IP="${TAILSCALE_IP:-}"
NODE_EXTERNAL_IP="${NODE_EXTERNAL_IP:-}"

# Determine repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --check               Verify manifests on host match repository (default mode).
                        Exits 0 if zero drift, exits 1 if drift detected or winkey-*.yaml exists.
  --sync                Synchronize canonical manifests from repo to host directory.
  --remote <host>       Execute checks or sync remotely over SSH against <host> (e.g. edge-1).
  --repo <path>         Path to winkey repository root.
  --manifests-dir <dir> Path to k3s manifests directory (default: /var/lib/rancher/k3s/server/manifests).
  --tailscale-ip <ip>   Node Tailscale IP (detected via 'tailscale ip -4' if omitted).
  --external-ip <ip>    Node public/external IP (detected via external probe if omitted).
  -h, --help            Show this help message.

Environment variables:
  REMOTE_HOST           Remote host name or IP (e.g. edge-1).
  SSH_USER              SSH username (default: opc).
  REPO_ROOT             Path to repository root.
  MANIFESTS_DIR         Manifest directory on host.
  TAILSCALE_IP          Node Tailscale IP (detected via 'tailscale ip -4' if unset).
  NODE_EXTERNAL_IP      Node public IP (detected via external probe if unset).
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check)
            MODE="check"
            shift
            ;;
        --sync)
            MODE="sync"
            shift
            ;;
        --remote)
            REMOTE_HOST="$2"
            shift 2
            ;;
        --repo)
            REPO_ROOT="$2"
            shift 2
            ;;
        --manifests-dir)
            MANIFESTS_DIR="$2"
            shift 2
            ;;
        --tailscale-ip)
            TAILSCALE_IP="$2"
            shift 2
            ;;
        --external-ip)
            NODE_EXTERNAL_IP="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            usage
            ;;
    esac
done

# Resolve TAILSCALE_IP dynamically if unset
if [ -z "$TAILSCALE_IP" ]; then
    if [ -n "$REMOTE_HOST" ]; then
        TAILSCALE_IP=$(ssh -q -o LogLevel=ERROR -o ConnectTimeout=10 "${SSH_USER}@${REMOTE_HOST}" "tailscale ip -4 2>/dev/null" | tr -d '\r\n' || true)
    else
        if command -v tailscale >/dev/null 2>&1; then
            TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | tr -d '\r\n' || true)
        fi
    fi
fi

if [ -z "$TAILSCALE_IP" ]; then
    echo "ERROR: TAILSCALE_IP is required but unset, and could not be detected via 'tailscale ip -4'." >&2
    echo "Please specify --tailscale-ip <ip> or export TAILSCALE_IP=<ip>." >&2
    exit 1
fi

# Resolve NODE_EXTERNAL_IP dynamically if unset
if [ -z "$NODE_EXTERNAL_IP" ]; then
    if [ -n "$REMOTE_HOST" ]; then
        NODE_EXTERNAL_IP=$(ssh -q -o LogLevel=ERROR -o ConnectTimeout=10 "${SSH_USER}@${REMOTE_HOST}" "curl -s -m 5 -4 https://ifconfig.me 2>/dev/null || curl -s -m 5 -4 https://icanhazip.com 2>/dev/null" | tr -d '\r\n' || true)
    else
        if command -v curl >/dev/null 2>&1; then
            NODE_EXTERNAL_IP=$(curl -s -m 5 -4 https://ifconfig.me 2>/dev/null || curl -s -m 5 -4 https://icanhazip.com 2>/dev/null || true)
            NODE_EXTERNAL_IP=$(echo "$NODE_EXTERNAL_IP" | tr -d '\r\n')
        fi
    fi
fi

if [ -z "$NODE_EXTERNAL_IP" ]; then
    echo "ERROR: NODE_EXTERNAL_IP is required but unset, and could not be auto-detected." >&2
    echo "Please specify --external-ip <ip> or export NODE_EXTERNAL_IP=<ip>." >&2
    exit 1
fi

# Known default k3s addons to ignore in manifests directory
IGNORE_LIST=(
    "ccm.yaml"
    "coredns.yaml"
    "local-storage.yaml"
    "metrics-server"
    "rolebindings.yaml"
    "runtimes.yaml"
    "traefik.yaml"
)

# Canonical manifests configuration
# Note: Winkey manifests in /var/lib/rancher/k3s/server/manifests/ are retired.
# Only the k3s-managed Traefik HelmChartConfig is tracked here.
# Format: host_filename:repo_relative_path:mode:type
# Types: static, template_traefik
MANAGED_MANIFESTS=(
    "traefik-config.yaml:deploy/ansible/roles/k3s_server/templates/traefik-config.yaml.j2:0600:template_traefik"
)

is_ignored() {
    local name="$1"
    local ign_item
    for ign_item in "${IGNORE_LIST[@]}"; do
        if [[ "$name" == "$ign_item" ]] || [[ "$name" == "$ign_item/"* ]]; then
            return 0
        fi
    done
    return 1
}

# Create temp directory for canonical rendering
TMP_DIR="$(mktemp -d -t manifest-drift-XXXXXX)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=========================================================="
echo " Winkey Edge Manifest Drift Guard"
echo " Mode:     ${MODE}"
if [ -n "$REMOTE_HOST" ]; then
    echo " Target:   remote (${SSH_USER}@${REMOTE_HOST})"
else
    echo " Target:   local host (${MANIFESTS_DIR})"
fi
echo " Repo:     ${REPO_ROOT}"
echo "=========================================================="

# Helper to read a file from the target (local or remote)
read_target_file() {
    local rel_path="$1"
    if [ -n "$REMOTE_HOST" ]; then
        ssh -q -o LogLevel=ERROR -o ConnectTimeout=10 "${SSH_USER}@${REMOTE_HOST}" "sudo cat '${MANIFESTS_DIR}/${rel_path}' 2>/dev/null" | tr -d '\r' || true
    else
        if [ -f "${MANIFESTS_DIR}/${rel_path}" ]; then
            if [ -r "${MANIFESTS_DIR}/${rel_path}" ]; then
                cat "${MANIFESTS_DIR}/${rel_path}" | tr -d '\r'
            else
                sudo cat "${MANIFESTS_DIR}/${rel_path}" | tr -d '\r'
            fi
        fi
    fi
}

# Helper to list files in manifests directory on target
list_target_files() {
    if [ -n "$REMOTE_HOST" ]; then
        ssh -q -o LogLevel=ERROR -o ConnectTimeout=10 "${SSH_USER}@${REMOTE_HOST}" "sudo find '${MANIFESTS_DIR}' -maxdepth 1 -mindepth 1 -printf '%P\n' 2>/dev/null" | tr -d '\r' || true
    else
        if [ -d "$MANIFESTS_DIR" ]; then
            find "$MANIFESTS_DIR" -maxdepth 1 -mindepth 1 -printf '%P\n' 2>/dev/null | tr -d '\r' || true
        fi
    fi
}

# Helper to write a file to target
write_target_file() {
    local rel_path="$1"
    local local_file="$2"
    local mode="$3"
    if [ -n "$REMOTE_HOST" ]; then
        ssh -q -o LogLevel=ERROR -o ConnectTimeout=10 "${SSH_USER}@${REMOTE_HOST}" "sudo tee '${MANIFESTS_DIR}/${rel_path}' >/dev/null && sudo chmod '${mode}' '${MANIFESTS_DIR}/${rel_path}'" < "$local_file"
    else
        sudo cp "$local_file" "${MANIFESTS_DIR}/${rel_path}"
        sudo chmod "$mode" "${MANIFESTS_DIR}/${rel_path}"
    fi
}

# Render canonical file into temporary staging
render_canonical() {
    local type="$1"
    local src_file="$2"
    local out_file="$3"

    case "$type" in
        static)
            awk '{sub(/[ \t\r]+$/, "")}1' "$src_file" | awk 'NF {p=1} p' > "$out_file"
            echo "" >> "$out_file"
            sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$out_file"
            ;;
        template_traefik)
            local trusted_ips_json="[\"127.0.0.1/32\", \"10.42.0.1/32\", \"${TAILSCALE_IP}/32\", \"${NODE_EXTERNAL_IP}/32\"]"
            sed -e "s/{{ traefik_service_type }}/NodePort/g" \
                -e "s/{{ traefik_nodeport_web }}/30080/g" \
                -e "s/{{ traefik_nodeport_websecure }}/30443/g" \
                -e "s/{{ traefik_trusted_ips | to_json }}/${trusted_ips_json//\//\\/}/g" \
                "$src_file" | awk '{sub(/[ \t\r]+$/, "")}1' | awk 'NF {p=1} p' > "$out_file"
            echo "" >> "$out_file"
            sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$out_file"
            ;;
    esac
}

DRIFT_COUNT=0
UNEXPECTED_COUNT=0

# Step 1: Check for retired winkey-*.yaml manifests and unexpected files in host manifests directory
echo "==> [1/3] Checking for retired winkey-*.yaml and unexpected manifests in ${MANIFESTS_DIR}..."
TARGET_FILES=$(list_target_files)

while IFS= read -r item; do
    [ -z "$item" ] && continue
    if is_ignored "$item"; then
        continue
    fi
    if [[ "$item" == winkey-*.yaml ]]; then
        echo "  [DRIFT] Retired static manifest found on host: ${item}"
        echo "          Winkey manifests in ${MANIFESTS_DIR} have been retired in favor of direct kubectl apply."
        DRIFT_COUNT=$((DRIFT_COUNT + 1))
        continue
    fi
    is_managed=0
    for entry in "${MANAGED_MANIFESTS[@]}"; do
        h_name="${entry%%:*}"
        if [ "$item" = "$h_name" ]; then
            is_managed=1
            break
        fi
    done
    if [ "$is_managed" -eq 0 ]; then
        echo "  [WARNING] Unexpected/unmanaged file found on host: ${item}"
        UNEXPECTED_COUNT=$((UNEXPECTED_COUNT + 1))
    fi
done <<< "$TARGET_FILES"

if [ "$DRIFT_COUNT" -eq 0 ] && [ "$UNEXPECTED_COUNT" -eq 0 ]; then
    echo "  Clean: No retired winkey manifests or unexpected files found."
else
    echo "  Found ${DRIFT_COUNT} retired winkey manifest(s), ${UNEXPECTED_COUNT} unexpected file(s)."
fi

# Step 2: Compare each managed manifest
echo "==> [2/3] Comparing managed manifests against repository..."
for entry in "${MANAGED_MANIFESTS[@]}"; do
    IFS=":" read -r h_name r_path mode type <<< "$entry"
    src_file="${REPO_ROOT}/${r_path}"
    canonical_staging="${TMP_DIR}/canonical_${h_name}"
    host_staging="${TMP_DIR}/host_${h_name}"

    if [ ! -f "$src_file" ]; then
        echo "  [ERROR] Repo source file missing: ${r_path}"
        DRIFT_COUNT=$((DRIFT_COUNT + 1))
        continue
    fi

    # Render canonical reference
    render_canonical "$type" "$src_file" "$canonical_staging"

    # Fetch host content
    read_target_file "$h_name" > "${TMP_DIR}/raw_host_${h_name}"
    if [ ! -s "${TMP_DIR}/raw_host_${h_name}" ]; then
        echo "  [DRIFT] ${h_name} is MISSING or EMPTY on host!"
        DRIFT_COUNT=$((DRIFT_COUNT + 1))
        if [ "$MODE" = "sync" ]; then
            echo "  --> Syncing ${h_name} to host..."
            write_target_file "$h_name" "$canonical_staging" "$mode"
        fi
        continue
    fi

    # Normalize host content for fair semantic comparison
    awk '{sub(/[ \t\r]+$/, "")}1' "${TMP_DIR}/raw_host_${h_name}" | awk 'NF {p=1} p' > "$host_staging"
    echo "" >> "$host_staging"
    sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$host_staging"

    # Diff
    if diff -u "$host_staging" "$canonical_staging" > "${TMP_DIR}/diff_${h_name}.patch"; then
        echo "  [OK] ${h_name} matches repository (${r_path})"
    else
        echo "  [DRIFT] ${h_name} differs from repository (${r_path}):"
        cat "${TMP_DIR}/diff_${h_name}.patch" | sed 's/^/    /'
        DRIFT_COUNT=$((DRIFT_COUNT + 1))

        if [ "$MODE" = "sync" ]; then
            echo "  --> Syncing ${h_name} to host..."
            write_target_file "$h_name" "$canonical_staging" "$mode"
            echo "  --> ${h_name} synced."
        fi
    fi
done

# Step 3: Summary and Exit
echo "==> [3/3] Drift Summary..."
if [ "$MODE" = "sync" ]; then
    echo "Sync operation completed."
    if [ "$DRIFT_COUNT" -gt 0 ]; then
        echo "Re-verifying manifests..."
        exec "$0" --check ${REMOTE_HOST:+--remote "$REMOTE_HOST"} --manifests-dir "$MANIFESTS_DIR"
    fi
fi

if [ "$DRIFT_COUNT" -gt 0 ] || [ "$UNEXPECTED_COUNT" -gt 0 ]; then
    echo "=========================================================="
    echo " FAILED: Drift detected! (Drifted: ${DRIFT_COUNT}, Unexpected: ${UNEXPECTED_COUNT})"
    if [ "$DRIFT_COUNT" -gt 0 ]; then
        echo " Note: Retired winkey-*.yaml manifests must be removed from ${MANIFESTS_DIR}."
    fi
    echo "=========================================================="
    exit 1
else
    echo "=========================================================="
    echo " SUCCESS: All manifests are synchronized (0 drift)."
    echo "=========================================================="
    exit 0
fi
