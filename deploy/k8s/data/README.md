# Winkey Data Plane — PostgreSQL 17, NATS JetStream 2.10+, Valkey 8 on k3s

This directory contains Kubernetes manifests, scripts, and documentation for Winkey's core data plane on k3s (`edge-1`), implementing ADR-007 (PostgreSQL schema isolation), ADR-008 (Transactional Outbox & JetStream), ADR-013 (k3s deployment), ADR-014 (Valkey caching), and ADR-015 (Storage & Backups).

---

## 1. Architecture & Resource Allocation

| Component | Technology | Version | Instances | Storage | Requests (CPU / RAM) | Limits (CPU / RAM) |
|---|---|---|---|---|---|---|
| **Operator** | CloudNativePG (CNPG) | v1.25.4 | 1 | — | 100m / 100Mi | 500m / 256Mi |
| **PostgreSQL** | PostgreSQL (CNPG) | 17.4 | 1 (scale patch: 2) | 15 Gi (`local-path`) | 200m / 512Mi | 1000m / 1536Mi |
| **NATS** | NATS JetStream | 2.10.26-alpine | 1 | 5 Gi (`local-path`) | 100m / 256Mi | 500m / 512Mi |
| **Valkey** | Valkey | 8.0.2-alpine | 1 | 1 Gi (`local-path`) | 50m / 256Mi | 500m / 512Mi |
| **Jobs** | golang-migrate, nats-box | pinned | transient | — | ~40m / 64Mi | ~300m / 256Mi |
| **Total** | | | | **21 Gi** | **~490m / ~1.2 GB** | **≤ 2.3 vCPU / 3 GB** |

Resource requests are strictly bounded below the host budget (1 vCPU / 4 GB) to leave ample headroom for product services and Garage storage.

#### Resource Request Verification Command
To verify resource requests across all data plane workloads on the cluster:
```bash
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.resources.requests.cpu}{"\t"}{.resources.requests.memory}{"\n"}{end}{end}' | grep -E 'cnpg-controller|nats-0|valkey-0|winkey-pg-1'
```
Example cluster output:
```text
cnpg-controller-manager-6c98c7d94-6wvq2    100m    100Mi
nats-0                                    100m    256Mi
valkey-0                                  50m     256Mi
winkey-pg-1                               200m    512Mi
```
*Total steady-state: 450m CPU / 1124Mi RAM (with bootstrap jobs: ~490m CPU / ~1.2 GB RAM).*

---

## 2. Directory Structure

```text
deploy/k8s/data/
├── kustomization.yaml             # Bundles all data plane components
├── cnpg-operator.yaml             # Pinned CloudNativePG v1.25.4 operator manifest
├── postgres-cluster.yaml          # CNPG Cluster (17.4, 15Gi) + ScheduledBackup + barman S3 to Garage
├── postgres-setup-job.yaml        # golang-migrate v4.18.2 + RBAC grants job
├── nats-config.yaml               # JetStream config with auth.conf include
├── nats-statefulset.yaml          # NATS 2.10.26 StatefulSet + Service
├── nats-bootstrap-job.yaml        # Idempotent JetStream stream provisioning (VIDEO, USER, SOCIAL, DLQ)
├── valkey-config.yaml             # maxmemory 512mb, volatile-lru, AOF everysec
├── valkey-statefulset.yaml        # Valkey 8.0.2 StatefulSet + Service
├── network-policy.yaml            # NetworkPolicy: part-of: winkey only + Tailscale NodePort
├── scale-2-instances.patch.yaml   # Documentation & patch for HA 2-instance failover
├── secrets.sh                     # Idempotent password & secret generator
├── verify.sh                      # Comprehensive end-to-end smoke test
├── migrations/                    # Vendored SQL migrations (mirror of db/migrations/)
│   ├── 000001_foundation.{up,down}.sql
│   ├── 000002_auth.{up,down}.sql
│   ├── 000003_media.{up,down}.sql
│   ├── 000004_transcode_heartbeat.{up,down}.sql
│   ├── 000005_social.{up,down}.sql
│   ├── 000006_moderation.{up,down}.sql
│   └── 000007_search.{up,down}.sql
└── scripts/
    └── grants.sql                 # SQL schema isolation & grant script
```

> [!NOTE]
> **Vendored Migrations Synchronization Policy**:
> `deploy/k8s/data/migrations/` is a direct mirror of `db/migrations/`, packaged here so k8s bootstrap jobs can mount them directly. Hard rule #3 states that only the architect writes schema migrations. To prevent drift, CI job `k8s` strictly asserts `diff -r db/migrations deploy/k8s/data/migrations`. The architect updates both directories together in schema migration PRs.

---

