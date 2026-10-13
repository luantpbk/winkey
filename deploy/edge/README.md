# deploy/edge — Edge Node Tooling & Manifest Guard (ADR-009, ADR-015)

Operational tooling and verification scripts for Winkey edge nodes (`edge-1`, etc.).

## Scripts

### 1. `manifest-drift.sh` — Manifest Drift Guard

Monitors and reconciles differences between canonical manifests in the repository and host auto-deploy manifests in `/var/lib/rancher/k3s/server/manifests/`.

#### Background & Incident Guard (#350/#351)
K3s watches `/var/lib/rancher/k3s/server/manifests/` and reapplies every file whenever the node or k3s server restarts. If a change is applied to the cluster via `kubectl apply` without updating the corresponding manifest on the host filesystem, the host file becomes stale. On the next reboot, k3s silently reverts the cluster resource to the older host version.

`manifest-drift.sh` guarantees that the host manifests remain in sync with the repository.

#### Managed Manifests

| Host Manifest (`/var/lib/rancher/k3s/server/manifests/`) | Repo Source | Notes |
|---|---|---|
| `winkey-ingressroute.yaml` | `deploy/k8s/edge/ingressroute.yaml` | Traefik IngressRoute (/v1/*, smoke, web) |
| `winkey-middlewares.yaml` | `deploy/k8s/edge/middlewares.yaml` | Middlewares (tailnet IP evaluated) |
| `winkey-nodeports.yaml` | `deploy/k8s/edge/nodeports.yaml` | Tailnet-only NodePorts (ADR-015) |
| `winkey-services.yaml` | `deploy/k8s/edge/clusterip-services.yaml` | Internal ClusterIP backend services |
| `winkey-whoami.yaml` | `deploy/k8s/edge/whoami.yaml` | Smoke test workload |
| `traefik-config.yaml` | `deploy/ansible/roles/k3s_server/templates/traefik-config.yaml.j2` | HelmChartConfig for bundled Traefik |

#### Usage

```bash
# Check for drift locally (default, exits 1 on drift):
./deploy/edge/manifest-drift.sh --check

# Check remotely over SSH:
./deploy/edge/manifest-drift.sh --remote edge-1

# Synchronize host manifests from repository canonical versions:
./deploy/edge/manifest-drift.sh --remote edge-1 --sync
```

---

### 2. `smoke-test.sh` — Edge Gateway Smoke Test

Automated end-to-end verification of edge ingress, header stripping, rate limiting, and access controls from an external network perspective.

```bash
SKIP_MEDIA=1 ./deploy/edge/smoke-test.sh
```
