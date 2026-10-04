# video-svc

Video metadata, public feed, watch-page data and the creator's studio list. Implements [`contracts/openapi/video.v1.yaml`](../../contracts/openapi/video.v1.yaml); emits `video.deleted`, `video.moderated` and `video.visibility_changed` through the transactional outbox (ADR-008). Owner: Sonnet 5.5 (task S1).

## Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /v1/videos?sort=trending` | optional | The trending ranking (task R2-a): see *Trending*. `limit`, `cursor`; `owner_id` together with it is `400 INVALID_SORT`; `Cache-Control: public, max-age=60`. |
| `GET /v1/videos` | optional | Public feed: **READY + PUBLIC** only, newest first, keyset pagination on `(published_at DESC, id DESC)` (partial index `media.videos_public_feed`). `limit` 1-100 (default 24), `cursor`, `owner_id` (channel page). UNLISTED and PRIVATE videos are never listed, not even for their owner (the studio is for that). |
| `GET /v1/videos/{id}` | optional | Watch page. Visibility below. `Cache-Control: public, max-age=30` for PUBLIC READY, `private, no-store` otherwise. `playback` is `null` unless READY. |
| `PATCH /v1/videos/{id}` | required | Owner only. `title` 1-100, `description` ≤ 5000, `visibility`; unknown fields and `{}` → 400. When the visibility **actually changes** it also enqueues `video.visibility_changed`: see *Events*. |
| `DELETE /v1/videos/{id}` | required | Owner, moderator or admin. **One transaction**: delete the row (cascades to renditions and jobs) + enqueue `video.deleted` (`raw_bucket`, `raw_key`, `media_bucket`, `media_prefix = v/{id}/`). The transcoder's media janitor purges the objects. |
| `GET /v1/studio/videos` | required | The caller's videos in every status, keyset on `(created_at DESC, id DESC)` (index `media.videos_owner_created`), optional `status` filter, `progress` from the latest transcode job (READY → 100), `thumbnail_url` when present. `private, no-store`. |
| `PUT /v1/videos/{id}/moderation` | moderator, admin | Hide or restore a video (task S4): see *Moderation*. `200` Video with `moderation`, `400`, `401`, `403`, `404`. |
| `POST /v1/videos/{id}/views` | optional | Report one qualified playback (task C3): see *View counter*. `202 {counted}`, `400`, `404`, `429`. |
| `GET /internal/media-access/{id}` | none | **Infrastructure only** (task SEC1, ADR-017): nginx `auth_request`. `204` if the public may fetch the video media, `403` otherwise. See *Media access*. |
| `PUT /v1/videos/{id}/subtitles/{lang}` | required | Owner only: create or replace the WebVTT track of one language (task V5b). `201` created / `200` replaced, `SubtitleTrack`; `400` `INVALID_WEBVTT` / `SUBTITLE_TOO_LARGE` / `VALIDATION_ERROR`, `403`, `404`, `409` `TOO_MANY_SUBTITLES` / `VIDEO_FAILED`. See *Subtitles*. |
| `DELETE /v1/videos/{id}/subtitles/{lang}` | required | Owner only: remove a track. `204`, `403`, `404` (also when there is no track for that language). |
| `GET /v1/feed/subscriptions` | required | The newest public videos of the channels the caller follows (task R2-b): see *Subscription feed*. `VideoPage`, `limit`, `cursor`; `401` without identity; `Cache-Control: private, no-store`. |
| `GET /v1/feed/recommended` | optional | Recommended videos (R2-v, ADR-028): see *Recommended feed*. `limit` 1..50 (default 20), opaque `cursor`. |
| `POST /v1/playback/heartbeats` | optional | Player QoE and watch-time samples (task R1, ADR-022): see *Playback analytics*. `202 {accepted}`, `400`, `413`, `429`. |
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

### Events (transactional outbox, stream `VIDEO`)

| Event | Emitted when | `data` |
|---|---|---|
| `video.deleted` | `DELETE /v1/videos/{id}` removes the row | `video_id`, `owner_id`, `raw_bucket`, `raw_key`, `media_bucket`, `media_prefix` |
| `video.moderated` | `PUT .../moderation` **changes** the state | `video_id`, `owner_id`, `state`, `moderator_id` |
| `video.visibility_changed` (task C4) | `PATCH /v1/videos/{id}` **changes** the visibility | `video_id`, `owner_id`, `visibility` (the new value) |

