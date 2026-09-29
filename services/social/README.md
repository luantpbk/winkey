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
- **Projection Consumer**: Durable pull consumer `social-videos` on JetStream `VIDEO` stream (`video.ready`, `video.deleted`).
- **Rate Limiting**: Valkey-backed sliding window rate limiter (10 comments/min, 60 likes/min, 60 subscriptions/min).
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