## 3. Apply Order & Installation

### Step 1: Install CloudNativePG Operator
Apply the pinned CNPG operator (v1.25.4) and wait for readiness:
```bash
kubectl apply -f deploy/k8s/data/cnpg-operator.yaml
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=120s
```

### Step 2: Generate & Apply Secrets
Ensure the Garage backup secret (`garage-key-pg-backup`, created during STO setup) is present. Then execute `secrets.sh` to generate application and database credentials:
```bash
./deploy/k8s/data/secrets.sh
```
This creates:
- `winkey-pg-owner`: Superuser / migration owner
- `winkey-pg-auth-svc`: User `auth_svc` password
- `winkey-pg-media-svc`: User `media_svc` password
- `winkey-pg-social-svc`: User `social_svc` password
- `nats-auth`: ConfigMap with bcrypt credentials referenced by NATS server
- `nats-users-secrets`: Plaintext credentials for client services
- `valkey-secret`: Valkey `requirepass` password

### Step 3: Apply Data Plane Manifests
```bash
kubectl apply -k deploy/k8s/data
```
Monitor cluster creation:
```bash
kubectl wait --for=condition=Ready cluster/winkey-pg --timeout=300s
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=nats --timeout=180s
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=valkey --timeout=180s
kubectl wait --for=condition=complete job/winkey-pg-setup --timeout=120s
kubectl wait --for=condition=complete job/nats-bootstrap --timeout=120s
```

---

## 4. Secrets Specification

| Secret Name | Key | Description | Consumer |
|---|---|---|---|
| `winkey-pg-owner` | `username`, `password` | PostgreSQL database owner (`winkey_owner`) | `winkey-pg-setup` Job |
| `winkey-pg-auth-svc` | `username`, `password` | Dedicated user for auth service | `services/auth` |
| `winkey-pg-media-svc` | `username`, `password` | Dedicated user for video/upload/transcoder | `services/video`, `services/upload`, `services/transcoder` |
| `winkey-pg-social-svc` | `username`, `password` | Dedicated user for social service | `services/social` |
| `nats-auth` | `auth.conf` | Dynamic auth configuration for NATS server | `pod/nats-0` |
| `nats-users-secrets` | `<service>_USER`, `<service>_PASSWORD` | NATS client credentials | All microservices |
| `valkey-secret` | `VALKEY_PASSWORD` | Valkey authentication token | Microservices using cache |
| `garage-key-pg-backup` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_REGION` | Garage S3 backup credentials | CloudNativePG barmanObjectStore |

---

## 5. NATS Permissions & Streams Matrix

Per `contracts/events/README.md`:

### Streams Configured

| Stream | Subjects | Storage | Retention | Discard | Max Age | Max Bytes | Duplication Window |
|---|---|---|---|---|---|---|---|
| `VIDEO` | `video.>` | File | Limits | Old | 7d | Unlimited | 2m |
| `USER` | `user.>` | File | Limits | Old | 7d | Unlimited | 2m |
| `SOCIAL` | `social.>` | File | Limits | Old | 7d | Unlimited | 2m |
| `DLQ` | `dlq.>` | File | Limits | Old | 30d | Unlimited | 2m |
| `ANALYTICS` | `analytics.>` | File | Limits | Old | 7d | 5 GiB | 2m |

### Service Auth Matrix

| Service User | Publish Permissions | Subscribe Permissions |
|---|---|---|
| `auth` | `user.>`, `_INBOX.>`, `$JS.API.>` | `_INBOX.>` |
| `upload` | `video.uploaded`, `_INBOX.>`, `$JS.API.>` | `rt.video.*.progress`, `_INBOX.>` |
| `transcoder` | `video.ready`, `video.failed`, `rt.video.*.progress`, `dlq.video.uploaded`, `_INBOX.>`, `$JS.API.>` | `video.uploaded`, `_INBOX.>` |
| `video` | `video.deleted`, `video.moderated`, `video.visibility_changed`, `analytics.>`, `_INBOX.>`, `$JS.API.>` | `social.video.like_changed`, `social.subscription.changed`, `_INBOX.>` |
| `social` | `social.comment.created`, `social.video.like_changed`, `social.subscription.changed`, `_INBOX.>`, `$JS.API.>` | `video.ready`, `video.deleted`, `video.moderated`, `_INBOX.>` |
| `realtime` | `_INBOX.>`, `$JS.API.>` | `video.ready`, `video.failed`, `social.comment.created`, `social.video.like_changed`, `rt.video.*.progress`, `_INBOX.>` |
| `analytics` | `_INBOX.>`, `$JS.API.STREAM.INFO.ANALYTICS`, `$JS.API.CONSUMER.*.ANALYTICS.analytics-clickhouse`, `$JS.ACK.ANALYTICS.analytics-clickhouse.>` | `_INBOX.>` |

*All standard users have access to `$JS.API.>` for JetStream pull consumers and `_INBOX.>` for RPC responses. User `analytics` is strictly restricted to consumer `analytics-clickhouse` on stream `ANALYTICS`.*

---

## 6. Valkey Memory & Eviction Policy

Configured in `valkey-config.yaml`:
- `maxmemory 512mb`
- `maxmemory-policy volatile-lru`
- `appendonly yes` (AOF `everysec`)

> [!IMPORTANT]
> **Why `volatile-lru`?**
> As defined in ADR-014, `video-svc` maintains critical in-memory counters (`views:pending` and `views:flush:*`) that have **no TTL** and must never be evicted prior to being flushed to PostgreSQL. Ephemeral cache keys, rate limiting buckets, and session tokens have explicit TTLs and are evicted under memory pressure using LRU.

---

## 7. PostgreSQL Database Roles & Isolation

PostgreSQL follows ADR-007 schema isolation:
- Database: `winkey`, Owner: `winkey_owner` (runs migrations).
- `auth_svc`: Full CRUD on `auth.*`.
- `media_svc`: Full CRUD on `media.*`. Read-only SELECT on `auth.public_profiles`. Explicitly REVOKED from `auth.users`.
- `social_svc`: Full CRUD on `social.*`. Read-only SELECT on `auth.public_profiles`. Explicitly REVOKED from `auth.users`.

---

## 8. Backup & Restore Runbook (CloudNativePG + Garage)

Backups are enabled immediately via `barmanObjectStore` pointing to Garage S3 (`s3://winkey-pg-backup/`).

