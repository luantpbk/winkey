# deploy/edge — Edge Node Tooling & Manifest Guard (ADR-009, ADR-015)

Operational tooling and verification scripts for Winkey edge nodes (`edge-1`, etc.).

## Scripts

### 1. `manifest-drift.sh` — Manifest Drift Guard

Monitors and reconciles differences between canonical manifests in the repository and host manifests in `/var/lib/rancher/k3s/server/manifests/`.

#### Background & Incident Guard (#350/#351)
K3s watches `/var/lib/rancher/k3s/server/manifests/` and reapplies every file whenever the node or k3s server restarts. If a change was applied to the cluster via `kubectl apply` without updating the corresponding manifest on the host filesystem, the host file became stale. On the next reboot, k3s silently reverted the cluster resource to the older host version.

To eliminate duplicate sources of truth, all Winkey static manifests (`winkey-ingressroute.yaml`, `winkey-middlewares.yaml`, `winkey-nodeports.yaml`, `winkey-services.yaml`, `winkey-whoami.yaml`) have been **retired** from the k3s auto-deploy directory. Edge resources are now managed directly via `kubectl apply -f /var/lib/rancher/k3s/edge-manifests/` (synced via the Ansible `edge_ingress` role).

`manifest-drift.sh --check` verifies that:
1. **Zero retired static manifests remain**: Exits `1` if any legacy `winkey-*.yaml` file is found in `/var/lib/rancher/k3s/server/manifests/`.
2. **Core k3s manifests are in sync**: Reconciles `traefik-config.yaml` against its canonical Ansible template source.

#### Zero Hardcoded IPs & Dynamic Resolution
Zero hardcoded IPs exist in this repository. Both `TAILSCALE_IP` and `NODE_EXTERNAL_IP` are resolved dynamically at runtime or supplied explicitly:
1. **CLI Flags**: `--tailscale-ip <ip>` and `--external-ip <ip>` take top precedence.
2. **Environment Variables**: `TAILSCALE_IP` and `NODE_EXTERNAL_IP`.
3. **Dynamic Auto-Detection**:
   - `TAILSCALE_IP`: Detected via `tailscale ip -4` (locally or over SSH).
   - `NODE_EXTERNAL_IP`: Detected via external probe (`https://ifconfig.me` / `https://icanhazip.com`).
   - If either IP cannot be resolved, the script exits `1` with a clear descriptive error.

#### Managed Manifests

| Host Manifest (`/var/lib/rancher/k3s/server/manifests/`) | Repo Source | Notes |
|---|---|---|
| `traefik-config.yaml` | `deploy/ansible/roles/k3s_server/templates/traefik-config.yaml.j2` | HelmChartConfig for bundled Traefik (managed by k3s) |
| *(retired: `winkey-*.yaml`)* | `deploy/k8s/edge/` | Applied directly via `kubectl apply`; must NOT exist in manifests dir |

#### Usage

```bash
# Check for drift locally (default, exits 1 on drift or if winkey-*.yaml exists):
./deploy/edge/manifest-drift.sh --check

# Check remotely over SSH:
./deploy/edge/manifest-drift.sh --remote edge-1

# Explicit IP override via CLI flags:
./deploy/edge/manifest-drift.sh --tailscale-ip "<TAILSCALE_IP>" --external-ip "<EXTERNAL_IP>"

# Synchronize host manifests from repository canonical versions:
./deploy/edge/manifest-drift.sh --remote edge-1 --sync
```

---

### 2. `smoke-test.sh` — Edge Gateway Smoke Test

Automated end-to-end verification of edge ingress, header stripping, rate limiting, and access controls from an external network perspective.

```bash
SKIP_MEDIA=1 ./deploy/edge/smoke-test.sh
```
