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
- **Likes**: Idempotent video likes and unlikes.
  - Automatically publishes `social.video.like_changed` with absolute `like_count` via transactional outbox.
- **Subscriptions**: Idempotent channel subscriptions and unsubscriptions.
  - Self-subscription rejection (`400 CANNOT_SUBSCRIBE_SELF`).
  - Automatically publishes `social.subscription.changed` with absolute `subscriber_count` via transactional outbox.
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
    - Video publish fanout -> `VIDEO_PUBLISHED` notification to all channel subscribers on `video.ready` / `video.visibility_changed` transition to `PUBLIC`.
    - Dedup index on `(user_id, kind, COALESCE(comment_id, video_id, actor_id))`.
    - Self-notifications (`user_id = actor_id`) are always omitted.
  - Readers:
    - `GET /v1/notifications`: List caller's notifications with keyset cursor pagination (`(created_at, id) DESC`), `limit` parameter, and optional `unread=true` filter. Automatically omits notifications pointing to hidden or private videos, non-visible comments, or deleted/missing actor profiles.
    - `GET /v1/notifications/unread-count`: Efficient unread badge counter (`count: min(n, 100)`, `capped: n > 100`).
    - `POST /v1/notifications/read`: Mark notifications as read using either `ids` (1-100 UUIDs) or `up_to` (ISO timestamp). Returns 204.
  - Janitor: Periodic background worker using Postgres advisory lock (`821390`) to batch delete notifications older than retention days (default 90 days).
- **Playlists & Watch Later (Task PL1 / ADR-024)**:
  - `POST /v1/playlists`: Create playlist owned by caller (default `PRIVATE` visibility, at most 200 playlists/user -> 409 `PLAYLIST_LIMIT`, rate limit 30/min).
  - `GET /v1/playlists/:playlist_id`: One playlist details (`PUBLIC`/`UNLISTED` accessible to anyone, `PRIVATE`/`WATCH_LATER` accessible only to owner -> 404 otherwise). `Cache-Control: private, no-store`.
  - `PATCH /v1/playlists/:playlist_id`: Update title, description, or visibility (owner only; watch later -> 409 `WATCH_LATER_IMMUTABLE`).
  - `DELETE /v1/playlists/:playlist_id`: Delete playlist and cascade items (owner only; watch later -> 409 `WATCH_LATER_IMMUTABLE`).
  - `GET /v1/playlists/:playlist_id/items`: List items in position ASC order with keyset cursor pagination (`position > cursor`). Filters out hidden or private videos unless owned by caller. `Cache-Control: private, no-store`.
  - `POST /v1/playlists/:playlist_id/items`: Append video to playlist (at most 5000 items -> 409 `PLAYLIST_FULL`, rate limit 120/min, idempotent 200 vs 201; sparse position `max(position) + 2^20`).
  - `DELETE /v1/playlists/:playlist_id/items/:video_id`: Remove video from playlist (idempotent 204).
  - `POST /v1/playlists/:playlist_id/items/:video_id/move`: Reposition item before another or to the end (`before_video_id: null`). Uses midpoint sparse positioning; triggers automatic deferred renumbering (`SET CONSTRAINTS social.playlist_items_position DEFERRED`) when no integer gap exists. Moving before itself is a no-op 200.
  - `GET /v1/channels/:channel_id/playlists`: List channel's playlists. Channel owner sees all playlists (watch later pinned first, then `(updated_at, id)` DESC); others see only `PUBLIC` regular playlists. Keyset pagination on `(updated_at, id)`.
  - `GET /v1/me/watch-later`: Lazily creates and returns caller's private watch-later playlist with title "Xem sau" (exempt from 200 playlist limit).
  - `GET /v1/videos/:video_id/playlist-membership`: Returns array of caller-owned playlist IDs containing the given video.
- **RFC 9457 Errors**: Standardized problem details (`application/problem+json`) with machine-readable error codes.
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
| `social_notifications_created_total` | Counter | `kind` | Total notifications created by kind (`VIDEO_PUBLISHED`, `VIDEO_COMMENT`, `COMMENT_REPLY`, `NEW_SUBSCRIBER`). |
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