`video.visibility_changed`: `UpdateVideo` runs in ONE transaction. It locks the row (`FOR UPDATE`), applies the update with `RETURNING visibility`, and enqueues the event in the same transaction only when the value differs from the one it replaced, so the change and its event commit together or not at all (an outbox failure rolls the whole update back, a `500`). **No event** for a no-op (the same visibility again), for an edit of `title`/`description` only, or for a request that fails (`400`, `401`, `403`, `404`); several concurrent identical requests produce one event (the lock serialises them). social-svc projects it into `social.videos.visibility` to close comments and likes of a `PRIVATE` video. `video.ready` (written by the transcoder) carries the visibility the row has when it becomes READY.

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

**Storyboard (V5a).** `playback.storyboard_url` is the media URL of `media.videos.storyboard_key` (the WebVTT seek-preview track written by the transcoder; `null`, never absent, when the video has none). It is signed exactly like `hls_url` (same function, same `expires_at`) when the video is not publicly watchable. The track names its sprite sheets relatively (`sheet-001.jpg#xywh=x,y,160,90`), so the sheets resolve under the same signed prefix and need no URLs of their own.

**`MEDIA_LINK_SECRET`**: required, at least 32 bytes; the same value as the nginx of `media.winkey.vn` (Ansible, vault, never git). It is never logged and never echoed by config validation. Rotating it invalidates outstanding signed URLs (clients refetch) - rotate both sides together.

**`GET /internal/media-access/{video_id}`**: `204` if publicly watchable, `403` for everything else **including unknown ids** (never `404`, so it does not reveal what exists), `400` for a malformed id (canonical UUID only). No body, no identity headers read, ONE primary-key query joined to `auth.public_profiles`, `Cache-Control: max-age=30` on both answers. It is mounted outside `/v1` and **must never be routed publicly**: Traefik exposes it only for the internal Host `media-auth.internal` (SEC1-b). It is hot, so it is logged at debug (`httpx.AccessLog` logs every `/internal/*` route at debug, errors at error); metric `video_media_access_total{result=allow|deny}`.

### Subtitles (V5b, ADR-018)

`PUT /v1/videos/{video_id}/subtitles/{lang}` with `{"label": "Tiếng Việt", "content": "<the whole WebVTT file>"}`; `lang` is a short BCP 47 tag, `^[a-z]{2,3}(-[A-Z]{2})?$` (`vi`, `en`, `en-US`), `label` 1-50 characters (trimmed), at most **20 tracks** per video, one per language.

- **Who**: the owner only. A visible video the caller does not own is `403` (moderators and admins included), an invisible or unknown one `404`, anonymous `401`. A `FAILED` video is `409` `VIDEO_FAILED`; any other status is fine, so a track can be prepared while the video is processing (it is shown once the video is READY, because `Playback` only exists then).
- **Validation** (`internal/vtt`, a pure function with a table test and a fuzz test): at most 524288 **bytes** (`400 SUBTITLE_TOO_LARGE`, also for a request body above 4 MiB); valid UTF-8 and no NUL; an optional BOM, then a first line `WEBVTT` alone or followed by a space or tab and text (`WEBVTTX` is refused); blocks separated by blank lines; `NOTE`, `STYLE` and `REGION` blocks are allowed; a cue is an optional identifier line, a timing line `[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm[ settings]` with MM and SS below 60 and the end after the start (settings are `name:value` tokens), then any number of text lines; at least one cue. Failures are `400 INVALID_WEBVTT` whose `detail` is `line N: reason` (N counted from 1 in the file as sent; "no cue" points at the last line).
- **Normalisation** before storing: BOM removed, CRLF and CR turned into LF, lines that only hold spaces or tabs emptied, exactly one trailing newline. `size_bytes` is the size of the stored file.
- **Storage order**: (1) upload the normalised bytes to `S3_MEDIA_BUCKET` at `v/{video_id}/subtitles/{lang}-{uuidv7}.vtt`, `Content-Type: text/vtt; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable` (a NEW key on every upload, so an object is never overwritten and can be cached forever); (2) one transaction: `SELECT … FROM media.videos WHERE id = $1 FOR UPDATE` (the lock serialises the uploads of one video), a new language beyond 20 → `409 TOO_MANY_SUBTITLES` (replacing an existing language is always allowed), then `INSERT … ON CONFLICT (video_id, lang) DO UPDATE … RETURNING (xmax = 0)` to tell create (`201`) from replace (`200`); (3) if the transaction fails the object just uploaded is deleted; after the commit the replaced object is deleted. Both deletes are best effort (a `warn` log with the video id and key, never the content, and never an error for the caller); an orphan is harmless because it lives under `v/{id}/` and goes with the video.
- **Response**: `SubtitleTrack {lang, label, source: UPLOAD, url, updated_at}`, `Cache-Control: private, no-store`. `url` is plain for a publicly watchable video and **signed exactly like `hls_url`** (`signMediaURL`, SEC1) otherwise.
- **`Playback.subtitles`** is always present (empty array when none), sorted by `lang` (bytewise), on every response that carries `playback` (`getVideo`, `updateVideo`, `moderateVideo`): one extra query per video (`SELECT … FROM media.video_subtitles WHERE video_id = $1`), none for a video that is not READY, and no list carries playback, so there is no N+1. URLs are signed with the same `expires_at` as `hls_url` when the video is not publicly watchable. Put and delete invalidate this replica's cache entry; other replicas serve their copy for at most `CACHE_TTL` (as for `PATCH`).
- **Delete of the video**: the rows go with the video (`ON DELETE CASCADE`) and the objects with the `video.deleted` purge of `v/{id}/` (media janitor); a test runs that prefix delete against the bucket.
- No event is emitted (ADR-018). The player must show cues through the browser text track or hls.js, never `innerHTML` (the cue text is user input).

