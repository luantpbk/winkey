# Kickoff — Antigravity 3 · Task C2 (realtime-gw)

````text
# ROLE
You are a Backend Engineer (Node.js/TypeScript) on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-c2 -b agent/ag3/c2-realtime origin/main
READ FIRST: AGENTS.md, docs/DECISIONS.md (ADR-008, ADR-009), contracts/realtime/README.md,
contracts/realtime/client.schema.json + server.schema.json + examples/, contracts/openapi/realtime.v1.yaml,
contracts/events/README.md + video.progress/ready/failed + social.comment.created + social.video.like_changed.
Reuse the patterns of services/auth and services/social (Fastify, zod env, pino, Valkey, vitest + testcontainers,
Dockerfile built from the repo root with pnpm deploy).
You own: services/realtime/. Package name: @winkey/realtime. Branch: agent/ag3/c2-realtime.

# TASK C2 — services/realtime (implement contracts/realtime + realtime.v1.yaml exactly)
- POST /v1/realtime/ticket: identity from X-User-Id / X-User-Roles only (401 without). 256-bit random ticket,
  Valkey key rt:ticket:{sha256(ticket)} → {user_id, roles}, TTL 30 s, redeemed with GETDEL (single use).
  Rate limit 30/min per user (same limiter as auth/social). Cache-Control: no-store. Never log tickets.
- GET /v1/realtime WebSocket (use `ws` with Fastify's upgrade, or @fastify/websocket): redeem the ticket
  BEFORE the upgrade (invalid/used/expired → 401, no upgrade); no ticket → anonymous. Ignore X-User-Id here.
  Send `welcome` first. Validate every client frame with ajv against client.schema.json.
- Rooms and authorization exactly as in the README:
  • video:{id}: call video-svc GET /v1/videos/{id} internally (VIDEO_SVC_URL) forwarding the connection's
    X-User-Id / X-User-Roles; 200 → allowed; cache the decision ≤ 60 s. Anonymous allowed.
  • upload:{id}: authenticated only (AUTH_REQUIRED otherwise); deliver an event only if owner_id == user_id
    or role moderator/admin.
  • user:{me}: joined automatically when authenticated.
  Limits: 50 rooms/connection, 5 connections/user (Valkey counter with TTL or per-pod map + Valkey),
  20 msgs/s per connection, 4 KiB frames, 256 queued outbound messages (drop oldest + metric).
- Sources: core NATS subscribe rt.video.*.progress (no queue group); JetStream ephemeral ORDERED consumers
  with deliver_policy new on VIDEO (video.ready, video.failed) and SOCIAL (social.comment.created,
  social.video.like_changed). Unknown event version → skip + warn. Map to server messages exactly as the
  README table says (comment events carry ids only, never the body).
- Heartbeat: ws ping every 25 s, close 4408 after 60 s without pong. Close codes and SIGTERM behaviour as in
  the README (close all with 1001 within 10 s).
- Health: /healthz; /readyz checks NATS (JetStream) and Valkey.
Env: NATS_URL, VALKEY_URL, VIDEO_SVC_URL, HTTP_PORT, TRUST_PROXY_CIDRS. Commit services/realtime/.env.example.

# DEFINITION OF DONE
- Tests with REAL NATS JetStream + Valkey via testcontainers (WINKEY_REQUIRE_DOCKER=1 must fail, not skip;
  hookTimeout 120 s), using a real WebSocket client against the running server:
  • ticket single use (second upgrade with the same ticket → 401), expiry, anonymous connect;
  • every server message the test receives validates against server.schema.json (ajv);
  • video:{id} allowed/forbidden via a stub video-svc (200 vs 404); upload:{id} never leaks another owner's
    progress; user:{me} receives video.ready/failed and comment.reply (not for self-replies);
  • two gateway instances in the same test both receive the same JetStream event (ephemeral consumers);
  • limits: 51st room → TOO_MANY_ROOMS, 6th connection → 4429, oversized/binary frame → BAD_MESSAGE;
  • heartbeat timeout closes with 4408 (use short intervals via env in tests).
- A contract test for realtime.v1.yaml (same approach as services/social).
- pnpm run format:check, lint:root, lint (0 warnings in src/), typecheck, test and build pass at the repo root.
- README in services/realtime: run, env table, test. Open the PR yourself; description = Handoff Report with
  the test output pasted.

# OUT OF SCOPE (other owners)
- Traefik route + WebSocket settings for /v1/realtime (Antigravity 2). Web client (Antigravity 1, U2).
- Any change to contracts/ (open a contract-change issue instead).
````
