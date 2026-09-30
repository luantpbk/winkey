# video-svc

Video metadata, public feed, watch-page data and the creator's studio list. Implements [`contracts/openapi/video.v1.yaml`](../../contracts/openapi/video.v1.yaml); emits `video.deleted` and `video.moderated` through the transactional outbox (ADR-008). Owner: Sonnet 5.5 (task S1).

## Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /v1/videos` | optional | Public feed: **READY + PUBLIC** only, newest first, keyset pagination on `(published_at DESC, id DESC)` (partial index `media.videos_public_feed`). `limit` 1-100 (default 24), `cursor`, `owner_id` (channel page). UNLISTED and PRIVATE videos are never listed, not even for their owner (the studio is for that). |
| `GET /v1/videos/{id}` | optional | Watch page. Visibility below. `Cache-Control: public, max-age=30` for PUBLIC READY, `private, no-store` otherwise. `playback` is `null` unless READY. |
| `PATCH /v1/videos/{id}` | required | Owner only. `title` 1-100, `description` ≤ 5000, `visibility`; unknown fields and `{}` → 400. |
| `DELETE /v1/videos/{id}` | required | Owner, moderator or admin. **One transaction**: delete the row (cascades to renditions and jobs) + enqueue `video.deleted` (`raw_bucket`, `raw_key`, `media_bucket`, `media_prefix = v/{id}/`). The transcoder's media janitor purges the objects. |
| `GET /v1/studio/videos` | required | The caller's videos in every status, keyset on `(created_at DESC, id DESC)` (index `media.videos_owner_created`), optional `status` filter, `progress` from the latest transcode job (READY → 100), `thumbnail_url` when present. `private, no-store`. |
| `PUT /v1/videos/{id}/moderation` | moderator, admin | Hide or restore a video (task S4): see *Moderation*. `200` Video with `moderation`, `400`, `401`, `403`, `404`. |
| `POST /v1/videos/{id}/views` | optional | Report one qualified playback (task C3): see *View counter*. `202 {counted}`, `400`, `404`, `429`. |
| `GET /internal/media-access/{id}` | none | **Infrastructure only** (task SEC1, ADR-017): nginx `auth_request`. `204` if the public may fetch the video media, `403` otherwise. See *Media access*. |
| `GET /v1/search?q=` | optional | Video search (task SR1): see *Search*. `VideoPage` ordered by relevance, `400`, `429`. |
| `GET /v1/search/suggest?q=` | optional | Up to 8 distinct title suggestions (task SR1): see *Search*. `200 {items}`, `400`, `429`. |

### Visibility (who sees what by id)

| Video | anonymous / other user | owner, moderator, admin |
|---|---|---|
| READY + PUBLIC | 200 | 200 |
| READY + UNLISTED | 200 (by id only, never listed) | 200 |
| READY + PRIVATE | **404** | 200 |
| not READY (UPLOADING … FAILED) | **404** | 200 |
| owner not ACTIVE (suspended/deleted) | **404** | 200 (placeholder owner `deleted_user`) |
| **HIDDEN** by a moderator (any visibility) | **404** | 200, `Cache-Control: private, no-store` |

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

### View counter

`POST /v1/videos/{id}/views` with `{playback_id, watched_ms}` (the player calls it once per playback). Rules, in the order they are applied:

1. **Rate limit**: 60 reports per minute per client IP (`VIEW_RATE_LIMIT`), fixed window in Valkey; over it → `429` with `Retry-After` (seconds until the window ends). Checked first, before PostgreSQL is touched.
2. **Validation**: `playback_id` a UUID, `watched_ms` an integer in `0..86_400_000`, no other field → `400` problem+json.
3. **Readable and READY**: same visibility as `GET /v1/videos/{id}` (owner, moderator and admin see all, everyone else only READY PUBLIC/UNLISTED) **and** status READY, otherwise `404`. The owner can count on their own PRIVATE video; nobody counts on a video that is not READY.
4. **Threshold**: `watched_ms >= min(30 000, duration_ms / 2)`, otherwise `202 {"counted": false}`.
5. **Dedup**, in one atomic Lua script (a playback is never marked as seen without its view being buffered): `views:pb:{playback_id}` `SET NX PX 30 min` (a retry counts at most once) and `views:seen:{video_id}:{viewer}` `SET NX PX 30 min` (one view per viewer per video per 30 minutes; `VIEW_DEDUP_TTL`). The viewer is `u:{user_id}` when authenticated, otherwise `a:` + sha256(client IP + `User-Agent`).
6. Counted: `HINCRBY views:pending {video_id} 1` and `202 {"counted": true}`. The response never says why a report was not counted.

