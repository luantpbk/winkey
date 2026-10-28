# Winkey social-svc (`@winkey/social`)

Social service for the Winkey video platform, managing two-level comment threads, video likes, and channel subscriptions.

Part of **Task C1**, owned by **Antigravity 3**.

---

## Features

- **Comments**: Two-level threaded comments on videos (top-level and replies).
  - Keyset pagination with opaque base64 cursors (top-level newest first, replies oldest first).
  - Strict two-level hierarchy enforced by database triggers.
  - Tombstones: `DELETED` comments with replies remain in thread with `body: ""` and `status: "DELETED"`.
  - Moderation: `HIDDEN` comments visible only to moderators and admins.
- **Posts, Reshares & Post Reactions (Task SOC-2a / ADR-049)**:
  - `POST /v1/posts`: Create post (plain text, single video, or 1-4 images; plain reshare or quote post).
    - Rate limit: 30 posts per hour per user sliding window.
    - Attachments are mutually exclusive: text-only, images (1-4 from `media.ready_images`), or video (`social.videos`).
    - Reshare rules: Can reshare an existing public/unlisted post (or public video). Plain reshares cannot contain body or attachments and are deduplicated via unique index (`409 ALREADY_RESHARED`). Quote posts can contain body and attachments. Cannot reshare a reshare directly (flattened or rejected).
    - Mention and hashtag parsing: Unicode-aware parsing (`@handle`, `#hashtag`), diacritic-folded tag slugs (`public.winkey_tag_slug`), notifications for mentioned users.
  - `GET /v1/posts/:post_id`: View post with author public profile, media, top 3 reaction counts, caller's reaction (`my_reaction`), and hydrated reshare target. Returns 404 for inaccessible or non-visible posts.
  - `PATCH /v1/posts/:post_id`: Edit post body (max 5,000 chars) and visibility (`PUBLIC`, `UNLISTED`, `FOLLOWERS_ONLY`, `PRIVATE`). Plain reshares cannot have body added. Re-parses mentions and hashtags with differential notifications.
  - `DELETE /v1/posts/:post_id`: Soft delete post (`status = 'DELETED'`, body cleared, cascades media/reactions/hashtags/mentions/scores deleted; comments preserved). Idempotent 204.
  - `POST /v1/posts/:post_id/moderation`: Moderator/admin action (`HIDE` / `RESTORE`).
  - `PUT /v1/posts/:post_id/reactions`: Add or update reaction (`LIKE`, `LOVE`, `CARE`, `HAHA`, `WOW`, `SAD`, `ANGRY`). Rate limit 300/hr. Triggers `POST_REACTION` notification to post author.
  - `DELETE /v1/posts/:post_id/reactions`: Remove reaction (idempotent 200).
  - `GET /v1/posts/:post_id/reactions`: Keyset paginated list of user reactions, optional filter by reaction kind. Blocked actors are excluded.
- **Post Comments & Replies (Task SOC-2a / ADR-049)**:
  - `POST /v1/posts/:post_id/comments`: Add top-level comment or reply (max 2,000 chars). Rate limit 10 comments/min.
    - Creates `POST_COMMENT` notification to post author or `POST_COMMENT_REPLY` notification to parent comment author.
    - Block check: `403 INTERACTION_BLOCKED` if block relationship exists between caller and post author or parent comment author.
  - `GET /v1/posts/:post_id/comments`: Keyset paginated comments. Top-level newest first, replies oldest first. Omits comments from blocked users.
  - `DELETE /v1/posts/:post_id/comments/:comment_id`: Delete comment (by author, post owner, or moderator/admin). Uses tombstone (`DELETED` status, body cleared) if replies exist, otherwise hard deletes.
  - `POST /v1/posts/:post_id/comments/:comment_id/moderation`: Moderator/admin action (`HIDE` / `RESTORE`).
- **Feeds & Discovery (Task SOC-2a / ADR-049)**:
  - `GET /v1/feeds/following`: Fan-out on read following feed with keyset cursor `(published_at, id)`. 30-second Valkey cache for page 1.
  - `GET /v1/feeds/explore`: Gravity score feed reading from `social.post_scores`. Keyset cursor with snapshot expiration check (`400 CURSOR_EXPIRED`).
  - `GET /v1/hashtags/:tag/posts`: List posts tagged with `#tag` via `social.post_hashtags`. Keyset cursor on `(published_at, post_id)`.
  - `GET /v1/hashtags/trending`: Top 20 trending hashtags over rolling 24-hour window with 60-second Valkey cache.
  - `GET /v1/channels/:channel_id/posts`: Channel timeline using `posts_author_timeline` index.
