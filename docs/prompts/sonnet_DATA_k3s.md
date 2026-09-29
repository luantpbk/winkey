# Kickoff — Sonnet 5.5 · Task DATA (PostgreSQL, NATS, Valkey on k3s edge-1)

DATA was on Antigravity 2's queue. The architect moves it to Sonnet to run in parallel with EDGE/STO:
Sonnet owns **`deploy/k8s/data/`** for this task (new directory; the rest of `deploy/` stays Antigravity 2's).

````text
# ROLE
You are the Go/platform engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-data -b agent/sonnet/data-k3s origin/main
READ FIRST: docs/ARCHITECTURE.md, docs/DECISIONS.md (ADR-007, 008, 013, 014, 015), docs/INFRASTRUCTURE.md
(edge-1: arm64, 4 vCPU / 24 GB shared, Winkey requests ≤ 2 vCPU / 10 GB total; LV data 110 GB via local-path:
PostgreSQL 15 GB, NATS 5 GB), db/README.md (roles and grants), db/migrations, contracts/events/README.md
(streams and consumers), deploy/compose (the dev stack: same components), PR #39 deploy/k8s/edge (service names
and the NodePorts nats-nodeport 30422 / postgres-nodeport 30432 select app.kubernetes.io/name: nats|postgres in
namespace default, bound to the Tailscale IP only).
You own: deploy/k8s/data/ (and libs/go, services/* as usual). Branch: agent/sonnet/data-k3s.

# TASK DATA — deploy/k8s/data (kustomize), single node now, target shape kept (ADR-013)
All images multi-arch (arm64 required), pinned by version (digest if you can), resources requests/limits on every pod.

1. PostgreSQL 17 with CloudNativePG (pinned operator release manifest, vendored or fetched by version):
   - Cluster `winkey-pg`, instances: 1 (a kustomize patch shows 2 for later), storage 15Gi local-path,
     inheritedMetadata label app.kubernetes.io/name: postgres (so #39's NodePort selects it; with >1 instance the
     NodePort must select the primary: cnpg.io/instanceRole: primary — document it).
   - bootstrap initdb: database `winkey`, owner `winkey_owner` (runs migrations; NOT superuser).
   - managed roles auth_svc, media_svc, social_svc (passwordSecret references) and the grants of db/README.md
     applied by an idempotent SQL Job after migrations.
   - migrations Job: golang-migrate (pinned, arm64) running db/migrations (configMapGenerator from the repo
     files) as winkey_owner; safe to re-run.
   - backups: ScheduledBackup + barmanObjectStore to Garage bucket `winkey-pg-backup` written but DISABLED by
     default (overlay `backup/`), because Garage (STO) is not ready; document how to enable.
2. NATS 2.10+ with JetStream (StatefulSet or the official chart rendered and pinned), 1 replica, 5Gi file storage,
   max_payload default, service `nats` (client 4222, monitoring 8222), label app.kubernetes.io/name: nats.
   - Streams VIDEO, USER, SOCIAL, DLQ exactly as contracts/events/README.md (subjects, file storage, max age,
     duplicate window 2m, replicas 1, retention limits), created/updated by an idempotent Job (nats CLI
     `stream add --config` or `stream edit`), consumers are NOT created here (services create their own).
   - Auth: one user per service (auth, upload, video, transcoder, social, realtime) with publish/subscribe
     permissions scoped to their subjects (derive from the event catalog; `_INBOX.>` and `$JS.API.>` as needed).
     Passwords from Secrets. Document the matrix in the README.
3. Valkey 8 (StatefulSet, 1 replica, 1Gi), requirepass from a Secret, `maxmemory 512mb`,
   `maxmemory-policy volatile-lru` (IMPORTANT: video-svc's views:pending / views:flush:* hashes have no TTL and
   must never be evicted; rate-limit, ticket and cache keys all have TTLs), AOF everysec.
4. Secrets: never in git. A script `deploy/k8s/data/secrets.sh` generates random passwords and applies them with
   kubectl (idempotent: keeps existing ones), and prints the DSNs each service needs; `.env.example`-style doc of
   secret names and keys.
5. NetworkPolicies: only pods with app.kubernetes.io/part-of: winkey (and the migration/setup Jobs) reach
   postgres/nats/valkey; NodePort access is limited by #39's firewall/Tailscale binding (document the assumption).

# DEFINITION OF DONE
- `kubectl kustomize deploy/k8s/data` renders; `kubeconform -strict` (with CRD schemas for CNPG) passes.
- End-to-end on a local k3d/kind cluster (script `deploy/k8s/data/verify.sh`, paste its output in the PR):
  operator up, cluster ready, migrations applied (schema_migrations = latest), each role can do exactly what
  db/README.md says (SELECT on auth.public_profiles works for media_svc/social_svc; SELECT on auth.users is denied),
  `nats stream ls` shows the 4 streams with the contract settings, a publish/subscribe per service user
  succeeds on its subjects and is denied on another's, Valkey CONFIG GET maxmemory-policy = volatile-lru,
  re-running every Job is a no-op.
- Resource requests of the whole directory ≤ 1 vCPU / 4 GB (leave room for services + Garage).
- README in deploy/k8s/data: apply order, secrets, verify, enable backups, scale to 2 instances, rollback.
- The PR description is the Handoff Report. Applying on edge-1 is done afterwards by the user/Antigravity 2 with
  your runbook; do not touch edge-1 yourself.

# OUT OF SCOPE
- Garage/STO, Traefik/EDGE (#39), Helm charts for services (I2), CI workflow changes (ask Antigravity 2 to add a
  kubeconform job; you may add a Makefile-free script only).
````
