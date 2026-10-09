# Winkey Application Plane — Services Deployment on k3s (Task I2)

This directory contains Kubernetes manifests, scripts, and documentation for Winkey's user-facing product services and backend microservices deployed on k3s (`edge-1`), implementing ADR-009 (Traefik Gateway & forwardAuth), ADR-014 (Valkey Caching), and ADR-015 (Storage & S3 Integration).

---

## 1. Architecture & Resource Allocation

All workloads are configured with strict resource boundaries (`requests` and `limits`), non-root user execution, readiness (`/readyz`) and liveness (`/healthz`) probes, and `app.kubernetes.io/part-of: winkey` label required for NetworkPolicy ingress to PostgreSQL, NATS, and Valkey.

| Service | Technology | Port | User (UID) | Requests (CPU / RAM) | Limits (CPU / RAM) | Pinned Image Digest |
|---|---|---|---|---|---|---|
| **auth-svc** | Node 22 (Fastify) | 3001 | `node` (1000) | 100m / 256Mi | 300m / 512Mi | `sha256:5a500ea2f25c...` |
| **upload-svc** | Go 1.26 (Distroless) | 3002 | `nonroot` (65532) | 100m / 128Mi | 300m / 256Mi | `sha256:c05f76af2dc5...` |
| **video-svc** | Go 1.26 (Distroless) | 3003 | `nonroot` (65532) | 150m / 256Mi | 500m / 512Mi | `sha256:d72e894bfd64...` |
| **social-svc** | Node 22 (Fastify) | 3004 | `node` (1000) | 100m / 256Mi | 300m / 512Mi | `sha256:5eb09e998516...` |
| **realtime-svc** | Node 22 (Fastify/WS) | 3005 | `node` (1000) | 100m / 256Mi | 300m / 512Mi | `sha256:9349a2f36fdd...` |
| **web-svc** | Next.js 15 (Node 22) | 3000 | `nextjs` (1001) | 150m / 384Mi | 500m / 768Mi | `sha256:d5ebcf1bca2a...` |
| **Total Apps** | | | | **700m / 1.5 GB** | **2.2 vCPU / 3.0 GB** | |

*Apps plane total requests (~700m CPU / 1.5 GB RAM) + Data plane (~450m CPU / 1.1 GB RAM) comfortably fit within the host 4-core / 16 GB budget with ample headroom for Garage storage.*

---

## 2. Directory Structure

```text
deploy/k8s/apps/
├── kustomization.yaml             # Aggregates all 6 applications
├── secrets.sh                     # Idempotent secret generator
├── verify.sh                      # In-cluster probe and rollout verification
├── README.md                      # Deployment & operational runbook
├── auth/
│   ├── deployment.yaml            # auth-svc Deployment
│   ├── service.yaml               # ClusterIP: 3001
│   └── kustomization.yaml         # Pinned image digest
├── upload/
│   ├── deployment.yaml            # upload-svc Deployment
│   ├── service.yaml               # ClusterIP: 3002
│   └── kustomization.yaml         # Pinned image digest
├── video/
│   ├── deployment.yaml            # video-svc Deployment
│   ├── service.yaml               # ClusterIP: 3003
│   └── kustomization.yaml         # Pinned image digest
├── social/
│   ├── deployment.yaml            # social-svc Deployment (HTTP_PORT=3004)
│   ├── service.yaml               # ClusterIP: 3004
│   └── kustomization.yaml         # Pinned image digest
├── realtime/
│   ├── deployment.yaml            # realtime-svc Deployment (HTTP_PORT=3005, port named http)
│   ├── service.yaml               # ClusterIP: 3005
│   └── kustomization.yaml         # Pinned image digest
└── web/
    ├── deployment.yaml            # web-svc Next.js standalone Deployment
    ├── service.yaml               # ClusterIP: 3000
    └── kustomization.yaml         # Pinned image digest
```

---

## 3. Apply Order & Installation

### Step 1: Generate Secrets
Ensure the data plane secrets (`winkey-pg-auth-svc`, `winkey-pg-media-svc`, `winkey-pg-social-svc`, `nats-auth`, `valkey-auth`, `garage-key-upload-svc`) exist. Then run:
```bash
./deploy/k8s/apps/secrets.sh
```
This generates and provisions:
- `auth-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`, `JWT_PRIVATE_KEY` (RS256 2048-bit), `JWT_KID`, `COOKIE_SECRET`, and closed-beta `INVITE_CODES` (ADR-034, task BETA1).
- `auth-google`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional). If not present, `secrets.sh` prompts securely; leave blank to skip. In Google Cloud Console, configure Authorized redirect URI as `https://winkey.vn/v1/auth/oauth/google/callback`.
- `auth-smtp`: `SMTP_URL` (optional). If not present, `secrets.sh` prompts securely; leave blank to skip. In `auth-svc`, `MAIL_TRANSPORT` defaults to `log` in `deploy/k8s/apps/auth/deployment.yaml`. To enable real outbound email sending via SMTP, change `MAIL_TRANSPORT` to `smtp` in `deployment.yaml` and configure the `auth-smtp` secret.
- `upload-secrets`: `DATABASE_URL`, `NATS_URL`.
- `video-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`, `MEDIA_LINK_SECRET` (≥ 32 bytes), `CURSOR_SECRET`.
- `social-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`.
- `realtime-secrets`: `NATS_URL`, `VALKEY_URL`.
- Exports `MEDIA_LINK_SECRET` to `/etc/nginx/winkey-media-link-secret` with mode `0600` for task SEC1-b nginx configuration.

### Step 2: Apply Kustomization
```bash
kubectl apply -k deploy/k8s/apps
```

### Step 3: Verify Rollout
```bash
./deploy/k8s/apps/verify.sh
```

---

## 4. How to Roll a New Image Digest

Images must **never** use `:latest` in production manifests (Hard Rule #6). To update a service to a newly published image:

1. Identify the new multi-arch manifest digest from GitHub Container Registry or CI:
   ```bash
   crictl pull ghcr.io/luantpbk/winkey-<svc>:latest
   crictl inspecti ghcr.io/luantpbk/winkey-<svc>:latest | grep repoDigests
   ```
2. Update the `digest:` field in `deploy/k8s/apps/<svc>/kustomization.yaml`.
3. Apply the updated manifest via Ansible or kubectl:
   ```bash
   kubectl apply -k deploy/k8s/apps/<svc>
   kubectl rollout status deployment/<svc>-svc -n default --timeout=120s
   ```

---

## 5. Rollback Procedure

To roll back a deployment to a previous known-good version:
```bash
# Check revision history
kubectl rollout history deployment/<svc>-svc -n default

# Rollback to the previous revision
kubectl rollout undo deployment/<svc>-svc -n default

# Monitor rollback status
kubectl rollout status deployment/<svc>-svc -n default
```