- **Background Post Scoring Job (Task SOC-2a / ADR-049)**:
  - Periodic background worker running every 5 minutes with distributed Valkey lock (`social:locks:post_scoring_job`, TTL 9 minutes).
  - Computes Hacker News-style gravity score: `(reaction_count + 2*comment_count + 3*reshare_count + 1) / (age_in_hours + 2)^1.5` for public visible posts published within the last 7 days.
  - Writes scores to `social.post_scores` for instantaneous explore feed retrieval.
- **Likes**: Idempotent video likes and unlikes.
  - Automatically publishes `social.video.like_changed` with absolute `like_count` via transactional outbox.
- **Subscriptions & Follow Requests (Task SOC-1b / ADR-049)**:
  - Idempotent channel subscriptions and unsubscriptions.
  - Self-subscription rejection (`400 CANNOT_SUBSCRIBE_SELF`).
  - Private channel handling: Subscribing to a private channel (`is_private = true`) places a pending request into `social.follow_requests` and creates a `FOLLOW_REQUEST` notification without emitting an outbox event. Returns `subscribed: false, requested: true`.
  - Max 200 pending outgoing follow requests per user (`409 LIMIT_REACHED`).
  - Automatically publishes `social.subscription.changed` with absolute `subscriber_count` via transactional outbox for public subscriptions or approved requests.
  - `GET /v1/channels/:channel_id/subscription`: Returns `{ subscribed: boolean, requested: boolean }`.
  - `DELETE /v1/channels/:channel_id/subscription`: Cancels both active subscription and pending follow request.
- **Follow Requests Management (Task SOC-1b / ADR-049)**:
  - `GET /v1/me/follow-requests`: List pending requests targeting caller with keyset pagination (`(created_at, requester_id)` DESC) and total `pending_count` (excluding blocked actors).
  - `POST /v1/me/follow-requests/:requester_id/decision`: Transactional decision on a pending request:
    - `APPROVE`: Removes request, creates subscription, creates `NEW_SUBSCRIBER` notification to channel owner and `FOLLOW_REQUEST_APPROVED` notification to requester, emits `social.subscription.changed` outbox event.
    - `REJECT`: Deletes request without notifications or outbox events (`404` if not found).
- **Followers & Following Lists (Task SOC-1b / ADR-049)**:
  - `GET /v1/channels/:channel_id/followers`: Keyset paginated list of subscribers ordered by `(created_at, subscriber_id)`.
  - `GET /v1/channels/:channel_id/following`: Keyset paginated list of channels followed ordered by `(created_at, channel_id)`.
  - Access control: For private accounts, allowed only for the channel owner and approved followers (`403 PRIVATE_ACCOUNT` for strangers and anonymous callers).
  - Bidirectional block exclusion: Users in a block relationship with the caller are filtered out.
- **Relationships, Blocks & Mutes (Task SOC-1b / ADR-049)**:
  - `GET /v1/channels/:channel_id/relationship`: Returns relationship state `{ following, follow_requested, followed_by, blocking, muting }`. Rejects querying self (`400 CANNOT_QUERY_SELF`). Never exposes whether the target blocks the caller (`blocked_by` is omitted to prevent harassment and enumeration).
  - `GET /v1/me/blocks`: List blocked users with keyset pagination (`(created_at, blocked_id)` DESC).
  - `PUT /v1/me/blocks/:user_id`: Block user atomically:
    - Deletes subscriptions in both directions and emits `social.subscription.changed` outbox events for each removed subscription.
    - Deletes follow requests in both directions.
    - Inserts block into `social.blocks` (idempotent 204).
    - Max 1,000 blocks per user (`409 LIMIT_REACHED`).
  - `DELETE /v1/me/blocks/:user_id`: Unblock user (idempotent 204).
  - `GET /v1/me/mutes`: List muted users with keyset pagination (`(created_at, muted_id)` DESC).
  - `PUT /v1/me/mutes/:user_id`: Mute user notifications (idempotent 204, max 1,000 mutes -> `409 LIMIT_REACHED`).
  - `DELETE /v1/me/mutes/:user_id`: Unmute user (idempotent 204).
  - Rate limiting: 60 block and mute changes per hour per user sliding window (`429`).
