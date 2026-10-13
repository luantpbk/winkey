#!/usr/bin/env bash
# deploy/edge/manifest-drift.sh
# Detects and reconciles drift between canonical repository manifests and
# host auto-deploy manifests in /var/lib/rancher/k3s/server/manifests/ on edge nodes (ADR-009, task EDGE).
#
# Prevents recurrence of Incident #350/#351 where host k3s auto-deploy manifests
# overwrote live cluster resources on node reboot.
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
TAILSCALE_IP="${TAILSCALE_IP:-100.113.240.3}"
NODE_EXTERNAL_IP="${NODE_EXTERNAL_IP:-138.2.93.173}"

# Determine repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --check               Verify manifests on host match repository (default mode).
                        Exits 0 if zero drift, exits 1 if drift detected.
  --sync                Synchronize canonical manifests from repo to host directory.
  --remote <host>       Execute checks or sync remotely over SSH against <host> (e.g. edge-1).
  --repo <path>         Path to winkey repository root.
  --manifests-dir <dir> Path to k3s manifests directory (default: /var/lib/rancher/k3s/server/manifests).
  -h, --help            Show this help message.

Environment variables:
  REMOTE_HOST           Remote host name or IP (e.g. edge-1).
  SSH_USER              SSH username (default: opc).
  REPO_ROOT             Path to repository root.
  MANIFESTS_DIR         Manifest directory on host.
  TAILSCALE_IP          Node Tailscale IP (default: 100.113.240.3).
  NODE_EXTERNAL_IP      Node public IP (default: 138.2.93.173).
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
        -h|--help)
            usage
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            usage
            ;;
    esac
done

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
# Format: host_filename:repo_relative_path:mode:type
# Types: static, template_middleware, template_traefik
MANAGED_MANIFESTS=(
    "winkey-ingressroute.yaml:deploy/k8s/edge/ingressroute.yaml:0644:static"
    "winkey-middlewares.yaml:deploy/k8s/edge/middlewares.yaml:0644:template_middleware"
    "winkey-nodeports.yaml:deploy/k8s/edge/nodeports.yaml:0644:static"
    "winkey-services.yaml:deploy/k8s/edge/clusterip-services.yaml:0644:static"
    "winkey-whoami.yaml:deploy/k8s/edge/whoami.yaml:0644:static"
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
            # Normalize trailing whitespace/newlines
            awk '{sub(/[ \t\r]+$/, "")}1' "$src_file" | awk 'NF {p=1} p' > "$out_file"
            # Ensure single final newline
            echo "" >> "$out_file"
            sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$out_file"
            ;;
        template_middleware)
            # Substitute {{ tailscale_ipv4 }} with the actual tailscale IP
            sed "s/{{ tailscale_ipv4 }}/${TAILSCALE_IP}/g" "$src_file" | \
                awk '{sub(/[ \t\r]+$/, "")}1' | awk 'NF {p=1} p' > "$out_file"
            echo "" >> "$out_file"
            sed -i -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$out_file"
            ;;
        template_traefik)
            # Substitute variables in traefik-config.yaml.j2
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

# Step 1: Check for unexpected / rogue files in host manifests directory
echo "==> [1/3] Checking for unexpected manifests in ${MANIFESTS_DIR}..."
TARGET_FILES=$(list_target_files)

while IFS= read -r item; do
    [ -z "$item" ] && continue
    if is_ignored "$item"; then
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

if [ "$UNEXPECTED_COUNT" -eq 0 ]; then
    echo "  Clean: No unexpected manifests found."
else
    echo "  Found ${UNEXPECTED_COUNT} unexpected manifest(s) on host."
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
    echo " To reconcile host manifests with repository, run:"
    if [ -n "$REMOTE_HOST" ]; then
        echo "   ./deploy/edge/manifest-drift.sh --remote ${REMOTE_HOST} --sync"
    else
        echo "   ./deploy/edge/manifest-drift.sh --sync"
    fi
    echo "=========================================================="
    exit 1
else
    echo "=========================================================="
    echo " SUCCESS: All manifests are synchronized (0 drift)."
    echo "=========================================================="
    exit 0
fi
