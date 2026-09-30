# Kickoff — Antigravity 3 · Task N2 (realtime notification hints in realtime-gw)

Starts after N1 (#130, merged). Design: ADR-023 addendum "N2". Contract on main: `notification.hint` in
contracts/realtime/server.schema.json (+ example, README table rows). No change to social-svc, no new domain event.
The web side (drop polling to 5 min while the socket is up, refetch on a hint) is a later Antigravity 1 task.

````text
# ROLE
You are the Node/TypeScript engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-n2 -b agent/ag3/n2-notification-hints origin/main
READ FIRST: docs/DECISIONS.md ADR-023 (+ addendum N2), contracts/realtime/README.md ("Nguồn event → message", the
three N2 rows and the `notification.hint` note), contracts/realtime/server.schema.json ($defs.notificationHint),
contracts/events/social.comment.created.schema.json + social.subscription.changed.schema.json,
services/realtime/src/nats/consumer.ts (the SOCIAL ephemeral ordered consumer).
You own: services/realtime, packages/*. Never edit contracts/, db/, deploy/.

# TASK N2 — build (services/realtime)
1. SOCIAL consumer: add `social.subscription.changed` to `filterSubjects` (keep it ephemeral + ordered,
   deliver_policy new). Strict decode like the existing cases; unknown version → skip + warn (as today).
2. Mapping (exactly the README rows; never send a hint to the actor themself):
   - `social.comment.created`, `parent_id` null and `video_owner_id` ≠ `author_id` → `notification.hint
     {kind: "VIDEO_COMMENT"}` to `user:{video_owner_id}`;
   - `social.comment.created`, `parent_author_id` non-null and ≠ `author_id` → `{kind: "COMMENT_REPLY"}` to
     `user:{parent_author_id}` (in addition to the existing `comment.reply`, same room);
   - `social.subscription.changed`, `subscribed` true and `subscriber_id` ≠ `channel_id` → `{kind:
     "NEW_SUBSCRIBER"}` to `user:{channel_id}`; `subscribed` false → nothing.
3. Every outgoing frame already goes through the server-schema validator: keep it that way (a frame that fails the
   schema is dropped + metric, never sent).
4. Metrics: the existing "messages sent by event" counter covers `notification.hint`; add the `kind` label only if
   the counter already has a free label budget (≤ 5 values here), otherwise a separate
   `realtime_notification_hints_total{kind}`.
5. README of the service: the new mapping.

# DEFINITION OF DONE
- Unit tests for the mapping table (each row, each "not sent" case: self-comment, self-reply, top-level comment
  by the owner, unsubscribe, self-subscribe) with frames validated against contracts/realtime/server.schema.json.
- Integration test (testcontainers NATS, WINKEY_REQUIRE_DOCKER=1, 0 skipped): a WebSocket client authenticated as
  the channel owner receives `notification.hint NEW_SUBSCRIBER` after `social.subscription.changed` is published
  on SOCIAL, and receives nothing for `subscribed:false`; a second user's socket receives nothing.
- `pnpm --filter @winkey/realtime run lint && typecheck && test && build`, root `pnpm run lint && pnpm run
  format:check`, CI green; new test files 10× in a row (paste the count). Open the PR yourself; description =
  Handoff Report with real outputs.

# OUT OF SCOPE
Web client changes (Antigravity 1), social-svc, VIDEO_PUBLISHED hints (by design none), any contract change
(→ `contract-change` issue).
````
