# Kickoff — Sonnet · Task R1-b (creator statistics: ClickHouse rollup → PostgreSQL → studio API)

Design: ADR-022, addendum "R1-b". Contract: `getVideoStats` and `getChannelStats` in
contracts/openapi/video.v1.yaml (tag `studio`). Migration 000015 (`analytics.video_daily`, tested in
db/tests/013_video_stats.sql). Roles and grants on the cluster, plus the PG env of the worker on gpu-01: Antigravity 2.
Web page: Antigravity 1, later.

````text
# ROLE
You are Sonnet, the Go engineer for the API side of "Winkey" (repo luantpbk/winkey). You own services/video,
services/analytics and libs/go. Sonnet 2 owns services/upload and services/transcoder. Never edit contracts/, db/,
deploy/, .github/. The architect (Claude Opus) reviews and merges your PRs. Read AGENTS.md first.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-r1b -b agent/sonnet/r1b-creator-stats origin/main
READ FIRST: ADR-022 with all its addenda (especially R1-b), db/migrations/000015_video_stats.up.sql,
db/clickhouse/0001_playback.sql (video_qoe_hourly and how to read it with the -Merge combinators), and the two
operations plus the StatsTotals/VideoStats*/ChannelStats* schemas in video.v1.yaml.

# PART A — analytics-worker: rollup (services/analytics)
1. New env:
   - `POSTGRES_URL` (required when `ROLLUP_ENABLED=true`, the default);
   - `ROLLUP_INTERVAL` (default 10m, range 1m..1h);
   - `ROLLUP_WINDOW_DAYS` (default 3, range 1..8);
   - `ROLLUP_BACKFILL_DAYS` (default 8, range 1..30; used once at start-up).
   pgx/v5 pool, max 4 connections. Add them to the README env table and .env.example.
2. Every run reads ONE ClickHouse query over the window of Asia/Ho_Chi_Minh days [today-(N-1) .. today]
   (today in Asia/Ho_Chi_Minh):
     SELECT video_id, any(owner_id), toDate(hour, 'Asia/Ho_Chi_Minh') AS day, sum(starts), sum(watched_ms),
            sum(rebuffer_ms), sum(errors), uniqMerge(viewers), quantilesMerge(0.5, 0.95)(startup_ms_q)
     FROM winkey.video_qoe_hourly
     WHERE hour >= <start of the first day in UTC>
     GROUP BY video_id, day
   Do not use FINAL: the -Merge combinators and sums are correct over unmerged parts. A day with no start that has
   a startup time → p50/p95 NULL; ClickHouse returns nan there, so map nan to NULL. Round the percentiles to integers.
3. Upsert into analytics.video_daily in batches of ≤ 1000 rows, each batch one statement
   (`INSERT … SELECT FROM unnest(…)` or COPY into a temp table + `INSERT … ON CONFLICT (video_id, day) DO UPDATE`),
   one transaction per run. Set `refreshed_at = now()` only on rows whose values changed
   (`WHERE (d.starts, …) IS DISTINCT FROM (EXCLUDED.starts, …)`), so `refreshed_at` means "last change".
4. Once a day (first run after 00:00 Asia/Ho_Chi_Minh): `DELETE FROM analytics.video_daily WHERE day < today - 730`.
5. Runs never overlap (single goroutine, ticker). A failed run logs, increments `analytics_rollup_errors_total`
   and is retried at the next tick. It never makes /readyz fail and never stops ingestion. Metrics:
   - `analytics_rollup_last_success_timestamp_seconds`;
   - `analytics_rollup_duration_seconds` (histogram);
   - `analytics_rollup_rows_upserted_total`.
6. Ingestion code is unchanged except for wiring the new loop.

# PART B — video-svc: getVideoStats / getChannelStats (services/video)
1. Routes exactly per contract under the existing studio auth:
   - authentication required (401 otherwise);
   - per-video: owner or admin; anything else, including missing or deleted videos, gets 404;
   - rate limit 60/min/user shared by both routes, using the existing limiter;
   - `Cache-Control: private, no-store`.
2. Range parsing:
   - `to` defaults to today (Asia/Ho_Chi_Minh) and is clamped to today;
   - `from` defaults to `to` minus 27 days;
   - 400 `VALIDATION_ERROR` (field `from`/`to`) for a malformed date, `from > to`, a range of more than 90 days,
     or `from` earlier than today minus 730 days.
   Load the timezone with `time.LoadLocation("Asia/Ho_Chi_Minh")` and import `time/tzdata`: the image is distroless.
3. getVideoStats: one query on analytics.video_daily for (video_id, day BETWEEN from AND to), joined to
   media.videos for the owner check and `view_count`. Fill every missing day with zeros and nulls.
   - totals = sums over the range;
   - avg_watch_ms = floor(watch / starts), null when starts = 0;
   - rebuffer_ratio = rebuffer / (watched + rebuffer), null when both are 0;
   - `refreshed_at` = max over the returned rows, null if none.
4. getChannelStats: `WHERE d.owner_id = caller AND day BETWEEN …` with an INNER JOIN on media.videos
   (`v.owner_id = caller`), so deleted and transferred videos never count.
   - Days: summed, no `viewers`.
   - top_videos: ≤ 10 by watch_time_ms DESC, starts DESC, video_id; title from media.videos; videos with 0 starts
     are omitted.
   - Two queries at most.
5. README: endpoints, the env table if anything is new, and what the numbers mean (starts vs view_count, days in
   Asia/Ho_Chi_Minh, freshness).

# DEFINITION OF DONE
- Unit tests:
  - range parsing (defaults, clamp, each 400, the 90-day and 730-day edges);
  - day filling, totals, ratio/avg null rules, nan → NULL mapping in the worker;
  - the `IS DISTINCT FROM` upsert keeps `refreshed_at` when nothing changed.
- Integration (testkit PG + ClickHouse, WINKEY_REQUIRE_DOCKER=1, 0 skipped):
  1. Publish analytics.playback events for 2 videos of owner A and 1 video of owner B across 3
     Asia/Ho_Chi_Minh days. Include samples at 16:59:59Z and 17:00:00Z (the day boundary).
  2. Run the rollup and check every analytics.video_daily row against hand-computed values.
  3. Run it again: 0 rows changed and `refreshed_at` is unchanged.
  4. Through the HTTP handler with Spec.Check on every response:
     - A's video stats (owner) and as admin;
     - B and anonymous get 404 / 401;
     - channel stats of A include only A's videos and top_videos is in the right order;
     - deleting one of A's videos removes it from the channel stats.
- go vet, golangci-lint, go test -race, linux/amd64+arm64 builds for both modules, CI green including the
  analytics and video jobs. Handoff Report with real output.

# OUT OF SCOPE
Roles/grants, gpu-01 env and deployment (Antigravity 2); the web page (Antigravity 1); per-country or per-rendition
breakdowns; realtime numbers.
````
