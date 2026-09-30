# Kickoff — Sonnet 5.5 · Task R2-b (subscription feed)

Starts after R2-a (#101, merged). ADR-021, migration 000012 (`media.subscriptions` + backfill +
`videos_owner_published` index), the contract (`getSubscriptionFeed`, GET /v1/feed/subscriptions) and the consumer
section in contracts/events/README.md are on main.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree: git worktree add ../winkey-sonnet-r2b -b agent/sonnet/r2b-subscription-feed origin/main
READ FIRST: docs/DECISIONS.md ADR-021 (and ADR-007), db/migrations/000012_subscription_feed.up.sql,
contracts/events/social.subscription.changed.schema.json + README (consumer "video-subscriptions"),
contracts/openapi/video.v1.yaml getSubscriptionFeed; services/video likes consumer (same stream SOCIAL — reuse its
pattern: durable, validation, poison → Term, retries, stream-wait).
You own: services/video, libs/go. Branch: agent/sonnet/r2b-subscription-feed.

# TASK R2-b
1. Consumer `video-subscriptions` (stream SOCIAL, filter social.subscription.changed, deliver_policy all,
   ack explicit, ack_wait 30s, max_deliver 5): validate each event against its schema (invalid → Term + metric);
   subscribed=true → INSERT … ON CONFLICT DO NOTHING (subscribed_at = event occurred_at); false → DELETE.
   Sequential. DB errors → retry in process like the likes consumer, never reorder. Starts even if the stream
   does not exist yet (same wait as likes). Metric video_subscription_events_total{result}.
2. GET /v1/feed/subscriptions: identity from X-User-Id (401 without); public-feed predicate + owner in
   auth.public_profiles + owner_id IN (SELECT channel_id FROM media.subscriptions WHERE subscriber_id = $me);
   ORDER BY published_at DESC, id DESC; opaque cursor (reuse the cursor package); limit as listVideos;
   Cache-Control private, no-store; EXPLAIN on a seeded DB must use videos_owner_published (paste it).
3. README: the consumer, the endpoint, eventual consistency, and that NATS user `video` needs permission to create
   the durable `video-subscriptions` on SOCIAL — if the dev/k3s NATS config denies it, open an issue for
   Antigravity 2 with the exact permission line.

# DEFINITION OF DONE
- Unit: event → action mapping, cursor round-trip.
- Integration on PG17 + NATS (WINKEY_REQUIRE_DOCKER=1, 0 skipped): publish subscribe → feed lists that channel's
  public videos newest first (paging across 2 pages); unsubscribe → gone; PRIVATE/HIDDEN/suspended-owner videos
  never listed; replaying the same events twice leaves the same state; a poison message is terminated and does not
  block the next one; the consumer created before the stream exists catches up; no subscriptions → empty page;
  anonymous → 401; Spec.Check on every response.
- go vet, golangci-lint, go test -race, arm64 build, `GOWORK=off go build ./...`. PR = Handoff Report with real output.
OUT OF SCOPE: web UI (Antigravity 1 later), notifications, social-svc changes, contract/migration changes.
````
