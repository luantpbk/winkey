# INF-R2 Runbook: Cloudflare R2 Storage Migration

This directory contains reusable tools and runbooks for the Cloudflare R2 object storage migration (ADR-032 / Task INF-R2a).

## Tools

### 1. `r2_migration_job.yaml`
A Kubernetes Job that migrates data from Garage S3 to Cloudflare R2 using `rclone`:
- Uses the `rclone/rclone:1.69.1` image.
- Syncs buckets:
  - `winkey-raw` (upload storage)
  - `winkey-media` (transcoded HLS streams, thumbnails, storyboards)
  - `winkey-pg-backup` (PostgreSQL Barman backup & WAL archive)
- Performs `rclone copy` followed by `rclone check --one-way` to ensure checksum integrity before switching services.

**Usage:**
```bash
kubectl apply -f deploy/runbooks/inf-r2/r2_migration_job.yaml
kubectl logs -f job/r2-data-migration
```

### 2. `check_headers.sh`
A verification script to validate response headers (Content-Type, Cache-Control, CORS, Accept-Ranges, etc.) for video media files served through Nginx front and `media-origin` Traefik ingress.

**Usage:**
```bash
# Test against edge-1 NodePort or public media domain:
bash deploy/runbooks/inf-r2/check_headers.sh http://100.113.240.3:30080 winkey-media.winkey.vn
```

### 3. `smoke_test_r2.py`
A comprehensive, non-interactive or interactive Python smoke test that verifies end-to-end media lifecycle with Cloudflare R2:
1. Authenticates against Winkey API (`/v1/auth/login`).
2. Initiates video upload session (`/v1/uploads`).
3. Requests presigned upload URL (`/v1/uploads/{id}/parts`) and verifies it targets Cloudflare R2.
4. Uploads video binary data directly to R2.
5. Completes multipart upload (`/v1/uploads/{id}/complete`).
6. Polls video transcoding progress until status becomes `READY`.
7. Asserts `PUBLIC` video playback via HLS master playlist and verifies headers (`Cache-Control`, `Content-Type`).
8. Asserts `UNLISTED` video accessibility.
9. Changes visibility to `PRIVATE`, verifies plain URL returns HTTP 403, and fetches / plays signed URL (`/s/...`).
10. Deletes the test video (`DELETE /v1/videos/{id}`) and validates access revocation.

**Prerequisites:**
- Python 3.9+
- Verified TLS environment (uses system trust store, no unverified context)
- Test credentials set in environment:

```bash
read -r -p "Smoke Test Email: " WINKEY_SMOKE_EMAIL
read -rs -p "Smoke Test Password: " WINKEY_SMOKE_PASSWORD
export WINKEY_SMOKE_EMAIL WINKEY_SMOKE_PASSWORD

python3 deploy/runbooks/inf-r2/smoke_test_r2.py
```

### 4. `setup_backup_secrets.sh` (Step 5)
Interactive helper script for configuring Cloudflare R2 backup secrets for `winkey-backup`:
- Prompts for Cloudflare Account ID, Access Key ID, and Secret Access Key (masked with `read -rsp`).
- Writes secrets into temporary files in `/dev/shm` (`umask 077`) to prevent memory/disk leakage.
- Applies Kubernetes secret `r2-backup-jobs` in namespace `default` (for cron jobs and tooling).
- Applies Kubernetes secret `k3s-etcd-s3` in namespace `kube-system` (for k3s etcd snapshot integration).
- Writes host file `/etc/rancher/k3s/etcd-s3.env` (`chmod 600`).

**Usage:**
```bash
bash deploy/runbooks/inf-r2/setup_backup_secrets.sh
```

### 5. `etcd_snapshot.sh` (Step 5)
Automated script for taking compressed k3s etcd snapshots directly to Cloudflare R2:
- Utilizes `k3s etcd-snapshot save` with `--snapshot-compress` (saving ~66% space).
- Uploads to `s3://winkey-backup/etcd`.
- Enforces `--s3-retention 7` (maintains exactly the 7 most recent snapshots).
- Accompanied by systemd units `winkey-etcd-snapshot.service` and `winkey-etcd-snapshot.timer` running daily at 02:00 UTC.

**Usage:**
```bash
# Manual run:
bash deploy/runbooks/inf-r2/etcd_snapshot.sh

# Systemd timer installation:
sudo cp deploy/runbooks/inf-r2/winkey-etcd-snapshot.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now winkey-etcd-snapshot.timer
```

### 6. `postgres_restore_drill.sh` & `postgres_restore_drill.yaml` (Step 6)
Point-In-Time Recovery (PITR) drill script for validating CloudNativePG backups on Cloudflare R2:
- Initiates an on-demand base backup of live PostgreSQL (`winkey-pg`) to `winkey-pg-backup`.
- Records live table row counts (`media.videos`, `auth.users`).
- Deploys an isolated scratch cluster `winkey-pg-scratch` bootstrapped from the R2 Barman backup store.
- Waits for restore completion, replays WALs, and verifies 100% data and row count parity.
- Records total recovery duration.
- Cleans up the scratch instance and its persistent volume.

**Usage:**
```bash
bash deploy/runbooks/inf-r2/postgres_restore_drill.sh
```