- **Block Semantics & Safety Invariants**:
  - **Subscriptions**: Subscribing to someone who blocked you (or whom you blocked) returns `404` (target appears non-existent).
  - **Comments**: Attempting to comment on a video owned by a user in a block relation with the caller, or replying to a comment authored by a blocked user, returns `403 INTERACTION_BLOCKED`.
  - **Feed & Thread Visibility**: Comment lists (`listComments`, `listReplies`) automatically omit comments authored by any user in a block relation with the signed-in caller.
  - **Notifications**: Blocked actors cannot trigger notifications to the other party. Muted actors do not generate notifications to the muter (including video publication fanout from `video.ready`).
- **Content Reporting (Task A2)**:
  - `POST /v1/reports`: Users can report videos, comments, and user profiles.
  - Target visibility and existence checks: non-hidden videos, visible comments on visible videos, active profiles.
  - Self-reporting protection: users cannot report their own videos, comments, or profile (`400 CANNOT_REPORT_OWN_CONTENT`, `400 CANNOT_REPORT_SELF`).
  - Idempotent deduplication: Repeated reports on the same target while OPEN return `200` with the existing report receipt (backed by partial unique index `(reporter_id, target_type, target_id) WHERE status = 'OPEN'`).
  - Rate limiting: 20 reports per hour per user sliding window.
- **Moderation Queue & Resolution (Task A2)**:
  - `GET /v1/moderation/reports`: Cases grouped by `(target_type, target_id)` with `open_count`, reasons histogram, earliest report time, and the 5 most recent reports (including reporter public profile). Sorted by oldest open case first; cursor pagination. Requires `moderator` or `admin` in `X-User-Roles`.
  - `PUT /v1/moderation/cases/{target_type}/{target_id}/resolution`: Atomic batch update of all OPEN reports on a target to `ACTIONED` or `DISMISSED` with optional note and `resolved_by`. Returns `404` if no open reports exist.
- **Projection Consumer & Video Visibility (Task A2 & Task C4)**:
  - Durable pull consumer `social-videos` on JetStream stream `VIDEO` listening to `video.ready`, `video.deleted`, `video.moderated`, and `video.visibility_changed`.
  - Ingests `video.moderated` events, setting `social.videos.hidden = (state === 'HIDDEN')`.
  - Ingests `video.ready` (upserting optional `visibility`: `PUBLIC`, `UNLISTED`, `PRIVATE`) and `video.visibility_changed` (`UPDATE social.videos SET visibility WHERE id`, acking unknown videos).
  - Unified access control rule: Moderator/admin always has access; hidden video is closed to all callers (including owner); PRIVATE video is open to owner and closed to outsiders; UNLISTED behaves like PUBLIC.
  - Closed videos answer `404` (`VIDEO_NOT_FOUND`) on every comment and like endpoint; `UNLISTED` behaves like `PUBLIC`.
- **In-App Notifications (Task N1 / ADR-023)**:
  - Writers:
    - Top-level comment -> `VIDEO_COMMENT` notification to video owner.
    - Comment reply -> `COMMENT_REPLY` notification to parent comment author (video owner not notified).
    - Channel subscription -> `NEW_SUBSCRIBER` notification to channel owner on first subscribe.
    - Private follow request -> `FOLLOW_REQUEST` notification to channel owner.
    - Follow request approved -> `FOLLOW_REQUEST_APPROVED` notification to requester.
    - Video publish fanout -> `VIDEO_PUBLISHED` notification to all channel subscribers on `video.ready` / `video.visibility_changed` transition to `PUBLIC` (skipping subscribers who muted the video owner or are in a block relation).
    - Dedup index on `(user_id, kind, COALESCE(comment_id, video_id, actor_id))`.
    - Self-notifications (`user_id = actor_id`), block relations, and muted actors are always omitted.
  - Readers:
    - `GET /v1/notifications`: List caller's notifications with keyset cursor pagination (`(created_at, id) DESC`), `limit` parameter, and optional `unread=true` filter. Automatically omits notifications pointing to hidden or private videos, non-visible comments, or deleted/missing actor profiles.
    - `GET /v1/notifications/unread-count`: Efficient unread badge counter (`count: min(n, 100)`, `capped: n > 100`).
    - `POST /v1/notifications/read`: Mark notifications as read using either `ids` (1-100 UUIDs) or `up_to` (ISO timestamp). Returns 204.
  - Janitor: Periodic background worker using Postgres advisory lock (`821390`) to batch delete notifications older than retention days (default 90 days).
