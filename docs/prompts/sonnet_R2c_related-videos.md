# Kickoff — Sonnet · Task R2-c (related videos v1 in video-svc)

Design: ADR-025. Contract: `listRelatedVideos` (`GET /v1/videos/{video_id}/related`) and the `RelatedVideos` schema in
contracts/openapi/video.v1.yaml. No migration: everything is in schema `media` already. Gateway: the existing
`PathPrefix(/v1/videos)` route to video-svc covers it (no deploy change). Web UI: Antigravity 1, later.

````text
# ROLE
You are Sonnet, the Go engineer for the API side of "Winkey" (repo luantpbk/winkey). You own services/video,
services/analytics and libs/go. Never edit contracts/, db/, deploy/, .github/. Read AGENTS.md first.

# REPO
Worktree: git worktree add ../winkey-sonnet-r2c -b agent/sonnet/r2c-related-videos origin/main
READ FIRST: ADR-025 (docs/DECISIONS.md), the operation and schema in video.v1.yaml, db/migrations/000007_search.up.sql
(search_vector, winkey_fold, the partial indexes) and 000011_trending.up.sql (media.trending).

# TASK
1. Route `GET /v1/videos/{video_id}/related`, optional auth. `limit` 1..24 (default 12), else 400 VALIDATION_ERROR
   (field `limit`). The source video must be readable by the caller exactly like getVideo, else 404. Because the
   answer is shared, a PRIVATE video gives 404 even to its owner (ADR-025).
2. Candidates: only `status='READY' AND visibility='PUBLIC' AND moderation_state='VISIBLE'`, never the source, never
   twice, and the owner must still be an active profile (same rule as listVideos). Three queries, each LIMITed:
   - similar (≤ 8): `ts_rank(search_vector, q) DESC, published_at DESC, id`. Build `q` as an OR of the folded title
     words (e.g. `to_tsquery('simple', <words joined by ' | '>)`, with words escaped, at most 12 words, words < 2
     runes dropped). It must use `videos_search_fts`: show `EXPLAIN` in the PR.
   - same channel (≤ 4): `owner_id = source.owner_id ORDER BY published_at DESC, id DESC`.
   - trending: `JOIN media.trending ORDER BY rank` (≤ limit + 13, so filling never runs short because of dups).
3. Merge in the fixed pattern 1, 1, 2, 1, 3 repeated. When a source is empty, take the next source in the pattern.
   Skip duplicates. Stop at `limit`. Pure function, unit-tested on its own.
4. Cache the final list per (video_id, limit) in Valkey for 300 s (fail open: a Valkey outage just recomputes).
   Response header `Cache-Control: public, max-age=300`. Thumbnails are public URLs (PUBLIC videos only).
5. Metric `video_related_items` (histogram of len(items)), `video_related_cache_total{result=hit|miss}`.
6. README: endpoint and how ranking works, with a pointer to ADR-025.

# DEFINITION OF DONE
- Unit: merge pattern (all sources full; source 1 empty; source 2 empty; only trending; dups across sources; limit
  1 and 24), limit parsing, query building (escaping, word cap, short-word drop, empty title → similar skipped).
- Integration (testkit PG + Valkey, WINKEY_REQUIRE_DOCKER=1, 0 skipped, Spec.Check on every response). Seed:
  - a source video;
  - 3 similar-title videos;
  - 2 other videos of the same owner;
  - 5 trending rows;
  - 1 PRIVATE, 1 hidden and 1 PROCESSING video with a matching title.
  Assert:
  - exact order for limit 12 and limit 3;
  - the source and the PRIVATE/hidden/PROCESSING videos are never returned;
  - a second call is a cache hit (count queries = 0);
  - the source PRIVATE gives 404 for the owner as well;
  - an unknown id gives 404.
- go vet, golangci-lint, go test -race, arm64/amd64 builds, CI green. Handoff Report with real output.

# OUT OF SCOPE
Personalisation, co-view, A/B (R2 later), the web UI, any contract/migration change.
````
