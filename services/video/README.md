# video-svc

Video metadata, public feed, watch-page data and the creator's studio list. Implements [`contracts/openapi/video.v1.yaml`](../../contracts/openapi/video.v1.yaml); emits `video.deleted` through the transactional outbox (ADR-008). Owner: Sonnet 5.5 (task S1).

## Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /v1/videos` | optional | Public feed: **READY + PUBLIC** only, newest first, keyset pagination on `(published_at DESC, id DESC)` (partial index `media.videos_public_feed`). `limit` 1-100 (default 24), `cursor`, `owner_id` (channel page). UNLISTED and PRIVATE videos are never listed, not even for their owner (the studio is for that). |
| `GET /v1/videos/{id}` | optional | Watch page. Visibility below. `Cache-Control: public, max-age=30` for PUBLIC READY, `private, no-store` otherwise. `playback` is `null` unless READY. |
| `PATCH /v1/videos/{id}` | required | Owner only. `title` 1-100, `description` ≤ 5000, `visibility`; unknown fields and `{}` → 400. |
| `DELETE /v1/videos/{id}` | required | Owner, moderator or admin. **One transaction**: delete the row (cascades to renditions and jobs) + enqueue `video.deleted` (`raw_bucket`, `raw_key`, `media_bucket`, `media_prefix = v/{id}/`). The transcoder's media janitor purges the objects. |
| `GET /v1/studio/videos` | required | The caller's videos in every status, keyset on `(created_at DESC, id DESC)` (index `media.videos_owner_created`), optional `status` filter, `progress` from the latest transcode job (READY → 100), `thumbnail_url` when present. `private, no-store`. |

### Visibility (who sees what by id)

| Video | anonymous / other user | owner, moderator, admin |
|---|---|---|
| READY + PUBLIC | 200 | 200 |
| READY + UNLISTED | 200 (by id only, never listed) | 200 |
| READY + PRIVATE | **404** | 200 |
| not READY (UPLOADING … FAILED) | **404** | 200 |
| owner not ACTIVE (suspended/deleted) | **404** | 200 (placeholder owner `deleted_user`) |

A video the caller may not see is always **404, never 403**, so ids cannot be probed. PATCH and DELETE follow the same rule first (404), then answer **403** for a visible video the caller may not change. Identity comes only from `X-User-Id` / `X-User-Roles`; on the two optional routes a missing `X-User-Id` is an anonymous request and a malformed one is a 401.

### Owner profile, media URLs

The owner comes from `auth.public_profiles` (role `media_svc` has `SELECT` on that view only) with a join in the same query, so a page costs **one** query, with no per-item lookup. `avatar_url = MEDIA_BASE_URL + "/" + avatar_key` (null without an avatar); `hls_url` and `thumbnail_url` are built the same way from `hls_master_key` / `thumbnail_key`. Videos of owners who are not ACTIVE are not listed in the feed.

### Pagination cursors

`next_cursor` is an opaque token `base64url(payload).base64url(HMAC-SHA256)` of the last item's `(sort timestamp, id)`. The MAC (key `CURSOR_SECRET`) covers the endpoint and its filters (`owner_id`; user + `status`), so an edited, foreign or replayed cursor gets **400** `INVALID_CURSOR` instead of an arbitrary position. Timestamps are kept at PostgreSQL's microsecond resolution and the id breaks ties, so videos sharing a timestamp are neither skipped nor repeated. Changing `CURSOR_SECRET` invalidates outstanding cursors (clients restart from the first page).

### Like counts (`social.video.like_changed`)

social-svc owns likes and publishes `social.video.like_changed` (JetStream stream `SOCIAL`) with the **absolute** `like_count` after each change. video-svc copies it into `media.videos.like_count`:

- durable pull consumer `video-likes`, `filter_subject: social.video.like_changed`, explicit ack, `ack_wait 30s`, `max_deliver 5`;
- `UPDATE media.videos SET like_count = $count WHERE id = $id AND like_count <> $count`: it **sets**, never increments, so duplicates and redelivery are harmless, and an un-like lowers the number. An unchanged value writes nothing (no `updated_at` bump);
- after a change the video's Valkey cache entry is deleted (Valkey is shared, so this reaches every replica), other videos keep theirs; a video that does not exist here (deleted) is acked and dropped;
- **poison messages** (bad JSON, wrong type, malformed or negative `like_count`, missing fields) are `Term`ed with an error log and never redelivered; events of an unknown `version` are acked and ignored (contracts/events/README.md); extra fields are tolerated;
- **ordering**: messages are processed strictly one at a time, and a transient database error is retried in-process (3 attempts, 200 ms doubling) instead of Nak-ing at once, because a Nak'd message is redelivered after newer ones and an absolute count applied late would move the number backwards. Only when those attempts fail is the message Nak'd (10 s delay, redelivered up to 5 times); in that rare case the next like/unlike of the video carries a fresh absolute count and corrects it;
- the consumer keeps looking for the `SOCIAL` stream while it does not exist, so video-svc starts and serves before social-svc is deployed.

Metric: `video_like_events_total{result=applied|unchanged|malformed|ignored_version|error}`. It is not a readiness dependency.

### Cache (optional)

With `VALKEY_URL` set, `GET /v1/videos/{id}` caches the **viewer-independent record** (video + owner + renditions) for `CACHE_TTL` (30 s); visibility is applied after reading it, so one entry serves every viewer and a cached PRIVATE video is never leaked. `PATCH`/`DELETE` invalidate the entry in-process (other replicas see the change when their copy expires) and always decide authorisation from the database, never from the cache. The cache **fails open**: short timeouts, no client retries and a 5 s circuit breaker, so a Valkey outage costs nothing per request. It is not a readiness dependency.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL (role `media_svc`) |
| `NATS_URL` | required | JetStream for the outbox relay |
| `MEDIA_BASE_URL` | required | Prefix for playback/thumbnail/avatar URLs, e.g. `https://media.winkey.vn` |
| `CURSOR_SECRET` | required | ≥ 16 characters; signs pagination cursors; same value on every replica |
| `S3_MEDIA_BUCKET` | `winkey-media` | Bucket named in `video.deleted` |
| `VALKEY_URL` | empty (disabled) | e.g. `redis://valkey:6379/0` |
| `CACHE_TTL` | `30s` | |
| `HTTP_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Tracing is a no-op when unset |

Probes: `GET /healthz`, `GET /readyz` (PostgreSQL, NATS), `GET /metrics`.

## Run

```bash
cp .env.example .env    # edit, then export the variables
go run ./cmd/video
```

## Test

```bash
go test ./...                              # unit tests; PostgreSQL tests skip without Docker
WINKEY_REQUIRE_DOCKER=1 go test -race ./...  # CI: PostgreSQL 17 via testkit
```

- **Contract test**: every response of the handler tests and of the PostgreSQL integration test is validated against `contracts/openapi/video.v1.yaml` (`internal/contract`: body schema, documented status, media type), and the `video.deleted` event against `contracts/events/*.schema.json`. The checker has its own negative tests (bad bodies, undocumented statuses and media types are rejected).
- Store tests (PostgreSQL 17, real migrations): visibility-relevant reads, feed filters and order, keyset pagination across equal timestamps with microsecond precision, studio progress from the latest job, `EXPLAIN` checks that the queries can use `videos_public_feed` / `videos_owner_created`, partial PATCH, delete cascade + exactly one outbox event, and delete atomicity (a failing event write leaves the video in place).

## Image

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f services/video/Dockerfile .   # from the repo root
```
Distroless `static:nonroot`, no shell, runs as non-root.
