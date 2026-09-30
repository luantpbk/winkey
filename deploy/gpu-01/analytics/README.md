# Winkey Player Analytics on gpu-01 (ClickHouse + analytics-worker)

This directory contains the Docker Compose stack and configuration for Winkey's player analytics infrastructure on `gpu-01` (ADR-022, Task R1-infra).

---

## 1. Overview & Architecture

- **ClickHouse**: Single-node ClickHouse server (pinned digest) running on `gpu-01` using the dedicated 512 GB NVMe mounted at `/srv/winkey-analytics`.
  - Memory bounds: `max_server_memory_usage` 12 GB, container `mem_limit` 14 GB, CPU limit 8 cores (coexists safely with miner and ComfyUI without resource starvation).
  - Network isolation: bound strictly to `127.0.0.1` (`8123` HTTP, `9000` Native TCP). Unreachable from LAN or Tailscale.
  - User model: Application user `winkey` with password configured via `.env` (outside git). The `default` user has network access disabled.
- **analytics-worker**: Go service (`services/analytics`, owner: Sonnet) consuming telemetry events from NATS JetStream on `edge-1` via Tailscale NodePort (`100.113.240.3:30422`).
  - Durable consumer: `analytics-clickhouse` on stream `ANALYTICS`.
  - Batching: up to 5,000 messages or 2 s; single batch `INSERT` into ClickHouse with deduplication token.
  - Schema migrations: mounts `db/clickhouse` read-only at `/migrations` and applies pending migrations at boot.
  - Telemetry: exposes `/healthz`, `/readyz`, and Prometheus `/metrics` on port 8004.

---

## 2. Prerequisites (Host & Storage)

> [!IMPORTANT]
> **Prerequisite by Project Owner (requires sudo)**:
> 1. Dedicated 512 GB NVMe must be formatted (ext4 or xfs) and mounted at `/srv/winkey-analytics` in `/etc/fstab` with `nofail`.
> 2. Directory ownership set to the compose user:
>    ```bash
>    sudo chown -R thanhluan:winkey /srv/winkey-analytics
>    sudo chmod 750 /srv/winkey-analytics
>    mkdir -p /srv/winkey-analytics/clickhouse /srv/winkey-analytics/backup
>    ```
> 3. Verify with:
>    ```bash
>    df -h /srv/winkey-analytics
>    ```
> 4. Ensure Docker and Docker Compose v2 are installed and the runner user is in the `docker` group.

> [!CAUTION]
> **Rules for gpu-01**:
> - Never run commands with `sudo`.
> - Do not modify system packages, system FFmpeg, `/opt/ffmpeg-7.1`, SRBMiner, or ComfyUI.
> - All analytics state is strictly contained inside `/srv/winkey-analytics` and Docker containers.

---

## 3. Installation & First Boot

### Step 1: Configure Environment
Copy `.env.example` to `.env` and fill in secrets:
```bash
cd deploy/gpu-01/analytics
cp .env.example .env
```
Generate a strong password for ClickHouse:
```bash
openssl rand -hex 16
```
Set `CLICKHOUSE_PASSWORD` in `.env`.

Retrieve the NATS `analytics` user password from `edge-1`:
```bash
kubectl get secret nats-auth -n default -o jsonpath='{.data.analytics_password}' | base64 -d
```
Set `NATS_ANALYTICS_PASSWORD` in `.env`.

### Step 2: Start the Stack
```bash
docker compose up -d
```

### Step 3: Verify Health
1. Verify container status:
   ```bash
   docker compose ps
   ```
2. Verify ClickHouse HTTP ping:
   ```bash
   curl -si http://127.0.0.1:8123/ping
   # Expected: HTTP/1.1 200 OK, body: Ok.
   ```
3. Verify `default` user cannot login over network:
   ```bash
   curl -si "http://127.0.0.1:8123/?query=SELECT%201"
   # Expected: 403 Forbidden / Authentication failure
   ```
4. Verify `winkey` user can authenticate and query:
   ```bash
   curl -si -u "winkey:<CLICKHOUSE_PASSWORD>" "http://127.0.0.1:8123/?query=SELECT%20version()"
   ```