- **Playlists & Watch Later (Task PL1 / ADR-024)**:
  - `POST /v1/playlists`: Create playlist owned by caller (default `PRIVATE` visibility, at most 200 playlists/user -> 409 `PLAYLIST_LIMIT`, rate limit 30/min, optional `is_series: boolean`).
  - `GET /v1/playlists/:playlist_id`: One playlist details (`PUBLIC`/`UNLISTED` accessible to anyone, `PRIVATE`/`WATCH_LATER` accessible only to owner -> 404 otherwise; returns `is_series`). `Cache-Control: private, no-store`.
  - `PATCH /v1/playlists/:playlist_id`: Update title, description, visibility, or `is_series` (owner only; watch later -> 409 `WATCH_LATER_IMMUTABLE`; foreign items -> 409 `SERIES_FOREIGN_ITEM`).
  - `DELETE /v1/playlists/:playlist_id`: Delete playlist and cascade items (owner only; watch later -> 409 `WATCH_LATER_IMMUTABLE`).
  - `GET /v1/playlists/:playlist_id/items`: List items in position ASC order with keyset cursor pagination (`position > cursor`). Filters out hidden or private videos unless owned by caller. `Cache-Control: private, no-store`.
  - `POST /v1/playlists/:playlist_id/items`: Append video to playlist (at most 5000 items -> 409 `PLAYLIST_FULL`, rate limit 120/min, idempotent 200 vs 201; sparse position `max(position) + 2^20`; foreign item into series -> 409 `SERIES_FOREIGN_ITEM`).
  - `DELETE /v1/playlists/:playlist_id/items/:video_id`: Remove video from playlist (idempotent 204).
  - `POST /v1/playlists/:playlist_id/items/:video_id/move`: Reposition item before another or to the end (`before_video_id: null`). Uses midpoint sparse positioning; triggers automatic deferred renumbering (`SET CONSTRAINTS social.playlist_items_position DEFERRED`) when no integer gap exists. Moving before itself is a no-op 200.
  - `GET /v1/channels/:channel_id/playlists`: List channel's playlists. Channel owner sees all playlists (watch later pinned first, then `(updated_at, id)` DESC); others see only `PUBLIC` regular playlists. Includes `is_series`. Keyset pagination on `(updated_at, id)`.
  - `GET /v1/me/watch-later`: Lazily creates and returns caller's private watch-later playlist with title "Xem sau" (exempt from 200 playlist limit, `is_series: false`).
  - `GET /v1/videos/:video_id/playlist-membership`: Returns array of caller-owned playlist IDs containing the given video.
- **Cinema Catalogue & Series (Task CIN2 / ADR-035)**:
  - Gateway routes: Ingress prefixes `/v1/cinema/*` and `/v1/series/*` route to `social-svc`.
  - `GET /v1/cinema/catalog`: Public cinema catalogue merging series and standalone videos.
    - Filter: `kind=all` (default), `kind=series`, `kind=video`.
    - SERIES items: Every `PUBLIC` `is_series = true` playlist with $\ge 1$ playable episode (public, non-hidden, owned by playlist owner). Returns `first_video_id`, `episode_count`, and `owner` profile; `updated_at` is the max `added_at` of playable episodes.
    - VIDEO items: Standalone `social.videos` rows that are `PUBLIC`, non-hidden, and not a playable episode of any `PUBLIC` series. `added_at` is `social.videos.created_at`.
    - Keyset pagination: Stable cursor `{t, id, k}` (base64url JSON) ordered by `(timestamp DESC, id DESC)`. Limit $\le 48$ (default 24).
    - Caching: `Cache-Control: public, max-age=60`. Identical for anonymous and signed-in callers.
    - High-performance query: Single SQL query per page utilizing composite indexes `social.playlists_public_series` and `social.videos_catalog` (no N+1).
  - `GET /v1/series/:playlist_id/episodes`: Paginated playable episodes for a series.
    - Returns `SeriesSummary` metadata plus `{video_id, episode_number}` items.
    - Gapless 1-based numbering: `episode_number` strictly counts playable episodes in `(position ASC, video_id ASC)` order without numbering gaps.
    - Keyset pagination: Cursor `{p, id}` (base64url JSON). Limit $\le 48$ (default 48).
    - Error: 404 `SERIES_NOT_FOUND` if playlist does not exist, is not `PUBLIC`, is not `is_series`, or has 0 playable episodes.
  - `GET /v1/series/:playlist_id/episodes/:video_id`: Episode playback context and navigation.
    - Returns `episode_number`, `previous_video_id` (null for first episode), `next_video_id` (null for last episode), and `page_cursor` (the `listSeriesEpisodes` cursor with default limit 48 of the page containing this episode; `null` for page 1).
    - Errors: 404 `SERIES_NOT_FOUND` if series is not found or has 0 playable episodes; 404 `EPISODE_NOT_FOUND` if video is not a playable episode in the series.
