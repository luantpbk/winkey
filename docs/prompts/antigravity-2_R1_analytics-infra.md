# Kickoff — Antigravity 2 · Task R1-infra (analytics plumbing: stream, route, CI, ClickHouse + worker on gpu-01)

Design: ADR-022. Runs in parallel with Sonnet's R1 (video-svc endpoint + `services/analytics` worker). Queue order
for Antigravity 2: I2 cleanup → dev Traefik routes (#103, #112) → **R1-infra**.

**Prerequisite done by the project owner (not by an agent, it needs sudo on gpu-01):** the free 512 GB NVMe is
formatted (ext4 or xfs), mounted at `/srv/winkey-analytics` via /etc/fstab (with `nofail`), and owned by the agents'
user on gpu-01 (the user that runs the compose stack, in the `docker` group). Check with `df -h /srv/winkey-analytics`
before starting; if it is not there, stop and ask in the PR.

````text
# ROLE
You are the platform/DevOps engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag2-r1 -b agent/ag2/r1-analytics-infra origin/main
READ FIRST: docs/DECISIONS.md ADR-022 + ADR-015, contracts/events/README.md (stream table: ANALYTICS; consumer
analytics-worker), docs/INFRASTRUCTURE.md (gpu-01 section; the "do not touch the miner / ComfyUI / system FFmpeg"
rules), db/clickhouse/ (schema, mounted into the worker as /migrations).
You own: deploy/, .github/workflows (except contracts.yml), go.work, root tooling.

# TASK R1-infra
1. NATS (IaC where the other streams are defined): stream ANALYTICS — subjects analytics.>, file, replicas 1,
   max_age 7d, max_bytes 5 GiB, discard old, duplicate_window 2m. NATS users: video-svc may publish analytics.>;
   a new user `analytics` (secret generated like the others, never in git) may consume ANALYTICS with durable
   analytics-clickhouse and nothing else.
2. Gateway: route /v1/playback → video-svc in deploy/compose/traefik/dynamic.yml AND the k8s IngressRoute (same
   middlewares as the other /v1 video routes: strip identity headers + forwardAuth optional-auth + rate limit).
3. Monorepo plumbing for the new Go module services/analytics: go.work `use`, the CI go matrix, the images workflow
   (multi-arch linux/amd64,linux/arm64, image `analytics-worker`), dependabot entry. `db/clickhouse` changes must
   trigger the analytics job.
4. gpu-01 deployment in deploy/gpu-01/analytics/ (new): compose file with
   - clickhouse/clickhouse-server pinned by digest; data volume /srv/winkey-analytics/clickhouse; ports bound to
     127.0.0.1 only (8123, 9000); config.d/users.d mounted: max_server_memory_usage 12 GB, container mem_limit
     14g, cpus 8, a `winkey` user with a generated password (file outside git), default user disabled for network;
   - analytics-worker (image from step 3, pinned) with NATS URL = edge-1 tailnet NodePort 30422 (same way the
     transcoder reaches NATS), the `analytics` NATS creds, CLICKHOUSE_DSN to 127.0.0.1:9000, db/clickhouse mounted
     read-only at /migrations; restart unless-stopped; logs to journald or json-file with rotation.
   - a README: install/upgrade/rollback commands, backup (clickhouse-backup or `BACKUP DATABASE winkey TO
     Disk(...)` weekly to /srv/winkey-analytics/backup), how to check lag (consumer pending) and disk use.
   Tailscale ACL: no change needed (gpu-01 → edge-1:30422 already allowed); confirm it in the PR.
5. Nothing on gpu-01 outside Docker + /srv/winkey-analytics: no sudo, no system packages, no change to the miner,
   ComfyUI, /opt/ffmpeg-7.1 or the system FFmpeg.

# DEFINITION OF DONE
- CI green (k8s kubeconform, the new go job, images). Real output pasted: `nats stream info ANALYTICS`, `docker
  compose ps` on gpu-01, `SELECT count() FROM winkey.playback_events` after publishing 100 test events with
  `nats pub` (or after Sonnet's endpoint is live), `curl https://winkey.vn/v1/playback/heartbeats` → 400 (routed,
  not 404), ClickHouse ports NOT reachable from another tailnet host (`nc -zv gpu-01 9000` from edge-1 fails).
- Handoff Report.
````
