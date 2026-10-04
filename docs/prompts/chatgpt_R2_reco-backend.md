# Kickoff — ChatGPT · Task R2 (recommendation v1 "Dành cho bạn": worker job + feed endpoint)

Design: ADR-028 in docs/DECISIONS.md. Contract: `getRecommendedFeed` in contracts/openapi/video.v1.yaml. Migration
000018 (`analytics.video_coview`, `analytics.viewer_history`) and the grants are already merged by the architect.
Two PRs, in this order (one task per PR): **R2-w** (analytics-worker) then **R2-v** (video-svc). R2-v can start
before R2-w merges: it only reads the PG tables, and its tests fill them directly.

````text
# ROLE
You are "ChatGPT", acting owner of services/video, services/analytics and libs/go on Winkey (repo luantpbk/winkey).
Read AGENTS.md, then ADR-020, ADR-021, ADR-022 (with ALL its addenda, including #193), ADR-025 and ADR-028 in
docs/DECISIONS.md. Contracts are law; never edit contracts/, db/, deploy/.

# PART A — R2-w: the `reco` job in analytics-worker
Worktree: git worktree add ../winkey-gpt-r2w -b agent/gpt/r2w-reco-job origin/main
1. New package services/analytics/internal/reco, run from main like internal/rollup (its own goroutine and ticker;
   never blocks ingestion; never changes /readyz). Config (validate ranges, document in the README env table):
   RECO_ENABLED (true), RECO_INTERVAL (30m, 5m..6h), RECO_WINDOW_DAYS (30, 1..90), RECO_MIN_WATCH_MS (20000,
   1000..600000), RECO_NEIGHBORS (30, 1..100), RECO_HISTORY (50, 1..200).
2. ClickHouse (read only, exactly ADR-028):
   - qualified watches = per (viewer_key, video_id) over the window, sum(watched_ms) >= RECO_MIN_WATCH_MS, with
     duplicates removed by (video_id, playback_id, seq) (FINAL or an equivalent dedup — say which and why);
   - co-view over ALL viewers; score = co_viewers / sqrt(viewers(a) * viewers(b)); drop co_viewers < 3; keep the top
     RECO_NEIGHBORS per video by score (ties: co_viewers DESC, neighbor_id ASC). Both directions are stored.
   - history over authenticated viewers only: the RECO_HISTORY most recent qualified videos per viewer, with
     last_watched_at = max(received_at) and watched_ms = the summed watch time.
   Do the heavy lifting in ClickHouse SQL (self-join on the qualified set), not in Go memory. The SQL must run on
   ClickHouse 25.8 (gpu-01) AND 26.9 (CI testkit).
3. PostgreSQL: replace the whole content of BOTH tables in ONE transaction (DELETE, then COPY via pgx CopyFrom), set
   refreshed_at = the run start. A failed run rolls back and leaves the previous content.
4. Metrics: analytics_reco_runs_total{result}, analytics_reco_errors_total, analytics_reco_last_success_timestamp_seconds,
   analytics_reco_duration_seconds, analytics_reco_rows{table}. JSON logs, never a viewer_key in a log line.
5. Tests:
   - unit: config validation;
   - integration (testcontainers ClickHouse + Postgres, WINKEY_REQUIRE_DOCKER=1): a fixture with known viewers
     (3+ shared viewers → a pair; 2 shared → no pair; an anonymous viewer counts for co-view but gets no history;
     a viewer under the min watch time is ignored; duplicate events do not inflate watch time); exact expected rows
     and scores (float tolerance 1e-6); a second run with changed data replaces everything; a run that fails midway
     (e.g. PG unavailable at COPY) leaves the previous content intact.
DoD A: go vet, golangci-lint, go test ./... green locally and in CI; README updated; PR with real outputs.

# PART B — R2-v: `getRecommendedFeed` in video-svc
Worktree: git worktree add ../winkey-gpt-r2v -b agent/gpt/r2v-recommended-feed origin/main
1. Route GET /v1/feed/recommended, optional auth (X-User-Id from the gateway only). Implement ADR-028 "Phục vụ"
   EXACTLY: viewer_key with the SAME analytics.ViewerKey(salt, "u:"+userID) used by recordPlaybackHeartbeats;
   s_c / s_s / s_t; final = 1.0*s_c + 0.7*s_s + 0.3*s_t; exclusions (history, own videos, public-feed rule);
   diversity rule (deferred, never dropped); fill with newest; cap 200; tie order published_at DESC, id DESC.
2. Pagination: limit 1..50 (default 20); signed-in lists cached in Valkey `reco:{user_id}:{list_id}` TTL 10 min;
   opaque cursor {list_id, offset} (reuse internal/cursor if it fits); expired list → recompute, continue at offset;
   next_cursor null after 200. Anonymous: no Valkey, `Cache-Control: public, max-age=60`; signed-in:
   `private, no-store`. A malformed cursor → 400 problem+json.
3. Metrics video_reco_requests_total{mode=personal|fallback|anonymous}, video_reco_compute_seconds.
4. Tests (Postgres + Valkey via testcontainers; fill analytics.* tables directly):
   - ranking: a hand-computed fixture where co-view, subscription freshness and trending each change the order;
     exact expected id order;
   - exclusions: watched, own, PRIVATE/HIDDEN/not READY, suspended owner never appear;
   - diversity: 5 top-scored videos of one channel → never more than 2 in any 10 consecutive items, and none lost;
   - cold start: no history and no subscriptions → trending then newest; nothing at all → empty page;
   - pagination: pages concatenate to the same list with no duplicate; an expired list_id still returns 200;
     limit 51 → 400; response validates against the contract (the contract checker the service already uses);
   - viewer_key: a history row written with the R1 heartbeat path's key is found by the feed (same function).
DoD B: go vet, golangci-lint, go test ./... green locally and in CI; README (route, env, metrics); PR with real outputs.

# BOTH
Before every commit: git branch --show-current. Never touch contracts/, db/, deploy/ (gateway route `/v1/feed` already
goes to video-svc). Open each PR yourself with the Handoff Report; never merge.
````