**Client IP.** `X-Forwarded-For` is honoured only when the TCP peer is in `TRUST_PROXY_CIDRS`, with the same semantics as auth-svc (Fastify/proxy-addr): the header is read from the right, trusted hops are skipped and the first untrusted address is the client; entries to its left are client supplied and ignored. A peer that is not trusted cannot choose its address.

**Flusher** (one goroutine per replica, safe with any number of replicas). Every `VIEW_FLUSH_INTERVAL` (and once at startup, and once more on shutdown):

1. list leftover `views:flush:*` keys (a failed write, or a replica that died) and `RENAME views:pending views:flush:{uuid}` (atomic; "no such key" = nothing to do; reports arriving meanwhile start a new hash);
2. for each batch take the lock `views:flushlock:{uuid}` (`SET NX PX VIEW_FLUSH_LOCK_TTL`; another replica holding it means skip, a dead holder frees it by TTL), read it with `HGETALL`;
3. **one** statement/transaction: `UPDATE media.videos v SET view_count = v.view_count + d.n FROM unnest($1::uuid[], $2::bigint[]) d(id, n) WHERE v.id = d.id` (videos that were deleted match no row);
4. on success `DEL` the batch (retried); on failure keep it and retry on the next tick: **a view is never lost**. Malformed entries are logged and dropped.

Delivery is *at least once*: a crash after the PostgreSQL commit and before the `DEL` would apply that one batch again on restart (over-count of at most one batch per crash); the opposite order would lose views, which the contract forbids.

**Caveats.** (a) `view_count` is eventually consistent: up to `VIEW_FLUSH_INTERVAL` plus `CACHE_TTL` (the `GET` cache is **not** invalidated by the flusher; it relies on `CACHE_TTL`, 30 s). (b) The flush **does bump `updated_at`**: the table's `set_updated_at` trigger sets it unconditionally and video-svc may not change the schema (tracked with the architect). (c) Valkey is assumed to be a single node (the count script touches three keys). (d) With `VALKEY_URL` empty nothing is counted (`202 {"counted": false}`).

**Valkey down** never causes a `5xx`: reports get `202 {"counted": false}`, counted in `video_views_total{result="valkey_down"}`; the flusher logs the error and retries. Valkey calls use 200 ms timeouts, no client retries and a 5 s circuit breaker.

| Variable | Default | Description |
|---|---|---|
| `TRUST_PROXY_CIDRS` | `10.42.0.0/16,127.0.0.1` | Peers allowed to set `X-Forwarded-For` (CIDRs or addresses, comma separated) |
| `VIEW_RATE_LIMIT` | `60` | Reports per client IP per minute |
| `VIEW_DEDUP_TTL` | `30m` | One counted view per viewer per video, and per `playback_id`, in this window |
| `VIEW_FLUSH_INTERVAL` | `30s` | Flusher period |
| `VIEW_FLUSH_LOCK_TTL` | `2m` | How long a replica holds a batch; must exceed one database write (30 s timeout) |

| Metric | Type | |
|---|---|---|
| `video_views_total{result}` | counter | `counted`, `duplicate`, `below_threshold`, `hidden`, `rate_limited`, `valkey_down` |
| `video_view_flush_seconds` | histogram | Flush passes that had a batch to apply |
| `video_view_flush_errors_total` | counter | Failed flush steps (each is retried on the next tick) |

### Search

`GET /v1/search?q=` and `GET /v1/search/suggest?q=` (task SR1, migration 000007). Results never depend on the caller (optional auth is only there so a signed-in client is not rejected): a video is a result exactly when it is in the public feed.

**Folding happens in SQL**, never in Go: the query text is passed as `$1` and folded with `public.winkey_fold($1)` (lower-case + `unaccent`, so `ha noi` finds `Hà Nội`, `da lat` finds `Đà Lạt`), the same `IMMUTABLE` function the index expressions use, so the expressions match the indexes.

1. **Full text**: `v.search_vector @@ plainto_tsquery('simple', public.winkey_fold($1))`, ranked by `ts_rank_cd(v.search_vector, …)` (title weight A beats description weight B). Every word must match.
2. **Typo fallback**, only when the **first** page of step 1 is empty: `public.winkey_fold(v.title) % public.winkey_fold($1)` with `SET LOCAL pg_trgm.similarity_threshold = 0.3` (per transaction), ranked by `similarity()`.