5. Check worker logs and migration status:
   ```bash
   docker compose logs -f analytics-worker
   ```
   Verify applied migrations:
   ```bash
   curl -s -u "winkey:<CLICKHOUSE_PASSWORD>" "http://127.0.0.1:8123/?query=SELECT+name,applied_at+FROM+winkey.schema_migrations+FORMAT+Pretty"
   ```

---

## 4. Upgrades & Rollbacks

### Image Upgrades
1. Update image digest or tag in `compose.yml` (e.g. pinned sha256 from CI build).
2. Pull new image:
   ```bash
   docker compose pull
   ```
3. Re-create containers with zero downtime / fast switchover:
   ```bash
   docker compose up -d
   ```
4. Confirm health:
   ```bash
   docker compose ps
   docker compose logs --tail=50 analytics-worker
   ```

### Rollback
1. Revert image digest in `compose.yml` to the previous known good digest.
2. Run:
   ```bash
   docker compose up -d
   ```

---

## 5. Backup & Retention Runbook

ClickHouse tables (`playback_events`, `video_qoe_hourly`) include automatic TTLs (90 days for raw playback events, 2 years for hourly aggregates).

### On-Demand / Scheduled Native Backup
To take a full backup of database `winkey` directly to the NVMe backup partition (`/srv/winkey-analytics/backup`):

```bash
BACKUP_ID="backup_$(date +%Y%m%d_%H%M%S)"
curl -s -u "winkey:<CLICKHOUSE_PASSWORD>" "http://127.0.0.1:8123/" \
  --data-binary "BACKUP DATABASE winkey TO Disk('backups', '${BACKUP_ID}')"
```

To configure ClickHouse disk for backups, add `config.d/backup_disk.xml`:
```xml
<clickhouse>
    <storage_configuration>
        <disks>
            <backups>
                <type>local</type>
                <path>/var/lib/clickhouse/backup/</path>
            </backups>
        </disks>
    </storage_configuration>
</clickhouse>
```

Alternatively, backup tables using SQL export:
```bash
BACKUP_DIR="/srv/winkey-analytics/backup/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"
docker exec winkey-analytics-clickhouse clickhouse-client -u winkey --password "$CLICKHOUSE_PASSWORD" \
  --query "BACKUP DATABASE winkey TO File('${BACKUP_DIR}/winkey.backup')"
```

---

## 6. Lag Inspection & Disk Monitoring

### Monitoring Consumer Lag
To verify that `analytics-worker` is processing events from JetStream in real-time:
```bash
# Check lag via NATS CLI
nats consumer info ANALYTICS analytics-clickhouse --server="nats://analytics:${NATS_ANALYTICS_PASSWORD}@100.113.240.3:30422"
```
Key fields to observe:
- `Unprocessed Messages`: should remain near 0 under normal operation.
- `Outstanding Acks`: bounded by batch size (≤ 5,000).

Or check the Prometheus metric exposed by `analytics-worker`:
```bash
curl -s http://127.0.0.1:8004/metrics | grep analytics_consumer_pending
```

### Monitoring Storage & Partitions
Check host NVMe space:
```bash
df -h /srv/winkey-analytics
```

Check table sizes and partition health inside ClickHouse:
```bash
curl -s -u "winkey:<CLICKHOUSE_PASSWORD>" "http://127.0.0.1:8123/" \
  --data-binary "SELECT table, count() as parts, formatReadableSize(sum(data_compressed_bytes)) as compressed, formatReadableSize(sum(data_uncompressed_bytes)) as uncompressed FROM system.parts WHERE database='winkey' AND active GROUP BY table"
```

---

## 7. Network Security & Tailscale Verification

- **Tailscale ACL**: gpu-01 is authorized to connect to edge-1 NodePort `30422` (asserted in `INFRASTRUCTURE.md §4.2`).
- **Isolation Test**: From `edge-1` (or any other tailnet host), verify ClickHouse ports are NOT reachable:
  ```bash
  nc -zv gpu-01 9000
  nc -zv gpu-01 8123
  # Expected: Connection refused or timeout (MUST NOT CONNECT)
  ```
