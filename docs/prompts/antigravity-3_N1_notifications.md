# Kickoff — Antigravity 3 · Task N1 (in-app notifications in social-svc)

Starts after OBS-N (#123, merged). Design: ADR-023. Contract on main: tag `notifications` in
contracts/openapi/social.v1.yaml (`listNotifications`, `getUnreadNotificationCount`, `markNotificationsRead`, schemas
`Notification*`, `UnreadCount`, `MarkNotificationsReadRequest`). Migration 000013 (`social.notifications`, tested in
db/tests/011_notifications.sql). The gateway route `/v1/notifications` is a separate small task for Antigravity 2;
until it lands, test against social-svc directly. The web bell (Antigravity 1) comes later.

````text
# ROLE
You are the Node/TypeScript engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-n1 -b agent/ag3/n1-notifications origin/main
READ FIRST: docs/DECISIONS.md ADR-023 (and ADR-007, ADR-008, C4 rules in the social.v1.yaml info block),
contracts/openapi/social.v1.yaml (tag `notifications`), db/migrations/000013_notifications.up.sql (read the
comments: unique dedup index, CHECKs), contracts/events/README.md "Consumer của social-svc" (the new N1 bullet).
You own: services/social, packages/*. Branch: agent/ag3/n1-notifications. Never edit contracts/, db/, deploy/.
First: `pnpm --filter @winkey/api-client run generate` and add the table to the Kysely DB types.

# TASK N1 — build (services/social)
1. Writers — every insert is `INSERT … ON CONFLICT DO NOTHING`, ids are UUIDv7 from the app, and nothing is ever
   inserted with user_id = actor_id (skip in code; the CHECK is the safety net, never rely on catching it):
   a. createComment, same transaction as the comment + outbox row:
      top level → `VIDEO_COMMENT` to `social.videos.owner_id` (video_id, comment_id);
      reply → `COMMENT_REPLY` to the parent comment's author_id (video_id, comment_id = the reply). A reply does not
      also notify the video owner.
   b. subscribe, same transaction, only when the subscription row was actually inserted (not an idempotent repeat)
      → `NEW_SUBSCRIBER` to channel_id, actor = subscriber. Unsubscribe deletes nothing.
   c. social-videos consumer (projection/consumer.ts), same transaction as the projection write: read the previous
      row `FOR UPDATE` (absent = not public); after `video.ready` or `video.visibility_changed`, if the row was not
      PUBLIC before and is now `visibility = 'PUBLIC' AND hidden = false` → `VIDEO_PUBLISHED` to every subscriber
      of owner_id (actor = owner_id). Page the subscribers by keyset on subscriber_id, 1 000 per page, and insert
      each page with one statement over `unnest($ids::uuid[], $users::uuid[])`. `video.moderated` never notifies.
      A DB error → nak like today (the transaction rolls back the projection too, so the retry re-evaluates).
2. Readers (bearer required; `Cache-Control: private, no-store`; problem+json errors like the other routes):
   - `GET /v1/notifications`: keyset on (created_at, id) DESC with the existing opaque cursor helper, `limit` per
     common.yaml, `unread=true` → `read_at IS NULL` (uses notifications_user_unread). Filter per ADR-023:
     LEFT JOIN social.videos v / social.comments c; drop rows where v.hidden or v.visibility = 'PRIVATE', where
     comment_id is set and c.status <> 'VISIBLE', and where the actor is missing from auth.public_profiles
     (JOIN it — it also gives the `actor` PublicProfile, same mapping as comments). Filtered rows still advance the
     cursor: fetch limit+1 of the FILTERED query so a page is never short while more rows exist.
   - `GET /v1/notifications/unread-count`: same filters, `SELECT count(*) FROM (… LIMIT 101)`; count = min(n,100),
     capped = n > 100.
   - `POST /v1/notifications/read`: body validated against the schema (exactly one of ids / up_to, unknown fields
     → 400). `UPDATE … SET read_at = now() WHERE user_id = $caller AND read_at IS NULL AND (id = ANY($ids) |
     created_at <= $up_to)`. Foreign/unknown ids are ignored. 204.
3. Janitor: every 10 min, `pg_try_advisory_lock(<fixed key>)`; `DELETE … WHERE id IN (SELECT id FROM
   social.notifications WHERE created_at < now() - interval '90 days' LIMIT 5000)` in a loop until < 5000 rows;
   unlock. Env: NOTIFICATIONS_RETENTION_DAYS (default 90), NOTIFICATIONS_JANITOR_INTERVAL (default 10m).
4. Metrics (prom-client from OBS-N): `social_notifications_created_total{kind}`,
   `social_notifications_fanout_seconds` (histogram), `social_notifications_janitor_deleted_total`.
5. README (env table, the 3 endpoints) + .env.example.

# DEFINITION OF DONE
- Integration tests (testcontainers PG + NATS, WINKEY_REQUIRE_DOCKER=1, 0 skipped), every response checked against
  the contract with the existing contract-check helper:
  comment → owner notified, reply → parent author notified (not the owner), own comment / own reply / self
  subscribe produce nothing; subscribe twice / unsubscribe + subscribe → 1 NEW_SUBSCRIBER;
  video.ready PUBLIC with 3 subscribers → 3 rows, the same event redelivered → still 3; PRIVATE → nothing, then
  visibility_changed PUBLIC → 3, PRIVATE → PUBLIC again → still 3; UNLISTED → nothing; 2 500 subscribers → 2 500
  rows (paging); list filters (hidden video, PRIVATE video, HIDDEN/DELETED comment, suspended actor) with the page
  still full; cursor walk over 45 rows with limit 20 = 20/20/5 with no duplicates; unread filter; count capped at
  100 (+ capped=true at 101); mark by ids (foreign id ignored, read_at unchanged on repeat) and by up_to; 400 on
  both / neither / 101 ids; 401 without identity; janitor deletes only rows older than the retention and only one
  of two concurrent runs gets the lock.
- `pnpm --filter @winkey/social run lint && typecheck && test && build`, root `pnpm run lint && pnpm run
  format:check`, CI green. The new test files 10× in a row (paste the count; give the bash loop).
- Real output pasted: `curl` of the three endpoints against `make dev` (with X-User-Id) after creating a comment,
  a reply and a subscription, plus `curl -s localhost:<port>/metrics | grep social_notifications`.
- PR against main; description = Handoff Report.

# OUT OF SCOPE
Web UI (Antigravity 1), gateway route (Antigravity 2), push via realtime-gw / Web Push / e-mail, per-kind settings,
grouping, any contract or migration change (→ `contract-change` issue).
````
