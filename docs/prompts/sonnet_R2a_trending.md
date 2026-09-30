# Kickoff — Sonnet 5.5 · Task R2-a (trending feed v1)

Starts after V5b (#91, merged). ADR-020, migration 000011 (`media.video_views_hourly`, `media.trending`) and the
contract (`listVideos` `sort=trending`, `INVALID_SORT`) are on main.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-r2a -b agent/sonnet/r2a-trending origin/main
READ FIRST: docs/DECISIONS.md ADR-020, db/migrations/000011_trending.up.sql, contracts/openapi/video.v1.yaml
(listVideos description + `sort`), services/video (views/flusher.go + store AddViews, the public-feed filter used by
listVideos/search, cursor package, cache headers).
You own: services/video, libs/go. Branch: agent/sonnet/r2a-trending.

# TASK R2-a — implement exactly
1. store.AddViews: in the SAME transaction as the view_count update, upsert
   media.video_views_hourly (video_id, date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', n)
   ON CONFLICT DO UPDATE SET views = views + EXCLUDED.views — one batched statement (unnest), only for ids that
   still exist (deleted videos must not fail the batch: join media.videos).
2. Trending job in video-svc (config TRENDING_INTERVAL default 10m, TRENDING_ENABLED default true):
   - every interval, one replica runs it (pg_try_advisory_xact_lock inside the transaction; others skip);
   - score = SUM(views * power(0.5, extract(epoch from (now() - hour)) / 86400)) over hour >= now() - 72h;
   - eligible = the exact public-feed predicate (PUBLIC, READY, VISIBLE, owner in auth.public_profiles);
   - drop score < 1, keep top 200 ordered by score DESC, id DESC (stable ties), rank 1..N;
   - DELETE FROM media.trending + INSERT the new ranking in ONE transaction; log count + duration at info;
     metric video_trending_recompute_seconds (histogram) and video_trending_size (gauge);
   - retention: DELETE FROM media.video_views_hourly WHERE hour < now() - interval '8 days' (same run, batched).
3. listVideos sort=trending: read media.trending JOIN media.videos (+ owner profile) ORDER BY rank, cursor = last
   rank (opaque, reuse the cursor package), limit as today; re-apply the public-feed predicate at read time (a
   video made PRIVATE/HIDDEN since the last run must not appear); Cache-Control public, max-age=60;
   owner_id + trending → 400 INVALID_SORT; unknown sort → 400 (contract enum). sort=newest unchanged.
4. README: the job, its config, the formula, the metrics.

# DEFINITION OF DONE
- Unit: score formula (a view now = 1.0, 24 h old = 0.5, 72 h+ excluded), tie ordering, cursor paging.
- Integration on real PostgreSQL 17 (WINKEY_REQUIRE_DOCKER=1, 0 skipped):
  - flush writes the hourly bucket in the same transaction (a failed transaction leaves neither);
  - a deleted video in a batch does not fail the batch;
  - the ranking orders a video with many old views below one with fewer fresh views, as the formula says;
  - PRIVATE / HIDDEN / suspended-owner videos are excluded both at compute time and at read time;
  - two concurrent recomputes → one runs, the table is never empty mid-way (a reader in a parallel
    transaction sees the old or the new ranking, never a mix);
  - retention deletes buckets older than 8 days;
  - Spec.Check on every response (including 400 INVALID_SORT).
- go vet, golangci-lint, go test -race, arm64 build, `GOWORK=off go build ./...` in services/video (the image
  builds standalone — see #91). PR = Handoff Report with real output.

# OUT OF SCOPE
Web UI (Antigravity 1 adds a "Thịnh hành" tab later), likes in the score, personalization (R2 full), any
contract or migration change (→ contract-change issue).
````
