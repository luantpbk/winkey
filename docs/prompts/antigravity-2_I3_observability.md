# Kickoff — Antigravity 2 · Task I3 (observability: metrics, logs, dashboards, alerts)

Design: ADR-029 in docs/DECISIONS.md. Read it fully first; the constraints in it (mounts, ports, budget) are hard.

````text
# ROLE
You are Antigravity 2, Platform/DevOps on Winkey (repo luantpbk/winkey). You own deploy/, .github/workflows/*
(except contracts.yml) and root tooling. Read AGENTS.md, ADR-022 (with its gpu-01 addendum), ADR-029, and
docs/INFRASTRUCTURE.md §0.1 and §4.2.

# PRECONDITIONS (the USER does these; check them, never use sudo on gpu-01)
- /srv/winkey-obs/{victoria,loki,grafana} exist on gpu-01 and are writable by the docker containers.
- Tailscale policy has `tag:edge → tag:gpu:8428,3100`.
- Secret for Grafana SMTP (Resend) and the alert recipient exist on gpu-01 as an env file outside git.
If one is missing, stop and tell the user exactly what to do.

# REPO
Worktree: git worktree add ../winkey-ag2-i3 -b agent/ag2/i3-observability origin/main
One PR for the gpu-01 side + edge-1 collection; dashboards and alerts may be a second PR (I3-b) if the first grows.

# TASK
1. gpu-01: deploy/gpu-01/observability/compose.yml — VictoriaMetrics (single, -retentionPeriod=30d, also scrapes
   gpu-01 itself: node-exporter, ClickHouse, analytics-worker, transcoder metrics ports), Loki single-binary
   (filesystem, 14d retention, compactor on), Grafana (provisioned datasources: VictoriaMetrics, Loki, ClickHouse via
   user `grafana_ro`). Images pinned by digest (from `docker buildx imagetools inspect`, never typed), host network,
   NO privileged, mounts ONLY /srv/winkey-obs/... and read-only config from the repo. Listen on 127.0.0.1 and the
   gpu-01 tailnet IP only. README with run/upgrade/backup steps and disk budget (≤ 20 GB total).
   ClickHouse `grafana_ro`: a users.d file in deploy/gpu-01/analytics with SELECT on winkey.video_qoe_hourly ONLY,
   password from the env file (not git), readonly profile.
2. edge-1 (k3s, namespace `observability`, kustomize under deploy/k8s/observability, added to the apps kustomization):
   vmagent (1 replica, -remoteWrite.url to gpu-01 tailnet :8428, -remoteWrite.tmpDataPath on a PVC capped at 2 GiB,
   scrape pods with prometheus.io/scrape + Traefik + CNPG + NATS exporter + node-exporter DaemonSet +
   kube-state-metrics), Grafana Alloy DaemonSet (pod logs → Loki on gpu-01 :3100, JSON parsed, labels: namespace,
   app, level; NEVER add user_id/email/token as labels). Every pod has requests/limits; namespace total requests
   ≤ 200m CPU / 512 MiB. Add `prometheus.io/scrape` annotations to the Winkey app pods if missing (you own deploy/).
   Verify /metrics of services is NOT reachable through Traefik from the internet.
3. Dashboards (JSON provisioned from deploy/gpu-01/observability/dashboards, no hand edits): Service overview, Pipeline,
   QoE (ClickHouse), Data & disks — panels as listed in ADR-029.
4. Alerts (Grafana alerting provisioned from files, email via Resend SMTP): exactly the list in ADR-029, each with a
   runbook line in the README (what it means, first command to run).

# DEFINITION OF DONE
- CI green (kustomize/kubeconform for the new k8s files; compose config validates).
- Evidence on the PR / #47: `docker compose ps` on gpu-01; vmagent `/targets` all up; a Grafana screenshot of each
  dashboard with real data; a test alert email received by the user (the user confirms); `kubectl top`/requests sum
  for the namespace; gpu-01 down 10 minutes → vmagent buffer grows then drains after it is back (graph or numbers).
- No secret, password or email address in git, logs, labels or PR text.

# OUT OF SCOPE
Tracing (OTel collector) — later; the external uptime check (the user registers it); LT2.
````
