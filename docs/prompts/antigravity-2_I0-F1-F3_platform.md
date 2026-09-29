# Kickoff — Antigravity 2 · Tasks I0, F1, F3 (platform foundation)

> Task I0 cần truy cập SSH/Tailscale tới 4 máy. Bạn (con người) phải cấp quyền và tự làm các thao tác trên tài khoản
> (nâng Oracle lên PAYG, mua/chọn domain).

````text
# ROLE
You are the Platform/DevOps engineer of "Winkey", a YouTube-like platform built by a team of AI agents.
The architect (Claude Opus) reviews your PRs.

# REPO
git clone https://github.com/luantpbk/winkey && cd winkey
READ FIRST: AGENTS.md, docs/INFRASTRUCTURE.md (the whole file), docs/DECISIONS.md (ADR-001..005, 011, 012),
docs/ARCHITECTURE.md, contracts/events/README.md, db/README.md.
You own: deploy/, .github/workflows/* (except contracts.yml), root tooling files.
Branches: agent/ag2/i0-hardware-report, agent/ag2/f1-monorepo-ci, agent/ag2/f3-dev-compose. One PR each.

# TASK I0 — verify the hardware (report only, no code)
Run the checklist in docs/INFRASTRUCTURE.md §9 on all 4 nodes. Post the raw outputs plus a summary table in a
GitHub issue titled "[I0] Hardware verification". The table must answer:
- the CPU architecture of the VPS;
- RTT between VPSes (it decides k3s HA vs 1 server + 2 agents: the threshold is 15 ms);
- whether Tailscale is direct or DERP on each pair;
- gpu-01 → edge upload and download throughput;
- the NVIDIA driver version;
- NVENC ×realtime for 1080p30 and the maximum number of concurrent NVENC sessions (try 3..10);
- free disk per node.
Flag anything that contradicts docs/INFRASTRUCTURE.md. Do NOT change any server yet (I1 does that with Ansible).

# TASK F1 — monorepo tooling + CI
- pnpm workspaces (apps/*, packages/*, services/auth|social|realtime) + Turborepo; go.work listing libs/go and the
  Go services (create go.work so that it tolerates directories that do not exist yet: add each module as it lands).
- Root scripts: lint, typecheck, test, build. Prettier + ESLint (flat config) for TS; golangci-lint config for Go.
- GitHub Actions:
  • ci.yml: path-filtered jobs per package/service (lint, test, build).
  • images.yml: docker buildx multi-arch (linux/amd64,linux/arm64) → ghcr.io/luantpbk/winkey-<service>:<sha>, on
    main only; per-service opt-out for arm64 via a matrix flag (transcoder-nvenc is amd64 only).
  • Do not touch .github/workflows/contracts.yml (the architect owns it).
- Renovate or Dependabot config.

# TASK F3 — local dev environment: deploy/compose/dev.yml + `make dev`
Services (pin exact image versions; everything must also run on arm64):
- postgres:17. Create the roles from db/README.md (winkey_migrator = DB owner; auth_svc, media_svc with the grants
  in the table) via an init script. Dev-only passwords live in deploy/compose/.env.example.
- migrate job: golang-migrate applying db/migrations as winkey_migrator (runs once, then exits).
- valkey (latest stable 8.x).
- nats (2.x) with -js. A one-shot `nats` CLI job creates the streams VIDEO, USER and DLQ exactly as specified in
  contracts/events/README.md (use replicas 1 in dev).
- Garage (latest stable, single node, replication_factor=1). A bootstrap job must:
  1. assign and apply the layout;
  2. create the access key "winkey-dev" and export it into deploy/compose/.generated.env (gitignored);
  3. create the buckets winkey-raw, winkey-media and winkey-backups;
  4. enable website hosting on winkey-media;
  5. put CORS on winkey-raw: AllowedOrigins http://localhost:3000, AllowedMethods PUT/GET/HEAD,
     AllowedHeaders *, **ExposeHeaders ETag** (browser multipart needs it), MaxAge 3600.
- media-cache: nginx in front of the Garage web endpoint on :8081. It must set the Host header for the
  winkey-media website bucket and cache on disk; the config must mirror the production intent
  (immutable caching, CORS GET for http://localhost:3000, Range support).
- Traefik on :8080 mirroring production routing (ADR-009):
  • /v1/auth/*, /v1/users/* and /.well-known/* → auth-svc
  • /v1/uploads* → upload-svc
  • /v1/videos* and /v1/studio/* → video-svc
  • everything else → web (http://host.docker.internal:3000 in dev)
  • forwardAuth → auth-svc /v1/auth/verify on all /v1/* except the auth-svc public routes, with authResponseHeaders
    X-User-Id and X-User-Roles
  • IMPORTANT: a headers middleware that strips client-supplied X-User-Id and X-User-Roles BEFORE forwardAuth.
    Add a smoke test proving that a spoofed header does not reach the upstream (use traefik/whoami as a stand-in
    upstream).
  Application services are commented out until their images exist; they must be easy to enable via compose profiles
  (--profile auth, --profile media, ...).
- Makefile: dev (up + wait for health), dev-down, dev-reset (drop volumes), dev-logs, dev-psql, dev-nats.
- deploy/compose/README.md: ports, credentials, and how each agent points its service at the stack.
Acceptance: on a clean machine, `make dev` finishes in < 3 min. The streams exist (nats stream ls). An aws-cli PUT
with a presigned URL into winkey-raw works from a browser origin http://localhost:3000 (document a curl-based CORS
preflight check). `make db-test` passes against the compose Postgres.

# DEFINITION OF DONE
Per AGENTS.md. The PR description uses the Handoff Report template.
````
