# GPU-01 Operations & Services

This directory contains configuration, setup scripts, and systemd units for services running on the `gpu-01` host (`100.88.247.70`).

## Architecture & Directory Structure

```text
deploy/gpu-01/
├── analytics/                      # ClickHouse & Analytics worker
│   ├── backup_clickhouse.sh        # Native ClickHouse backup + gzip + R2 upload + retention 3
│   ├── setup_clickhouse_backup.sh  # Interactive credential setup for winkey-backup
│   ├── winkey-clickhouse-backup.service
│   └── winkey-clickhouse-backup.timer
├── observability/                  # VictoriaMetrics, Grafana, Loki
│   └── provisioning/alerting/
│       └── alerting.yml            # Alert rules including Vault Sync Lag (>36h)
├── vault/                          # Interim Vault (INF-R2a Step 8)
│   ├── setup_vault.sh              # Configures rclone profile for user winkey
│   ├── sync_vault.sh               # Nightly sync R2 -> /mnt/hdd_storage/winkey/vault (14d retention)
│   ├── winkey-vault.service
│   └── winkey-vault.timer
└── setup_transcoder_r2.sh          # Transcoder R2 environment setup
```

---

## 1. ClickHouse Backups (Step 5)

ClickHouse runs in Docker with `Disk('backups')` mapped to `/srv/winkey-analytics/backup`. The backup script:
1. Executes `BACKUP DATABASE winkey TO Disk('backups', ...)` inside the ClickHouse container.
2. Compresses the backup directory to `.tar.gz`.
3. Uploads the archive to Cloudflare R2 (`winkey-backup/clickhouse/`) using `rclone`.
4. Enforces strict retention: keeps the **3 newest** backups in R2 and deletes older backups.
5. Cleans up temporary archives on NVMe.

### Setup & Usage:
```bash
# 1. Configure R2 credentials (prompts for Access Key ID and Secret Access Key):
bash deploy/gpu-01/analytics/setup_clickhouse_backup.sh

# 2. Test manual backup:
bash deploy/gpu-01/analytics/backup_clickhouse.sh

# 3. Enable daily systemd timer (runs at 03:00 UTC):
sudo cp deploy/gpu-01/analytics/winkey-clickhouse-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now winkey-clickhouse-backup.timer
```

---

## 2. Interim Vault (Step 8)

The interim vault protects Winkey against primary storage loss or R2 outage by maintaining an offline copy on HDD storage (`/mnt/hdd_storage/winkey/vault`):
- Runs as dedicated unprivileged user `winkey`.
- Uses a **read-only** R2 token scoped to `winkey-media`, `winkey-pg-backup`, and `winkey-backup`.
- Employs `rclone sync --backup-dir /mnt/hdd_storage/winkey/vault/archive/YYYYMMDD/<bucket>` for **14-day rolling retention**.
- Automatically cleans archive directories older than 14 days.
- Emits Prometheus node-exporter textfile metrics (`winkey_vault_last_success_timestamp_seconds` and `winkey_vault_sync_success`) to `/var/lib/prometheus/node-exporter/winkey_vault.prom`.
- Monitored by Grafana alert rule `Vault Sync Lag > 36h`.

### Setup & Installation:
```bash
# 1. Run interactive setup as user thanhluan (creates ~/.config/rclone/rclone.conf):
bash deploy/gpu-01/vault/setup_vault.sh

# 2. Complete systemd & permission setup with sudo:
sudo cp /tmp/rclone /usr/local/bin/rclone && sudo chmod 755 /usr/local/bin/rclone
sudo mkdir -p /home/winkey/.config/rclone
sudo cp ~/.config/rclone/rclone.conf /home/winkey/.config/rclone/rclone.conf
sudo chown -R winkey:winkey /home/winkey/.config
sudo chmod 600 /home/winkey/.config/rclone/rclone.conf

# Grant textfile metrics directory access to winkey group:
sudo chown root:winkey /var/lib/prometheus/node-exporter
sudo chmod 775 /var/lib/prometheus/node-exporter

# Install and start systemd timer (runs at 04:00 UTC):
sudo cp deploy/gpu-01/vault/winkey-vault.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now winkey-vault.timer

# Test immediate run:
sudo systemctl start winkey-vault.service
sudo journalctl -u winkey-vault.service -n 50 --no-pager
```