### Trending (R2-a, ADR-020)

`GET /v1/videos?sort=trending` reads the current ranking of `media.trending`, best first. `sort` is `newest` (the default, the feed above, unchanged) or `trending`; anything else is `400 VALIDATION_ERROR`, and `owner_id` together with `sort=trending` is `400 INVALID_SORT` (there is no per-channel ranking). Same `VideoPage` as the feed; `next_cursor` is the last **rank** returned (opaque, HMAC-signed like the others, bound to the endpoint: a feed cursor is `400 INVALID_CURSOR` here and the other way round). The ranking has at most 200 entries and may be empty (no recent views): the response is then an empty page, not an error, and the client shows the newest feed. `Cache-Control: public, max-age=60`, whoever calls.

**Read time.** The ranking is up to one interval old, so the read joins `media.videos` and `auth.public_profiles` and applies the exact predicate of the public feed again (`READY`, `PUBLIC`, `VISIBLE`, owner in the view) in the same statement: a video made `PRIVATE`, hidden or whose owner was suspended since the last run is never returned (its rank is just a gap). Paging while a recompute happens can show a video twice or skip one; read the ranking in one go if that matters (limit up to 100, 200 entries at most).

**Hourly buckets.** `store.AddViews` (the view flusher, C3) adds the counted views to `media.videos.view_count` AND to the bucket of the current **UTC hour** in `media.video_views_hourly` in ONE statement (`WITH upd AS (UPDATE … RETURNING) INSERT … ON CONFLICT (video_id, hour) DO UPDATE SET views = views + EXCLUDED.views`), so either both happen or neither. A video that no longer exists matches no row in the `UPDATE`, gets no bucket and does not fail the batch; the `UPDATE` also row-locks the matched videos until commit, so a concurrent delete cannot break the foreign key of the bucket.

**The job** (`internal/trending`, one goroutine per replica, at once at startup and then every `TRENDING_INTERVAL`, default 10 minutes; `TRENDING_ENABLED=false` switches it off on a replica, reads still work):

1. one transaction that starts with `pg_try_advisory_xact_lock(0x77696e6b65790001)`; a replica that does not get it skips the run (debug log) and touches nothing, so exactly one replica works at a time;
2. **score** = `Σ views × 0.5^(age / 24 h)` over the buckets of the last **72 hours** (`age` = `now() - hour`, the start of the bucket, so a view counted in the current hour is worth between 1.0 and about 0.97 and one of 24 hours ago about 0.5; `trending.Score` is the same formula in Go and a test compares them);
3. **eligible** = the exact public-feed predicate (`PUBLIC`, `READY`, `VISIBLE`, owner in `auth.public_profiles`); videos scoring **below 1** are dropped; the **top 200** by `score DESC, video_id DESC` (stable ties) get rank 1..N;
4. `DELETE FROM media.trending` + `INSERT` of the new ranking in the SAME transaction: a reader sees the old ranking or the new one, never an empty or mixed table; a failure rolls back and the old ranking stays;
5. after the commit, **retention**: `media.video_views_hourly` buckets older than 8 days are deleted in batches of 5000 until none is left (a failure is a warning, retried on the next run).

