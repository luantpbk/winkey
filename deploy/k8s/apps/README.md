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
- `auth-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`, `JWT_PRIVATE_KEY` (RS256 2048-bit), `JWT_KID`, `COOKIE_SECRET`, closed-beta `INVITE_CODES` (ADR-034, task BETA1), and SOC-1a account security secrets (ADR-049):
  - `TOTP_ENCRYPTION_KEYS`: `k1:<base64-32-bytes>` AES-256-GCM master key used to encrypt TOTP secrets in the database. **CRITICAL**: this key is backed up to the vault on `gpu-01` (`/mnt/hdd_storage/winkey/vault/secrets/totp_encryption_keys.txt`); losing it renders all users' TOTP tokens undecryptable.
  - `SESSION_IP_SALT`: ≥ 32 bytes random salt used to HMAC client IPs for session logging (`sessions.ip_hash`).
  - `WEBAUTHN_USER_HANDLE_KEY`: ≥ 32 bytes random key used to derive persistent user handles (`HMAC-SHA256(key, user_id)`) for WebAuthn passkeys.
- `auth-turnstile`: `TURNSTILE_SECRET` (optional). If not present, `secrets.sh` prompts securely; leave blank to disable Turnstile captcha verification.
- `auth-google`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional). If not present, `secrets.sh` prompts securely; leave blank to skip. In Google Cloud Console, configure Authorized redirect URI as `https://winkey.vn/v1/auth/oauth/google/callback`.
- `auth-smtp`: `SMTP_URL` (optional). If not present, `secrets.sh` prompts securely; leave blank to skip. In `auth-svc`, `MAIL_TRANSPORT` defaults to `log` in `deploy/k8s/apps/auth/deployment.yaml`. To enable real outbound email sending via SMTP, change `MAIL_TRANSPORT` to `smtp` in `deployment.yaml` and configure the `auth-smtp` secret.
- `upload-secrets`: `DATABASE_URL`, `NATS_URL`.
- `video-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`, `MEDIA_LINK_SECRET` (≥ 32 bytes), `CURSOR_SECRET`.
- `social-secrets`: `DATABASE_URL`, `NATS_URL`, `VALKEY_URL`.
- `realtime-secrets`: `NATS_URL`, `VALKEY_URL`.
- Exports `MEDIA_LINK_SECRET` to `/etc/nginx/winkey-media-link-secret` with mode `0600` for task SEC1-b nginx configuration.

### Outbound Egress & Country Header (SOC-1a)
- **Egress**: `auth-svc` connects to external HTTPS endpoints:
  - `challenges.cloudflare.com:443` (Cloudflare Turnstile captcha siteverify).
  - `api.pwnedpasswords.com:443` (HaveIBeenPwned k-anonymity range API for password breach check).
  The cluster uses K3s Flannel CNI with no default-deny egress NetworkPolicies in `default` namespace; direct outbound HTTPS traffic from pods is enabled.
- **Country Header**: Configured with `TRUSTED_COUNTRY_HEADER=CF-IPCountry`. Production apex domain `winkey.vn` currently resolves directly to the Oracle Cloud edge host (`138.2.93.173`) with direct Nginx ingress (unproxied / grey-clouded), so `CF-IPCountry` is null on inbound requests; `country` field in `auth.sessions` gracefully remains null per ADR-049 specification.

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

---

## 6. Edge Ingress & Routing Configuration Lifecycle

Static K3s auto-deploy manifests (`winkey-*.yaml` placed inside `/var/lib/rancher/k3s/server/manifests/`) have been **retired** to eliminate duplicate sources of truth and prevent unintended reboot drift (Incident #350/#351 guard).

### Deployment & Synchronization
* **Explicit Apply:** All edge networking components—including IngressRoute, Middlewares, NodePorts, ClusterIP Services, and whoami (located under `deploy/k8s/edge/`)—are applied directly via Ansible (`edge_ingress` role) or explicit kubectl commands:
  ```bash
  /usr/local/bin/k3s kubectl apply -f deploy/k8s/edge/
  ```

* **Drift Verification:** To verify that no legacy static manifests linger in the K3s auto-deploy directory and that active configurations match their templates, run the drift detection tool:
  ```bash
  ./deploy/edge/manifest-drift.sh --remote edge-1 --check
  ```
  *(Note: `--check` will exit with a non-zero status code `1` if any legacy `winkey-*.yaml` file is detected in the manifests directory).*