Both statements repeat the predicate of the partial indexes literally, `status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE'`, so the planner can use `videos_search_fts` / `videos_search_title_trgm`, and inner-join `auth.public_profiles` like the feed (owners who are not ACTIVE are not listed). One statement per page, no per-item lookup. A test runs `EXPLAIN (FORMAT JSON)` on both statements and requires a Bitmap Index Scan on the partial index (with sequential scans discouraged, because a test table is tiny), plus a control that the same statement *without* the moderation predicate does not use it, so drift in the folding or the predicate fails the build.

**Paging.** Order `(rank DESC, published_at DESC, id DESC)`; the keyset condition compares the rank expression, so items with an equal rank (identical titles) are neither skipped nor repeated. The cursor is HMAC-signed like the others and carries the **mode** (`fts` or `trgm`, so page 2 never switches modes), the **rank as float4 bits** (exact), `published_at` in microseconds, the id and the **page number**. The MAC covers the trimmed `q`: a cursor replayed with another `q`, on another endpoint or with another secret is `400 INVALID_CURSOR`. At most **10 pages** are served per query; the 10th has `next_cursor: null`. `limit` 1-100 (default 24).

**Input.** `q` is trimmed; 1-100 characters for search, 2-50 for suggest (characters, not bytes); invalid UTF-8 or a NUL byte → `400`.