Note on the threshold: the age of a bucket is measured from its start, so a video with a single view in the current hour scores a little under 1 and is not ranked; two views are.

| Variable | Default | Description |
|---|---|---|
| `TRENDING_ENABLED` | `true` | Run the recompute job on this replica |
| `TRENDING_INTERVAL` | `10m` | Time between recomputes (at least 1 s when enabled) |

| Metric | Type | |
|---|---|---|
| `video_trending_recompute_seconds` | histogram | Duration of a recompute that ran (the replica that got the lock) |
| `video_trending_size` | gauge | Videos in `media.trending` after this replica's last run |
| `video_trending_recompute_errors_total` | counter | Runs that failed (the previous ranking stays) |

The run logs `trending recomputed` at info with `videos`, `duration` and `retired_buckets`.

### Subscription feed (R2-b, ADR-021)

`GET /v1/feed/subscriptions` returns the newest videos of the channels the caller follows: the public feed's predicate (`READY`, `PUBLIC`, `VISIBLE`) with the owner active, ordered `published_at DESC, id DESC`, as a `VideoPage`. Identity is required (`X-User-Id`; `401` otherwise). `limit` as for `listVideos`; the opaque `cursor` is the `(published_at, id)` keyset of the last item, HMAC-signed and bound to the endpoint **and the caller** (another user's cursor, or one from the public feed, is `400 INVALID_CURSOR`). No subscriptions is an empty page. The answer depends on the caller, so `Cache-Control: private, no-store`. A video made PRIVATE, hidden or whose owner is suspended leaves the feed at once: it reads the videos themselves.

**Why a projection.** The subscriptions live in social-svc's schema and ADR-007 forbids reading it from here, so video-svc keeps its own `media.subscriptions (subscriber_id, channel_id, subscribed_at)` (migration 000012, no cross-schema foreign key), built from `social.subscription.changed`. Migration 000012 also **backfilled** it once from `social.subscriptions`, because the SOCIAL stream only keeps 7 days.

**The consumer** (`internal/subscriptions`, one goroutine per replica): durable `video-subscriptions` on the stream `SOCIAL`, pull, `filter_subject: social.subscription.changed`, `deliver_policy: all`, `ack_policy: explicit`, `ack_wait: 30s`, **`max_ack_pending: 1`, `max_deliver: -1`**, created with `CreateOrUpdateConsumer` (a restart or a second replica reuses it). Each event is validated by hand against `envelope.schema.json` and `social.subscription.changed.schema.json` (unknown keys, missing or mistyped fields, a non-canonical UUID, a negative count all fail; a test compares this validation with the real schemas): a malformed event is `Term()`inated and counted, never redelivered and never blocks the next one; an event of a version this code does not know is acked and skipped; a subscription of a channel to itself is refused (the table forbids it). Valid events: `subscribed = true` -> `INSERT … ON CONFLICT DO NOTHING` with `subscribed_at` = the event's `occurred_at` (an existing row keeps its first date), `false` -> `DELETE`. Both are idempotent, so redelivery, duplicates and the replay of the whole stream after the backfill (or after the durable is re-created) leave the same rows **as long as the events of a pair are applied in stream order**, and that is enforced, not hoped for: `max_ack_pending: 1` makes JetStream hand out the next message only when the current one is acknowledged (and the consumer fetches one at a time), so a message that failed and was Nak'd (`NakWithDelay`, 10 s) is redelivered **before** any newer one; `max_deliver: -1` means a transient database error is never turned into a dropped change: the queue waits for the database, by design; `Term()` is only for malformed events, which can never succeed. Before that, a database error is also retried in-process (3 attempts, 200 ms doubling). (`contracts/events/README.md` still says `max_deliver: 5` for this durable; it predates this rule and should be updated by its owner.) The consumer keeps looking for the stream while it does not exist, so video-svc starts before social-svc is deployed. Metric `video_subscription_events_total{result}`: `subscribed`, `unsubscribed`, `malformed`, `ignored_version`, `error`. It is not a readiness dependency.

