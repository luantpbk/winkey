# Winkey Player Analytics on gpu-01 (ClickHouse + analytics-worker)

This directory contains the Docker Compose stack and configuration for Winkey's player analytics infrastructure on `gpu-01` (ADR-022, Task R1-infra).

---

## 1. Overview & Architecture

- **ClickHouse**: Single-node ClickHouse server (pinned LTS 25.8 digest) running on `gpu-01` using `/srv/winkey-analytics/clickhouse`.
  - Memory bounds: `max_server_memory_usage` 12 GB, container `mem_limit` 14 GB, CPU limit 8 cores (coexists safely with miner and ComfyUI without resource starvation).
  - Network isolation: With Docker daemon `iptables: false`, the container runs with `network_mode: host` and `config.d/listen.xml` restricts listeners strictly to loopback (`127.0.0.1` and `::1` only) on ports `8123` (HTTP) and `9000` (Native TCP). Interserver port 9009 is disabled (`interserver_http_port` 0). Unreachable from LAN or Tailscale.
  - User model: Application user `winkey` with password configured via `.env` (outside git). The `default` user has network access disabled.
  - Disk guard: `config.d/storage.xml` sets `keep_free_space_bytes` to 20 GiB (`21474836480`), ensuring ClickHouse halts insertions before disk space shared with ComfyUI is exhausted.
- **analytics-worker**: Go service (`services/analytics`, owner: Sonnet) consuming telemetry events from NATS JetStream on `edge-1` via Tailscale NodePort (`100.113.240.3:30422`).
  - Durable consumer: `analytics-clickhouse` on stream `ANALYTICS`.
  - Batching: up to 5,000 messages or 2 s; single batch `INSERT` into ClickHouse with deduplication token.
  - Schema migrations: mounts `db/clickhouse` read-only at `/migrations` and applies pending migrations at boot.
  - Telemetry: exposes `/healthz`, `/readyz`, and Prometheus `/metrics` on port 8004.

---

## 2. Host State & Security Architecture

### Storage & Docker Setup (Done by Project Owner)
- `/srv/winkey-analytics` is a bind mount of `/mnt/nvme_models/winkey-analytics` (Kingmax NVMe, **shared with ComfyUI models and transcoder scratch**, 127 GB free at setup), owned by `thanhluan:thanhluan`, in `/etc/fstab` with `nofail`.
- Docker 29.1.3 + Compose 2.40 (Ubuntu packages) installed; `thanhluan` is in the `docker` group.
- `/etc/docker/daemon.json`: `"iptables": false, "ip6tables": false`, `"data-root": "/srv/winkey-analytics/docker"`, `json-file` logs 50m×3; `docker.service` configured with `RequiresMountsFor=/srv/winkey-analytics`.
- **Never touch `/srv/winkey-analytics/docker` or `/etc/docker/daemon.json`**.

### Security Model (Docker Group = Root-Equivalent)
- **No `sudo`**: All operations on `gpu-01` are run under the unprivileged user `thanhluan` who is in the `docker` group.
- **No `privileged`**: Neither container runs with `privileged: true`.
- **Mount restrictions**: Only `/srv/winkey-analytics/{clickhouse,backup}` and repository `db/clickhouse` (mounted `:ro`) are mounted into containers.
- **Network mode**: With `iptables` disabled, bridge networks do not have NAT or firewalling. Thus, all containers use `network_mode: host` and server daemons (ClickHouse) bind strictly to loopback (`127.0.0.1` and `::1`).

---

## 3. Installation & First Boot

### Step 1: Pre-flight Port Check
Verify that target ports (`8123`, `9000`, `9009`, `8004`) are free before starting:
```bash
ss -ltnp | grep -E ':(8123|9000|9009|8004)'
# Expected: no output
```

### Step 2: Configure Environment
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
sudo kubectl get secret nats-auth -n default -o jsonpath='{.data.analytics_password}' | base64 -d
```
Set `NATS_ANALYTICS_PASSWORD` in `.env`.

### Step 3: Start the Stack
```bash
docker compose up -d
```

### Step 4: Verify Health
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
5. Verify disk guard configuration:
   ```bash
   curl -s -u "winkey:<CLICKHOUSE_PASSWORD>" "http://127.0.0.1:8123/?query=SELECT+name,path,keep_free_space+FROM+system.disks"
   # Expected: default /var/lib/clickhouse/ 21474836480
   ```

---

## 4. Upgrades & Rollbacks

### Image Upgrades
1. Update image digest in `compose.yml` (pinned sha256 from CI image build; never use `:latest`).
2. Pull new image:
   ```bash
   docker compose pull
   ```
3. Re-create containers:
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

ClickHouse tables (`playback_events`, `video_qoe_hourly`) include automatic TTLs (90 days for raw playback events, 2 years for hourly aggregates per ADR-022).

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

### Disk Monitoring & I3 Alerting
Because the NVMe disk is shared with ComfyUI models, monitor disk utilization:
```bash
df -h /srv/winkey-analytics
```

1. **ClickHouse Disk Guard**: `<keep_free_space_bytes>21474836480</keep_free_space_bytes>` reserves 20 GiB. If disk space drops below 20 GiB, ClickHouse rejects writes rather than risking ComfyUI corruption.
2. **Observability Alert (Task I3)**:
   In VictoriaMetrics/Prometheus alert rules (task I3):
   - **Warning Alert**: Free disk on `/srv/winkey-analytics` < 20 GB:
     ```yaml
     alert: AnalyticsDiskLowWarning
     expr: node_filesystem_avail_bytes{mountpoint="/srv/winkey-analytics"} < 20 * 1024 * 1024 * 1024
     for: 5m
     labels:
       severity: warning
     annotations:
       summary: "Shared NVMe on gpu-01 has less than 20 GB free space"
     ```
   - **Critical Alert**: Free disk < 10 GB:
     ```yaml
     alert: AnalyticsDiskLowCritical
     expr: node_filesystem_avail_bytes{mountpoint="/srv/winkey-analytics"} < 10 * 1024 * 1024 * 1024
     for: 2m
     labels:
       severity: critical
     annotations:
       summary: "Shared NVMe on gpu-01 has less than 10 GB free space"
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
  nc -zv 100.88.247.70 9000
  nc -zv 100.88.247.70 8123
  # Expected: Connection refused or timeout (MUST NOT CONNECT)
  ```
- **Local Listener Check**: On `gpu-01`, verify listeners are bound only to `127.0.0.1` and `::1`:
  ```bash
  ss -ltnp | grep -E ':(8123|9000)'
  # Expected: 127.0.0.1 and [::1] only, never 0.0.0.0 or [::]
  ```
