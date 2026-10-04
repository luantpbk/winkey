# Winkey Observability Stack (gpu-01)

Centralized metrics (VictoriaMetrics), log aggregation (Loki), and visualization & alerting (Grafana) deployed on `gpu-01` per [ADR-029](../../../docs/DECISIONS.md#adr-029--observability-i3-đo-ở-edge-1-lưu-và-cảnh-báo-trên-gpu-01).

## Architecture & Storage Budget

- **VictoriaMetrics**: Single-node Prometheus-compatible TSDB with 30-day retention (`-retentionPeriod=30d`). Ingests edge-1 metrics via `vmagent` remote-write and scrapes `gpu-01` components directly.
- **Grafana Loki**: Single-binary log engine with filesystem storage, 14-day retention (`limits_config.retention_period: 14d`), and compactor enabled.
- **Grafana**: Provisioned datasources (VictoriaMetrics, Loki, ClickHouse via `grafana_ro`), provisioned dashboards (Service Overview, Pipeline, QoE, Data & Disks), and provisioned alerting with email delivery via Resend SMTP.
- **Node Exporter**: Host node metrics exporter installed via OS apt package (`prometheus-node-exporter`) bound to `127.0.0.1:9100` (no container with host mounts).
- **Target Storage Budget**: Total persistent volume on NVMe (`/srv/winkey-obs`) strictly capped at **≤ 20 GB** (VictoriaMetrics ~8 GB, Loki ~10 GB, Grafana ~1 GB).

## Network & Security
- `network_mode: host` with zero privileged containers.
- Ports bound strictly to localhost (`127.0.0.1`) and `gpu-01` Tailscale IP (`100.88.247.70`).
- No public ports opened; accessible only via Tailnet.
- Environment variables containing credentials reside in `/srv/winkey-obs/secrets/grafana.env` (never committed to git).

---

## How to Run & Operate

### Preconditions (Managed by Server Admin)
Ensure directories exist on `gpu-01` with proper permissions:
- `/srv/winkey-obs/victoria` (UID `0`)
- `/srv/winkey-obs/loki` (UID `10001`)
- `/srv/winkey-obs/grafana` (UID `472`)
- `/srv/winkey-obs/secrets/grafana.env` (mode `0600`, owned by non-root admin)

Install and run host node exporter via apt:
```bash
sudo apt-get install -y prometheus-node-exporter
echo 'ARGS="--web.listen-address=127.0.0.1:9100"' | sudo tee /etc/default/prometheus-node-exporter
sudo systemctl restart prometheus-node-exporter
sudo systemctl status prometheus-node-exporter
```

Configure ClickHouse Read-Only Credentials for Grafana in Analytics `.env`:
```bash
cd /home/thanhluan/winkey/deploy/gpu-01/analytics
grep '^CLICKHOUSE_GRAFANA_RO_PASSWORD=' /srv/winkey-obs/secrets/grafana.env >> .env
```

### Start Services
```bash
cd /home/thanhluan/winkey/deploy/gpu-01/observability
docker compose up -d
```

### Check Status & Logs
```bash
docker compose ps
docker compose logs -f victoriametrics
docker compose logs -f loki
docker compose logs -f grafana
```

### Upgrade Services
Update image digests in `compose.yml` (pinned via `docker buildx imagetools inspect`), then:
```bash
docker compose pull
docker compose up -d
```

### Backup & Disaster Recovery
- **Grafana database**:
  ```bash
  sqlite3 /srv/winkey-obs/grafana/grafana.db ".backup '/srv/winkey-obs/grafana_backup.db'"
  ```
- **VictoriaMetrics snapshot**:
  ```bash
  curl -s http://127.0.0.1:8428/snapshot/create
  ```
- All dashboards and alerts are provisioned from code; recreating the containers restored from git will re-provision them automatically.

---

## Alert Runbooks

Every alert provisioned in `provisioning/alerting/alerting.yml` has a documented meaning and first triage command:

| Alert Name | Meaning | Severity | First Triage Command |
|---|---|---|---|
| `Scrape Target Down (up == 0)` | A Prometheus/vmagent scrape target is unreachable for > 10m | Critical | Check target health on edge-1 (`curl http://127.0.0.1:8429/targets`) or gpu-01 (`curl http://127.0.0.1:8428/targets`), inspect corresponding pod or container. |
| `Service 5xx Error Rate > 2%` | App service is responding with 5xx HTTP errors (>2% over 5m) | Critical | Inspect Loki logs: `{app=~".+"} \|= "500"`, or on edge-1: `kubectl logs deploy/<service>` |
| `Service p95 Latency > 1s` | Requests take longer than 1 second at the 95th percentile | Warning | Check active DB backends: `kubectl exec winkey-pg-1 -c postgres -- psql -U postgres -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state != 'idle';"` |
| `Edge-1 Disk Space < 15%` | Free disk on edge-1 is critically low (<15%) | Critical | On edge-1: `df -h /`, prune images: `sudo crictl rmi --prune` and clear `/var/log/pods` if needed |
| `GPU-01 /srv Disk < 20 GB` | NVMe models/obs mount on gpu-01 has < 20 GB available | Critical | On gpu-01: `df -h /srv/winkey-obs`, check ClickHouse parts: `du -sh /srv/winkey-analytics/clickhouse/*` |
| `GPU-01 Root Disk < 5 GB` | Root `/` partition on gpu-01 has < 5 GB available (emergency) | Critical | On gpu-01: `df -h /`, clean docker caches: `docker system prune -f` and journal: `journalctl --vacuum-time=3d` |
| `Transcode Queue Pending > 10 for 30m` | Video jobs are backlogged in NATS JetStream without being processed | Warning | On gpu-01: `docker compose ps` and `docker logs --tail 100 winkey-transcoder` |
| `ANALYTICS Stream Size > 3 GiB` | NATS JetStream ANALYTICS stream storage exceeds 3 GiB | Warning | On gpu-01: `docker logs --tail 100 winkey-analytics-worker`. Check ClickHouse ingest lag. |
| `Analytics Rollup Lag > 2h` | Daily view / QoE aggregation job has not succeeded for > 2 hours | Warning | On gpu-01: `docker logs --tail 100 winkey-analytics-worker \| grep -i rollup`. Test PostgreSQL connectivity. |
| `Analytics Reco Lag > 2h` | Recommendation co-view aggregation has not succeeded for > 2 hours | Warning | On gpu-01: `docker logs --tail 100 winkey-analytics-worker \| grep -i reco`. Verify ClickHouse and Postgres connectivity. |
| `Vmagent Edge-1 Buffer > 1 GiB` | Remote-write persistent buffer on edge-1 is filling up (>1 GiB) | Warning | Check Tailscale tunnel from edge-1 to gpu-01: `tailscale ping 100.88.247.70` and check VictoriaMetrics on gpu-01 |
| `Auth Mail Dead Letters Increasing` | Password reset or verification emails failed all retry attempts | Warning | On edge-1: `kubectl logs deploy/auth-svc \| grep -i mail`. Verify Resend API token and SMTP quota. |
| `Hourly Rebuffer Ratio > 1%` | Video playback rebuffering ratio exceeds 1% P2 target (ClickHouse) | Warning | Open Grafana QoE dashboard; query ClickHouse: `SELECT video_id, sum(rebuffer_ms)/sum(watched_ms) FROM winkey.video_qoe_hourly GROUP BY video_id ORDER BY 2 DESC LIMIT 10;` |