**Eventual consistency.** A new subscription appears in the feed when the consumer has applied its event, normally within a second or two; an unsubscribe disappears the same way.

**The query** reads, for each followed channel (one `auth.public_profiles` join per channel, so a suspended owner costs nothing), at most `limit + 1` of its newest public videos straight from the partial index `videos_owner_published (owner_id, published_at DESC, id DESC)` (a `LATERAL` subquery), and keeps the newest `limit + 1` of those candidates. A channel with thousands of videos therefore costs `limit + 1` index entries, not thousands. The store test plans it on 6000 videos of 60 channels (12 followed) without discouraging any scan type:

```
Limit
  Sort
    Nested Loop
      Nested Loop
        Seq Scan on users              (the owner join, per followed channel)
        Seq Scan on subscriptions      (the followed channels of one subscriber)
      Limit
        Index Scan on videos using videos_owner_published
```
A user that follows thousands of channels makes the query heavier (thousands of small index scans); accepted for the beta (ADR-021), fan-out on write is the way out later.

**NATS permission.** Creating the durable is a JetStream API call (`$JS.API.CONSUMER.*.SOCIAL.*`); the k3s `nats-auth` Secret (`deploy/k8s/data/secrets.sh`) lets the user `video` publish `$JS.API.>`, so it is allowed, and a pull consumer receives its messages on the caller's `_INBOX.>` (also allowed), not on the event subject. Nothing has to change for this to work. For symmetry with the like consumer (whose subject is in the `video` user's `subscribe` list) `social.subscription.changed` could be added there; it is not needed and I have not opened an issue for it.

### Playback analytics (R1, ADR-022)

`POST /v1/playback/heartbeats` takes a batch of 1 to 20 samples of the playbacks a player is running (`start` when the first frame shows, `heartbeat` about every 30 s, `end` when it stops; counters are **deltas** since the previous sample of the same playback) and publishes one `analytics.playback` v1 event per kept sample to the JetStream stream `ANALYTICS`; `analytics-worker` (`services/analytics`) writes them to ClickHouse on gpu-01. It never changes `view_count` (that stays with `recordView`, C3).

- **Order of checks**: rate limit (30 requests per minute per client IP, scope `heartbeat`, the limiter and `TRUST_PROXY_CIDRS` rules of `recordView`; `429` + `Retry-After`; fails open without Valkey) -> body at most **16 KiB** (`413 PAYLOAD_TOO_LARGE`) -> strict JSON (unknown fields, trailing data: `400 INVALID_JSON`) -> per-field validation of `PlaybackSample` (`400 VALIDATION_ERROR` naming `samples[i].field`; a single bad sample refuses the WHOLE batch and nothing is published) -> the lookup below. With `ANALYTICS_ENABLED=false` the answer is `202 {accepted: 0}` after validation, without lookup or publish.
- **Which samples are kept**: only those of a video that exists, is `READY` and that the caller may read (the `getVideo` rules: an outsider needs a public or unlisted, not hidden, active-owner video; the owner, moderators and admins also read private and hidden ones). The others are dropped silently (`video_analytics_samples_total{result="dropped_invalid_video"}`), the response only says how many were accepted. The videos of a batch are read with **one** query (`VideosForPlayback`, distinct ids) after the watch-page cache has been asked for each of them.
- **The event** (`contracts/events/analytics.playback.schema.json`): `event_id` = UUIDv5 of the fixed namespace `7c1f6a2e-4b9d-5e83-a0d4-2f8b1c6e9a35` and `"<playback_id>:<seq>"`, also sent as the `Nats-Msg-Id` header, so a sample the client sends again is de-duplicated by JetStream within the stream's window and later by ClickHouse; `owner_id` = the channel of the video; `received_at` = the server clock (UTC, what ClickHouse buckets on); `sent_at` = the client's; `viewer_key` = `hex(HMAC-SHA256(ANALYTICS_VIEWER_SALT, viewer))` where viewer is `u:<user id>` when authenticated and otherwise the anonymous hash of the view counter (`viewerKey`, the same function: it hashes IP + user agent, which is why the same anonymous viewer keeps one key); `authenticated`; `country` is always null. **The IP address and the user agent are never put in the event or its message id** (tests assert this, and the schema forbids extra fields).
- **Publishing** is asynchronous with a bounded window of 2000 unacknowledged messages on its own JetStream context: a handler waits at most to put the message on the wire. A refusal when handing over (window full), or later from the stream (no stream yet, no space, timeout), drops the sample and counts `publish_error` (a sample refused later was counted `published` first); it is never a `5xx`. If the video lookup itself fails the batch is dropped (`dropped_lookup_error`) with a `202`.
- **Metric**: `video_analytics_samples_total{result}` = `published`, `dropped_invalid_video`, `publish_error`, `dropped_lookup_error`.