- **RFC 9457 Errors**: Standardized problem details (`application/problem+json`) with machine-readable error codes (including `SERIES_FOREIGN_ITEM`, `SERIES_NOT_FOUND`, `EPISODE_NOT_FOUND`, `WATCH_LATER_IMMUTABLE`, `PLAYLIST_LIMIT`, `PLAYLIST_FULL`).
- **Health & Readiness**: `/healthz` and `/readyz` endpoints verifying DB, Valkey, and NATS JetStream.

---

## Configuration

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | `string` | `development` | Environment mode (`development`, `production`, `test`) |
| `HTTP_PORT` | `number` | `8002` | Port for the Fastify HTTP server |
| `DATABASE_URL` | `string` | `postgres://social_svc:social_svc@localhost:5432/winkey?sslmode=disable` | PostgreSQL connection string |
| `NATS_URL` | `string` | `nats://localhost:4222` | NATS JetStream server address |
| `VALKEY_URL` | `string` | `redis://localhost:6379` | Valkey/Redis instance URL |
| `MEDIA_BASE_URL` | `string` | `https://media.winkey.vn` | Base CDN URL for avatars and media |
| `TRUST_PROXY_CIDRS` | `string` | `10.42.0.0/16,127.0.0.1` | Trusted proxy CIDRs for Fastify client IP resolution |
| `NOTIFICATIONS_RETENTION_DAYS` | `number` | `90` | Retention period in days for notifications before janitor purges |
| `NOTIFICATIONS_JANITOR_INTERVAL` | `string` | `10m` | Interval between notification janitor runs (e.g. `10m`, `1h`) |

---

## Metrics (`GET /metrics`)

> [!NOTE]
> `/metrics` is an internal telemetry endpoint and is NOT exposed on public ingress routes.

Exposed via `@winkey/metrics` (`prom-client`) on `HTTP_PORT`:

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status` | Total incoming HTTP requests by route pattern and status code (probes and `/metrics` excluded). |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status` | HTTP request latency histogram in seconds (buckets match Go services). |
| `social_notifications_created_total` | Counter | `kind` | Total notifications created by kind (`VIDEO_PUBLISHED`, `VIDEO_COMMENT`, `COMMENT_REPLY`, `NEW_SUBSCRIBER`, `FOLLOW_REQUEST`, `FOLLOW_REQUEST_APPROVED`, `POST_COMMENT`, `POST_COMMENT_REPLY`, `POST_MENTION`, `POST_RESHARE`, `POST_REACTION`). |
| `social_notifications_fanout_seconds` | Histogram | None | Latency of subscriber notification fanout on video publication. |
| `social_notifications_janitor_deleted_total` | Counter | None | Total expired notification rows deleted by background janitor. |
| `social_playlist_items_added_total` | Counter | None | Total playlist items appended to playlists (excluding idempotent repeats). |
| `social_playlist_renumbers_total` | Counter | None | Total sparse position renumbering operations triggered when no integer gap exists. |
| Standard Node.js runtime metrics | Various | `service="social-svc"` | Default Node metrics (CPU, heap, event loop lag, etc.). |

---

## Development

### Prerequisites

- Node.js ≥ 22.0.0
- pnpm ≥ 9.0.0
- PostgreSQL 17 (with `db/migrations` applied)
- NATS Server with JetStream enabled
- Valkey or Redis 7+

### Install Dependencies

```bash
pnpm install
```

### Typecheck and Lint

```bash
pnpm --filter @winkey/social run typecheck
pnpm --filter @winkey/social run lint
```

### Build

```bash
pnpm --filter @winkey/social run build
```

### Run Locally

```bash
pnpm --filter @winkey/social run start
```

---

## Testing

```bash
# Run test suite
pnpm --filter @winkey/social test

# Run tests with real Docker containers (PostgreSQL 17 + NATS JetStream)
WINKEY_REQUIRE_DOCKER=1 pnpm --filter @winkey/social test
```

---

## Docker Build

Multi-architecture image build (`linux/amd64` and `linux/arm64`) from the repository root:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f services/social/Dockerfile .
```
