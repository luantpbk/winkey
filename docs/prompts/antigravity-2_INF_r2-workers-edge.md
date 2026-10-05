# Brief — Antigravity 2 · INF-R2: R2 storage, home worker nodes, edge-1 to 2 OCPU / 12 GB (ADR-032)

````text
# ROLE
You are Antigravity 2 (platform/DevOps) on Winkey. Read AGENTS.md, ADR-004/005/014/015/017/029/032 and
docs/INFRASTRUCTURE.md §0, §4.2, §5 and §10 first. You own deploy/, workflows and root tooling.
Do the phases IN ORDER. After each phase: report on #47, then STOP and wait for the architect's go. Every production
change needs a dry run first (`--check --diff`), an announced window if legacy sites are at risk (ADR-014), and a
rollback.

# SECURITY (non-negotiable)
- No secret in chat, PR, issue or repo. The user creates Cloudflare tokens in the dashboard and stores them on the host
  with `read -s` into a k8s Secret / `chmod 600` env file. You only reference Secret names.
- One R2 token per consumer, scoped to its bucket(s), least privilege (read-only where possible).
- R2 buckets are never public; r2.dev stays disabled.
- Never touch the miner, ComfyUI, /opt/ffmpeg-7.1 or the system FFmpeg on gpu-01. No sudo on gpu-01 for agents.

# PHASE INF-0 — inventory + measurement (read-only, start now)
1. node-01 is POSTPONED by the user (it joins later); skip it.
2. edge-1: from VictoriaMetrics, 7-day peaks of host RAM and CPU and the top processes (legacy sites, Node apps, host
   PostgreSQL, Cockpit); `kubectl top pods -A` + current requests/limits of every Winkey pod; Garage bucket sizes and
   object counts. Paste a table: component → peak RAM / peak CPU / request / limit.

# PHASE INF-R2a — R2 becomes the object store (after the go)
1. With the user: Cloudflare account, R2 enabled, buckets winkey-raw, winkey-media, winkey-pg-backup, winkey-backup.
   Tokens (Object Read & Write unless noted):
   - upload-svc: winkey-raw
   - transcoder: winkey-raw (read), winkey-media
   - video-svc: winkey-media
   - CNPG: winkey-pg-backup
   - media-origin: winkey-media (read-only)
   - backup jobs: winkey-backup
   - vault: all buckets (read-only)
2. Bucket config:
   - CORS on winkey-raw: PUT from https://winkey.vn, expose ETag.
   - Lifecycle rules (ADR-032 §1): raw 30 d, abort multipart after 7 d, backup 15 d.
3. `media-origin`: a Deployment of `rclone serve http` (read-only, multi-arch image, resources ≤ 50m / 128 Mi), behind
   Traefik with the Host that nginx proxies to today. nginx config (auth_request, secure_link, proxy_cache) stays as is.
4. Migration window (announce it):
   1. Pause uploads.
   2. `rclone copy` Garage → R2 with the same keys; compare object counts and checksums.
   3. Switch env: S3_ENDPOINT / S3_PUBLIC_ENDPOINT / S3_REGION=auto for upload-svc, video-svc and the transcoder
      (gpu-01 env file).
   4. Switch CNPG barman to winkey-pg-backup on R2.
   5. Smoke test: upload → READY → play a public, an unlisted and a private video; delete a test video and verify the
      janitor removed its R2 prefix.
   6. Resume uploads.
5. Daily etcd snapshot and ClickHouse backup to winkey-backup.
6. **PostgreSQL restore drill from R2** (to a scratch instance) and paste the result. Only then remove Garage:
   keep it read-only for 7 days, then uninstall; remove the Tailscale rule tag:gpu → tag:edge:30900.
7. After Garage is uninstalled: move edge-1's nginx `proxy_cache` from `/` (10 GB) to the freed LV data, about
   40 GB, with `proxy_cache_lock on` and `inactive=30d` (ADR-032 addendum).

8. Interim vault on gpu-01 (until a home node joins):
   - a systemd timer running as user `winkey` (the user installs the unit with sudo, as for the transcoder; agents
     never use sudo) runs nightly `rclone sync` with the read-only vault token, R2 →
     /mnt/hdd_storage/winkey/vault/{winkey-media,winkey-pg-backup,winkey-backup};
   - 14-day retention via rclone --backup-dir dated folders;
   - alert when the last success is > 36 h old;
   - first restore drill from this copy.

# PHASE INF-R2b — cost guard
- Exporter `r2-usage`: Cloudflare GraphQL Analytics, token "Account Analytics: Read", every 15 min.
- Metrics: storage bytes, Class A and Class B month-to-date per bucket, projected month-end cost.
- Grafana alerts: projected cost > 5 USD warning, > 10 USD critical; any free-tier quota > 85 %.
- Enable Cloudflare billing notifications.

# PHASE INF-W1 — node-01 as vault + probe (POSTPONED until the user adds node-01; then retire the gpu-01 interim vault)
- Ansible group `worker`, host_vars `winkey_roles: [vault, probe]`, a role per capability. Adding node-02 later must be
  one inventory line.
- node-exporter + Alloy pushing to gpu-01 8428/3100.
- Tailscale policy: tag:worker in tagOwners; rules exactly as ADR-032 §5, plus `tests` entries.
- vault:
  - nightly `rclone sync` of the R2 buckets (read-only token) to a dedicated disk path;
  - rsync of gpu-01's raw archive over SSH as user `winkey-vault` (no shell);
  - 14-day retention; monthly PostgreSQL restore drill from the vault copy;
  - alert when the last successful sync is > 36 h old.
- probe: blackbox exporter for https://winkey.vn/healthz and one media URL.

# PHASE INF-W2 — home Garage cluster (only when ≥ 3 tag:worker nodes with disks exist; wait for the go)
- Each house is a zone: RF 2, consistency_mode consistent. S3 and RPC open on the tailnet only
  (tag:worker → tag:worker:3900,3901). Admin token and RPC secret stay on the hosts (`read -s`).
- Role `garage_vault` replaces the rclone directories: nightly R2 → home-Garage sync, 14-day retention, monthly
  restore drill. Never on the user path.
- New edges (edge-2/3) reuse the same nginx role with about 100 GB of `proxy_cache` each; no Garage on edges.

# PHASE INF-E1 — edge-1 to 2 OCPU / 12 GB
- From the INF-0 numbers, propose new requests/limits for every Winkey pod (target total requests ≤ 1 vCPU / 5 GB, host
  ≥ 1.5 GB free at peak). Tune CNPG shared_buffers, JetStream limits and Valkey maxmemory. Get the architect's OK.
- Announced window: OCI Console → Stop → Edit shape 2 OCPU / 12 GB → Start.
- Smoke-test the 4 legacy sites and Winkey (web, upload → READY, playback).
- Rollback: resize back to 4 / 24.

# OUT OF SCOPE
CDN/Workers in front of media, cpu-transcode workers (V6), self-hosted CI runners, any contract or code change.
If a service needs a code change for R2, stop and open an issue for the owner.
````