| Variable | Default | Description |
|---|---|---|
| `ANALYTICS_VIEWER_SALT` | required | At least 32 bytes, a secret, never logged; fail fast at start. Changing it makes every viewer a new one |
| `ANALYTICS_ENABLED` | `true` | `false`: heartbeats are accepted and dropped |

### Batch get (PL1-v, ADR-024)

`GET /v1/videos/batch?ids=a,b,c` (optional auth; registered before `/v1/videos/{video_id}`) returns `VideoSummary` items for
1 to 50 distinct ids, in the order of `ids`. Bad, duplicate, missing or more than 50 ids give `400 VALIDATION_ERROR`
(field `ids`). A video is returned only when `getVideo` would return it to the caller right now (`domain.CanView`) and it
is READY; unknown or unreadable ids are left out silently, so `items` can be shorter than `ids`. Videos already in the
video cache are used as they are; ALL the others are read with ONE query (`id = ANY($1)`, `Store.VideosByID`) and are not
written to the cache (the row has no renditions or subtitles). Thumbnails of videos the public cannot watch (private, hidden)
are signed URLs. `Cache-Control` is `private, no-store` when authenticated, `public, max-age=30` otherwise. Metric:
`video_batch_get_ids` (histogram of ids per request).

### Creator statistics (R1-b, ADR-022 addendum)

`GET /v1/studio/videos/{video_id}/stats` (`getVideoStats`) and `GET /v1/studio/stats` (`getChannelStats`), authentication
required (401), `Cache-Control: private, no-store`, rate limit 60 requests/min per USER shared by both routes (429).
The first is for the owner or an admin; anyone else, and a missing or deleted video, gets 404 (never 403).

* Source: `analytics.video_daily` in PostgreSQL, refreshed from ClickHouse by analytics-worker every few minutes. video-svc
  never reads ClickHouse; while gpu-01 is off the numbers stop advancing and `refreshed_at` (the latest refresh of any
  returned day, null with no data) says how old they are.
* Range: `from`/`to` (`YYYY-MM-DD`, days in **Asia/Ho_Chi_Minh**). `to` defaults to today and is clamped to today, `from`
  defaults to `to` minus 27 days (28 days). `400 VALIDATION_ERROR` (field `from`/`to`) for a malformed date, `from > to`, more
  than 90 days, or `from` earlier than today minus 730 days. The zone comes from the embedded `time/tzdata` (distroless image).
* `days` holds EVERY day of the range in ascending order: days without a row are zeros and null ratios/percentiles.
* Numbers: `starts` counts player sessions; it is not `view_count` (the anti-fraud counter of C3, returned next to it).
  `avg_watch_ms` = floor(watch / starts), null when there is no start. `rebuffer_ratio` = rebuffer / (watched + rebuffer),
  null when both are 0. `viewers` (per video and day) is approximate (`uniq`) and not additive, so channel days and totals have none.
* Queries: one for a video (joined to `media.videos` for owner and `view_count`), at most two for the channel (days, top videos).
  Channel numbers join `media.videos` with `owner_id = caller`, so deleted or transferred videos never count.
  `top_videos`: at most 10 by `watch_time_ms`, then `starts`, then `video_id`; videos with no starts are left out.

### Related videos (R2-c, ADR-025)

`GET /v1/videos/{video_id}/related?limit=` (`listRelatedVideos`, optional auth, `limit` 1..24, default 12, else
`400 VALIDATION_ERROR` field `limit`). No personalisation: the answer is the same for every caller, so it is cached in Valkey
for 300 s per `(video_id, limit)` (fails open; a Valkey outage just recomputes) and sent with
`Cache-Control: public, max-age=300`. Metrics: `video_related_items` (histogram of items per answer),
`video_related_cache_total{result=hit|miss}`.

