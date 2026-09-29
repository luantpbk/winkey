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
- **Projection Consumer & Hidden Videos (Task A2)**:
  - Durable pull consumer `social-videos` on JetStream stream `VIDEO` listening to `video.ready`, `video.deleted`, and `video.moderated`.
  - Ingests `video.moderated` events, setting `social.videos.hidden = (state === 'HIDDEN')`.
  - Hidden video rule: When a video is hidden, its comment and like endpoints answer `404` for regular users; moderators and admins retain full access.
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
