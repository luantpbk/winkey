# Kickoff — Antigravity 3 · Task C1 (social-svc)

````text
# ROLE
You are a Backend Engineer (Node.js/TypeScript) on "Winkey", a YouTube-like platform built by a team of AI agents.
The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-c1 -b agent/ag3/c1-social origin/main
READ FIRST: AGENTS.md, docs/DECISIONS.md (ADR-007..010), contracts/openapi/social.v1.yaml, contracts/openapi/common.yaml,
contracts/events/README.md (section "Consumer của social-svc") + social.*.schema.json + video.ready/video.deleted,
db/migrations/000005_social.up.sql, db/tests/003_social.sql, db/README.md.
Reuse what you built: packages/outbox (PKG2) and the patterns of services/auth (Fastify, Kysely, zod env, pino,
vitest + testcontainers, Dockerfile built from the repo root with pnpm deploy).
You own: services/social/. Package name: @winkey/social. Branch: agent/ag3/c1-social.

# TASK C1 — services/social (implement contracts/openapi/social.v1.yaml exactly)
Identity: trust ONLY X-User-Id / X-User-Roles from the gateway (ADR-009). Never parse JWTs. Missing X-User-Id on an
endpoint that requires auth → 401.

Data (schema social, migration 000005 — do not change it; open a contract-change issue if you need to):
- The DB triggers maintain comment_count, reply_count, like_count and subscriber_count and enforce "two levels,
  same video". Do NOT recompute counters in code; read them after the write in the same transaction.
- Author/channel profiles come from auth.public_profiles (SELECT only). avatar_url = MEDIA_BASE_URL + avatar_key.

Projection consumer (JetStream stream VIDEO, see contracts/events/README.md):
- Durable pull consumer "social-videos", filter_subjects [video.ready, video.deleted], ack explicit, ack_wait 30s,
  max_deliver 5. video.ready → INSERT INTO social.videos (id, owner_id) ON CONFLICT DO NOTHING.
  video.deleted → DELETE FROM social.videos WHERE id = … (cascades). Both idempotent; ack after commit.
- Unknown event versions: ack and log at warn level (do not crash).

Endpoints (details in the contract):
- Comments: list top-level (newest first) and replies (oldest first) with keyset pagination on (created_at, id) and an
  opaque cursor; create (trim body, 1..2000 chars after trimming; parent must be a top-level non-DELETED comment on the
  same video, else 409 code PARENT_NOT_REPLYABLE; unknown video → 404 VIDEO_NOT_FOUND); edit (author only, VISIBLE
  only, sets edited_at); delete (author, video owner via social.videos.owner_id, moderator or admin; sets DELETED and
  body = ''; idempotent 204); moderation PUT (moderator/admin only; HIDDEN <-> VISIBLE; DELETED → 409).
- Listing rules: omit HIDDEN (except for moderator/admin); DELETED is returned as a tombstone only when it has
  replies (reply_count counts VISIBLE replies only, so check existence of any reply). Fill can_edit / can_delete for
  the caller.
- Likes: PUT/DELETE idempotent (INSERT … ON CONFLICT DO NOTHING / DELETE). Only when a row was actually inserted or
  deleted, enqueue social.video.like_changed with the ABSOLUTE like_count read after the write, in the SAME
  transaction (packages/outbox).
- Subscriptions: PUT validates the channel exists in auth.public_profiles (404 otherwise) and rejects self (400
  code CANNOT_SUBSCRIBE_SELF); DELETE idempotent; enqueue social.subscription.changed only on a real change.
  GET /v1/me/subscriptions joins public_profiles (skip channels with no active profile).
- Create comment enqueues social.comment.created (include parent_author_id) in the same transaction.
- Rate limits (Valkey, same limiter as auth-svc): comments 10/min per user; likes and subscriptions 60/min per user.
  429 with Retry-After.
- Errors: RFC 9457 application/problem+json with code. Logs: JSON, never log comment bodies at info level.
- Health: /healthz; /readyz checks DB, NATS (JetStream) and Valkey.
- Image: Dockerfile like services/auth (repo-root context, pnpm install --frozen-lockfile, pnpm deploy), multi-arch,
  non-root. Add the image to .github/workflows/images.yml? NO — that file is Antigravity 2's; the images matrix already
  contains "social".

Env: DATABASE_URL (role social_svc), NATS_URL, VALKEY_URL, MEDIA_BASE_URL, HTTP_PORT, TRUST_PROXY_CIDRS.
Commit services/social/.env.example with dummy values.

# DEFINITION OF DONE
- Tests on REAL PostgreSQL 17 (db/migrations applied) + NATS JetStream via testcontainers, gated by
  WINKEY_REQUIRE_DOCKER=1 (must fail, not skip, in CI) and hookTimeout 120s:
  • two levels enforced (reply-to-reply → 409), cross-video parent → 409, unknown video → 404;
  • counters after create/hide/restore/delete, tombstone visibility rules, HIDDEN only for moderators;
  • permissions: author / video owner / moderator / stranger on edit, delete, moderation;
  • like/subscribe idempotency: two PUTs → one row, ONE outbox event; DELETE twice → one event;
  • events: outbox rows validate against contracts/events/social.*.schema.json (use ajv in the test);
  • projection consumer: video.ready twice → one row; video.deleted cascades comments and likes;
  • keyset pagination: stable across inserts, no duplicates or gaps;
  • a contract test that every route and response matches social.v1.yaml (same approach as services/auth).
- pnpm run format:check, lint (0 warnings in src/), typecheck, test and build pass at the repo root.
- README in services/social: run, env table, test.
- PR description = the Handoff Report (.github/pull_request_template.md), with the test output pasted.

# OUT OF SCOPE (other owners)
- Traefik routes for social (Antigravity 2, see "Gateway routing" in the contract), the social_svc role, the SOCIAL
  stream and grants in deploy/compose (Antigravity 2 — the architect opens an issue).
- video-svc consuming social.video.like_changed (Sonnet).
- Realtime fan-out (C2) and the web UI (Antigravity 1).
````