* The source must be a video the public could open: readable like `getVideo` AND READY, not PRIVATE and not hidden, even for its
  owner or an admin, otherwise `404` (the answer is shared and cached publicly).
* Candidates are only PUBLIC, READY, VISIBLE videos of active owners, never the source, never twice. Three short queries:
  1. similar (at most 8): `ts_rank(search_vector, q)` where `q` ORs the words of the source title (letters and digits, lower
     case, words shorter than 2 runes and duplicates dropped, at most 12, each quoted; folded in SQL by `winkey_fold`). It
     matches on `media.videos.search_vector` with the predicate of the partial index `videos_search_fts`, in an inner query on
     `media.videos` alone; the integration test shows its `EXPLAIN` (Bitmap Index Scan on `videos_search_fts`). A title without
     words skips this source;
  2. same channel (at most 4): the owner's newest videos;
  3. trending: `media.trending` by rank, `limit + 13` rows so that duplicates never leave the list short.
* Merge (`MergeRelated`, pure): the sources are taken in the fixed pattern 1, 1, 2, 1, 3 repeated; an empty source is replaced by
  the next source of the pattern; duplicates are skipped; the list stops at `limit` and can be shorter, even empty.

### Recommended feed (R2-v, ADR-028)

`GET /v1/feed/recommended` combines co-view history, followed channels and trending with weights `1.0`, `0.7` and
`0.3`. The viewer key uses the same `analytics.ViewerKey(ANALYTICS_VIEWER_SALT, "u:" + user_id)` as playback heartbeats.
The most recent 50 history entries contribute co-view scores with a seven-day half-life, normalized by the largest
eligible score. Subscription videos from the last 14 days have a 72-hour half-life; trending contributes
`1 - (rank - 1) / 200`. Ties use `published_at DESC, id DESC`; zero-score candidates supply the newest fill.
One PostgreSQL statement reads these signals in one snapshot. Watched videos (all persisted history), the caller's
videos and videos outside the public-feed predicate are excluded.

The diversity pass runs once before pagination: at each position, take the first remaining candidate whose channel
has fewer than two videos in the preceding nine positions; if none qualifies, take the first remaining candidate.
Candidates are deferred rather than dropped, including when every video belongs to one channel. Stop at 200 or
when the list is exhausted. The initial candidate query reads the full ordered list of lightweight IDs and channel
IDs: an early limit could remove the first compatible candidate. This is a beta-scale query; a large catalog will
need a streaming or indexed implementation that preserves this exact selection rule.

Signed-in lists use Valkey `reco:{user_id}:{list_id}` for ten minutes. The HMAC cursor carries `{list_id, offset}` and
is bound to the user and endpoint. A missing/expired list or unavailable Valkey recomputes it and continues at the
same offset; changing signals can then cause duplicates or omissions, as allowed by ADR-028. Cached page reads
recheck public visibility, owner activity, ownership and history, so a newly hidden or watched video is omitted.
The response uses `private, no-store`. Anonymous requests use trending then newest, never access Valkey, and return
`public, max-age=60`. Empty pages use `items: []`; the final page has `next_cursor: null`.

No new environment variables: `ANALYTICS_VIEWER_SALT`, `CURSOR_SECRET`, `DATABASE_URL` and optional `VALKEY_URL` apply.
Metrics: `video_reco_requests_total{mode="personal|fallback|anonymous"}` counts successful responses, and
`video_reco_compute_seconds` measures list computation on cache misses. PostgreSQL/Valkey integration fixtures
validate exact ranking, the heartbeat key, exclusions, diversity across page boundaries, expiry, cold start and the
200-item cap against the OpenAPI contract:

```bash
WINKEY_REQUIRE_DOCKER=1 go test ./internal/integration -run TestRecommendedFeed -v
```

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
| `S3_ENDPOINT` | required | Garage endpoint (server-side calls only), e.g. `http://garage:3900` |
| `S3_REGION` | `garage` | |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | required | Key with write and delete access to `S3_MEDIA_BUCKET` (subtitle files); the secret is never logged |
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