**Suggest.** Up to 8 titles, distinct by folded title: prefix matches (`winkey_fold(title) LIKE folded_q || '%'`, with `\`, `%` and `_` in `q` escaped, so they are text) first, then trigram similarity (threshold 0.3); ties by similarity, then `view_count`.

**Rate limit** per client IP (same `TRUST_PROXY_CIDRS` rules as the view counter), one Valkey counter per endpoint: 60/min for search (`SEARCH_RATE_LIMIT`), 120/min for suggest (`SUGGEST_RATE_LIMIT`), over it `429` + `Retry-After`. The limit is checked first (before validation and PostgreSQL) and **fails open** when Valkey is down or `VALKEY_URL` is empty. `Cache-Control: public, max-age=30` (search) / `60` (suggest) on `200`.

**Logging.** The text of `q` is user input and is never logged (the request log records the path only): the handler logs `q_len`, the mode, the page and the hit count at debug level.

| Metric | Type | |
|---|---|---|
| `video_search_total{mode}` | counter | `fts`, `trgm` (fallback), `empty` (no result), `rate_limited` |
| `video_search_seconds` | histogram | Time spent in the database for one search page |

### Media access (SEC1, ADR-017)

Media is served by nginx on `media.winkey.vn`. A video is **publicly watchable** when it is `READY`, `PUBLIC` or `UNLISTED`, `moderation_state = VISIBLE` and its owner is in `auth.public_profiles` (`domain.PubliclyWatchable`; the SQL of `Store.MediaPublic` says the same).

**Plain URLs** (`MEDIA_BASE_URL/v/{id}/…`) work only for publicly watchable videos: nginx asks `GET /internal/media-access/{video_id}` and caches the answer 30 s per id.

**Signed URLs.** For a video that is *not* publicly watchable, the callers allowed to see it (owner, moderator, admin) get `playback.hls_url` / `thumbnail_url` (and the studio `thumbnail_url`) as

```
MEDIA_BASE_URL + "/s/" + {expires} + "/" + {sig} + "/" + {object key}
expires = now + 6 h (Unix seconds), also returned as playback.expires_at (RFC 3339)
sig     = base64url-without-padding( md5( "{expires}/v/{video_id}/ {MEDIA_LINK_SECRET}" ) )
```

which is exactly what nginx checks with `secure_link_md5 "$secure_link_expires/v/$vid/ $media_link_secret"` (the space before the secret is part of the string). There is one signing function (`api.signMediaURL`) and a golden test with a fixed secret, time and id. Publicly watchable videos keep plain URLs, no `expires_at`, and stay cacheable; a response carrying signed URLs is `Cache-Control: private, no-store` (this now also applies to a READY PUBLIC video whose owner is no longer active, which a moderator can still open). The player refetches the video before `expires_at`. A signed link is shareable for 6 hours (bound to the video, not the user); MD5 is nginx's only `secure_link` hash, acceptable because the secret comes last and links expire.

**`MEDIA_LINK_SECRET`**: required, at least 32 bytes; the same value as the nginx of `media.winkey.vn` (Ansible, vault, never git). It is never logged and never echoed by config validation. Rotating it invalidates outstanding signed URLs (clients refetch) - rotate both sides together.

**`GET /internal/media-access/{video_id}`**: `204` if publicly watchable, `403` for everything else **including unknown ids** (never `404`, so it does not reveal what exists), `400` for a malformed id (canonical UUID only). No body, no identity headers read, ONE primary-key query joined to `auth.public_profiles`, `Cache-Control: max-age=30` on both answers. It is mounted outside `/v1` and **must never be routed publicly**: Traefik exposes it only for the internal Host `media-auth.internal` (SEC1-b). It is hot, so it is logged at debug (`httpx.AccessLog` logs every `/internal/*` route at debug, errors at error); metric `video_media_access_total{result=allow|deny}`.

### Moderation

`PUT /v1/videos/{id}/moderation` with `{"state": "HIDDEN" | "VISIBLE", "reason"}` (task S4, ADR-016). Only `moderator` and `admin` (from `X-User-Roles`, checked before anything is read: anonymous `401`, everyone else `403`, also for ids that do not exist).

- `HIDDEN` needs a `reason` (1-500 characters after trimming, else `400`); `VISIBLE` clears it (a reason sent with it is ignored). Media objects are not deleted.
- **Same state again is a no-op**: `200`, the row is not touched (the first reason, moderator and time stay) and **no event** is emitted.
- The row update (`moderation_state`, `moderation_reason`, `moderated_by`, `moderated_at`) and the `video.moderated` outbox row (`video_id`, `owner_id`, `state`, `moderator_id`) are written in **one transaction**. The row is locked (`FOR UPDATE`), so concurrent identical requests produce exactly one change and one event.
- **HIDDEN = PRIVATE for everyone but the owner, moderators and admins**: `404` on `GET /v1/videos/{id}`, absent from `GET /v1/videos` (feed and `owner_id` channel page, also for the owner; the studio is where they see it), never publicly cached, and **not counted**: `POST .../views` answers `404` to outsiders (the video is not readable for them, exactly like `GET`) and `202 {"counted": false}` to the owner, moderators and admins (`video_views_total{result="hidden"}`).
- **`moderation` `{state, reason, moderated_at}`** is in `Video` and `StudioVideo` only for the owner, moderators and admins (always, also while `VISIBLE`: `reason` and `moderated_at` are then `null`, or the time of the last restore); nobody else ever sees the key. Moderators and admins can still `GET` a hidden video, so a moderation screen can review it.
- **Cache**: `PUT` invalidates the entry in this replica; other replicas serve their copy for at most `CACHE_TTL` (30 s), the same bound as `PATCH visibility=PRIVATE`. The cached record is viewer independent and visibility is applied after reading it, so a cached hidden video is still `404` for outsiders.
- Not done here (other owners): the `social.videos.hidden` projection, reports, the web UI, blocking media downloads (signed cookies, SEC1).

### Cache (optional)

With `VALKEY_URL` set, `GET /v1/videos/{id}` caches the **viewer-independent record** (video + owner + renditions) for `CACHE_TTL` (30 s); visibility is applied after reading it, so one entry serves every viewer and a cached PRIVATE video is never leaked. `PATCH`/`DELETE` invalidate the entry in-process (other replicas see the change when their copy expires) and always decide authorisation from the database, never from the cache. The cache **fails open**: short timeouts, no client retries and a 5 s circuit breaker, so a Valkey outage costs nothing per request. It is not a readiness dependency.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL (role `media_svc`) |
| `NATS_URL` | required | JetStream for the outbox relay |
| `MEDIA_BASE_URL` | required | Prefix for playback/thumbnail/avatar URLs, e.g. `https://media.winkey.vn` |
| `MEDIA_LINK_SECRET` | required | ≥ 32 bytes; signs media URLs of non-public videos, shared with nginx; never logged |
| `CURSOR_SECRET` | required | ≥ 16 characters; signs pagination cursors; same value on every replica |
| `S3_MEDIA_BUCKET` | `winkey-media` | Bucket named in `video.deleted` |
| `VALKEY_URL` | empty (disabled) | e.g. `redis://valkey:6379/0` |
| `CACHE_TTL` | `30s` | |
| `TRUST_PROXY_CIDRS`, `VIEW_RATE_LIMIT`, `VIEW_DEDUP_TTL`, `VIEW_FLUSH_INTERVAL`, `VIEW_FLUSH_LOCK_TTL` | see *View counter* | View counter (needs `VALKEY_URL`) |
| `SEARCH_RATE_LIMIT` | `60` | Searches per client IP per minute (needs `VALKEY_URL`) |
| `SUGGEST_RATE_LIMIT` | `120` | Suggestions per client IP per minute (needs `VALKEY_URL`) |
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