### Verification & Manual Backup
Trigger an immediate on-demand backup:
```bash
# Using kubectl cnpg plugin
kubectl cnpg backup winkey-pg -n default

# Or creating a Backup CR directly
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: winkey-pg-manual-backup
  namespace: default
spec:
  cluster:
    name: winkey-pg
EOF
```

Check backup status:
```bash
kubectl get backup -n default
```

Verify backup files on Garage S3:
```bash
# Using AWS CLI with pg-backup key
AWS_ACCESS_KEY_ID=$(kubectl get secret garage-key-pg-backup -n default -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
AWS_SECRET_ACCESS_KEY=$(kubectl get secret garage-key-pg-backup -n default -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)
aws --endpoint-url http://127.0.0.1:3900 s3 ls s3://winkey-pg-backup/ --recursive
```

### Recovery Procedure
To restore a new cluster from a Garage S3 backup:
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: winkey-pg-restored
spec:
  instances: 1
  storage:
    size: 15Gi
    storageClass: local-path
  bootstrap:
    recovery:
      source: winkey-pg
  externalClusters:
    - name: winkey-pg
      barmanObjectStore:
        destinationPath: s3://winkey-pg-backup/
        endpointURL: http://garage-s3.default.svc:3900
        s3Credentials:
          accessKeyId:
            name: garage-key-pg-backup
            key: AWS_ACCESS_KEY_ID
          secretAccessKey:
            name: garage-key-pg-backup
            key: AWS_SECRET_ACCESS_KEY
```

---

## 9. Scaling to 2 Instances (High Availability)

To scale PostgreSQL to 2 instances with streaming replication:

1. Apply the scale patch:
   ```bash
   kubectl patch cluster winkey-pg --type merge -p '{"spec":{"instances":2}}'
   ```
2. **NodePort routing requirement**:
   When running >1 instance, the `postgres-nodeport` Service (defined in `deploy/k8s/edge/tailscale-nodeports.yaml`) must route write traffic strictly to the primary instance.
   Update the Service selector:
   ```yaml
   selector:
     app.kubernetes.io/name: postgres
     cnpg.io/instanceRole: primary
   ```
   *(With 1 instance, `cnpg.io/instanceRole: primary` is also present on `winkey-pg-1`, making the selector safe in both 1-node and 2-node setups).*

---

## 10. Rollback Procedure

- **Database migrations**:
  Down migrations can be executed sequentially using `golang-migrate`:
  ```bash
  kubectl run pg-rollback --rm -i --restart=Never \
    --image=migrate/migrate:v4.18.2 \
    --env="PGPASSWORD=$(kubectl get secret winkey-pg-owner -o jsonpath='{.data.password}' | base64 -d)" \
    --command -- migrate -path /migrations -database "postgres://winkey_owner:${PGPASSWORD}@winkey-pg-rw:5432/winkey?sslmode=require" down 1
  ```
- **Manifests rollback**:
  ```bash
  kubectl delete -k deploy/k8s/data
  ```
