# @winkey/realtime (realtime-gw)

Realtime WebSocket Gateway for Winkey. Part of the C2 task, owned by **Antigravity 3**.

Implements:
- `contracts/openapi/realtime.v1.yaml` (HTTP ticket issuance and WebSocket upgrade)
- `contracts/realtime/` (`client.schema.json`, `server.schema.json`, `README.md`)
- Domain event ingestion from Core NATS and JetStream ephemeral ordered consumers.

## Architecture

- **At-most-once, no replay**: Client state of record is in REST APIs. On reconnect, clients re-subscribe to rooms and refresh state via REST.
- **Stateless & No Database**: realtime-gw has no database and writes no outbox events (ADR-009). All ephemeral connection state and single-use tickets live in Valkey or memory.
- **Single-use Ticket Exchange**:
  1. Client calls `POST /v1/realtime/ticket` with gateway-verified identity headers (`X-User-Id`, `X-User-Roles`).
  2. Gateway generates a cryptographically random 256-bit URL-safe ticket and stores `rt:ticket:{sha256(ticket)}` -> `{user_id, roles}` in Valkey with 30s TTL.
  3. Client opens `wss://winkey.vn/v1/realtime?ticket=<ticket>`.
  4. Gateway redeems the ticket atomically with `GETDEL` **before** switching protocols (HTTP 101).
  5. Without a ticket, connection is accepted as **anonymous** (can only join authorized `video:*` rooms).
- **Rooms & Authorization**:
  - `video:{video_id}`: Any user who can view the video (verified against `video-svc` `GET /v1/videos/{video_id}` with ≤ 60s cache).
  - `upload:{video_id}`: Authenticated only. Events are delivered only if `event.data.owner_id === connection.user_id` or role is `moderator`/`admin`.
  - `user:{user_id}`: Automatically joined upon authenticated connection. Receives personal events (`video.ready`, `video.failed`, `comment.reply` excluding self-replies).
- **Limits**:
  - 50 rooms per connection (exceeding returns `TOO_MANY_ROOMS`). Internal auto-joined `user:{me}` room does not count against client subscription slots.
  - 5 connections per user (6th connection closed with code `4429`). Currently tracked per pod in memory for the single-replica deployment; can transition to Valkey-backed session counters when scaled out.
  - 20 messages/second per connection (exceeding returns `RATE_LIMITED`, 5 consecutive seconds closed with `4429`).
  - 4 KiB maximum client frame size (binary or malformed frames return `BAD_MESSAGE`, 5 consecutive closed with `4400`).
  - 256 queued outbound messages per connection (drops oldest message on overflow).
  - Heartbeat: Server pings every 25s; no pong in 60s closes connection with code `4408`.
  - SIGTERM: Closes all connections with code `1001` within 10s.

- **Revocation Sweeper (Task A5, ADR-019 addendum)**:
  - `realtime-gw` runs a periodic background sweeper every `REVOCATION_SWEEP_MS` (default 30000 ms / 30s).
  - Collects distinct `userId`s of active authenticated connections and queries `auth:revoked:user:{userId}` cutoff timestamps via ONE `MGET` (chunked in batches of 500 IDs).
  - Any connection with `authenticatedAt <= cutoff` is closed with code `4401` and reason `'session revoked'`.
  - Anonymous connections are ignored and never checked.
  - Sockets established with a new ticket after the cutoff (`authenticatedAt > cutoff`) connect normally and stay open.
  - **Single session logout does not close sockets**: WebSocket tickets carry no `sid` (per ADR-019 addendum). Single-session logout (`auth:revoked:sid:{sid}`) does not affect WebSockets; only user-wide revocations (`auth:revoked:user:{userId}`, written on account suspension, role changes, or account deletion) close open sockets.
  - **Fail-Open Policy**: If Valkey is down, unreachable, or returns an error, the sweep is skipped without closing sockets, `realtime_revocation_sweep_errors_total` increments, and a warning is logged at most once per minute. Ticket values are never logged.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Environment (`development`, `production`, `test`) | `development` |
| `HTTP_PORT` | HTTP & WebSocket listen port | `8003` |
| `TRUST_PROXY_CIDRS` | Trusted gateway proxy IP CIDRs | `10.42.0.0/16,127.0.0.1,::1` |
| `VALKEY_URL` | Redis/Valkey connection URL | `redis://localhost:6379` |
| `NATS_URL` | NATS connection URL | `nats://localhost:4222` |
| `VIDEO_SVC_URL` | Internal video service endpoint | `http://localhost:8082` |
| `LOG_LEVEL` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info` |
| `HEARTBEAT_INTERVAL_MS` | WebSocket ping interval in ms | `25000` |
| `HEARTBEAT_TIMEOUT_MS` | WebSocket pong timeout in ms (closes 4408) | `60000` |
| `REVOCATION_SWEEP_MS` | Revocation sweeper interval in ms (checks `auth:revoked:user:{id}`) | `30000` |

## Metrics

Exposed via `@opentelemetry/api`:
- `realtime_revoked_closes_total`: Total number of WebSocket connections closed due to user revocation (code 4401).
- `realtime_revocation_sweep_errors_total`: Total number of revocation sweep errors (e.g. Valkey unavailable).
- Number of active connections (anonymous / authenticated), rooms, and dropped message counts.

## Running Locally

```bash
# Install dependencies
pnpm install

# Run in dev mode with live reload
pnpm --filter @winkey/realtime dev

# Build TypeScript to dist/
pnpm --filter @winkey/realtime build

# Start production build
pnpm --filter @winkey/realtime start
```

## Testing

```bash
# Run unit & contract tests
pnpm --filter @winkey/realtime run test

# Run tests requiring real NATS + Valkey testcontainers
WINKEY_REQUIRE_DOCKER=1 pnpm --filter @winkey/realtime run test
```
