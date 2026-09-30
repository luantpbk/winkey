# Kickoff — Task C4 (social-svc knows video visibility)

Why: social-svc only learns about videos from `video.ready` / `video.deleted` / `video.moderated`, so today anyone
who knows the id of a `PRIVATE` video can read and write its comments and likes. Migration 000009
(`social.videos.visibility`), the optional `visibility` of `video.ready`, the new event
`video.visibility_changed` and the rule in social.v1.yaml (info.description, "Task C4") are on main.

Two parts, independent thanks to the contract: **C4-a** (Antigravity 3, social-svc) now; **C4-b** (Sonnet,
producers) after V5a. Until C4-b ships, events carry no visibility and every row stays `PUBLIC` = today.

## C4-a — Antigravity 3 · social-svc

````text
# ROLE
You are the Node product-services engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-c4 -b agent/ag3/c4-social-visibility origin/main
READ FIRST: contracts/events/README.md (catalog row video.visibility_changed; social-svc consumer section),
contracts/events/video.visibility_changed.schema.json, video.ready.schema.json (visibility), contracts/openapi/
social.v1.yaml info.description "Task C4", db/migrations/000009_social_visibility.up.sql, services/social
(projection/consumer.ts, the `hidden` checks added in A2, postgres-real tests).
You own: services/social. Branch: agent/ag3/c4-social-visibility.

# TASK C4-a — implement exactly
1. Consumer `social-videos`: add `video.visibility_changed` to filter_subjects with `consumers.update` (same
   durable, as A2 did). Handlers (validate every event against its schema, poison → term, as today):
   - video.ready: upsert; when `data.visibility` is present, write it (INSERT and ON CONFLICT DO UPDATE);
     when absent, keep the existing value (new rows get the default PUBLIC).
   - video.visibility_changed: UPDATE social.videos SET visibility WHERE id; unknown video → ack and skip.
2. Access rule, in ONE place shared with the `hidden` check: a video is "closed" for a caller when
   (hidden AND the caller is not a moderator/admin — A2: the owner is NOT exempt) OR (visibility = 'PRIVATE' AND
   the caller is neither the video owner (social.videos.owner_id) nor a moderator/admin (X-User-Roles)). Closed → 404 on every comment/like endpoint of that video (list, create,
   replies, get/like/unlike), exactly like hidden today. UNLISTED = PUBLIC.
3. Realtime is out of scope (events carry ids only).

# DEFINITION OF DONE
- Unit tests for the rule matrix (hidden × visibility × owner/moderator/admin/other/anonymous).
- Real PostgreSQL 17 + NATS tests (WINKEY_REQUIRE_DOCKER=1): publish video.ready without visibility → PUBLIC;
  with PRIVATE → outsiders 404, owner 200; video.visibility_changed PRIVATE→PUBLIC reopens; event for unknown
  video is acked; the durable's filter_subjects contain all four subjects after start (existing durable updated,
  not duplicated).
- `pnpm run lint && pnpm run typecheck && pnpm run test` green, CI green; README updated; Handoff Report with the
  real postgres-real output (N tests, 0 skipped).

# OUT OF SCOPE
Producers (C4-b), contracts, migrations.
````

## C4-b — Sonnet · producers (after V5a)

````text
Branch agent/sonnet/c4-visibility-events from origin/main. You own services/video, services/transcoder.
1. video-svc updateVideo: when visibility actually changes, write `video.visibility_changed`
   {video_id, owner_id, visibility} to media.outbox in the SAME transaction (no event for a no-op or other fields).
2. transcoder: the UPDATE that switches the row to READY returns `visibility`; put it in video.ready.data.visibility.
3. Tests on PostgreSQL 17: outbox row + schema validation for both events; no event on no-op; the relay publishes
   on subject video.visibility_changed (stream VIDEO).
````
