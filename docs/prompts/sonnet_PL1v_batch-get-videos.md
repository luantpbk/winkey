# Kickoff — Sonnet 5.5 · Task PL1-v (batchGetVideos in video-svc)

Starts after R1 (#131) is merged — do not interleave. Design: ADR-024. Contract on main: `batchGetVideos`
(`GET /v1/videos/batch`) + schema `VideoBatch` in contracts/openapi/video.v1.yaml.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree: git worktree add ../winkey-sonnet-pl1v -b agent/sonnet/pl1v-batch-get-videos origin/main
READ FIRST: ADR-024, video.v1.yaml `batchGetVideos` (every rule in the description), the getVideo handler + cache.
You own: services/video, libs/go.

# TASK
1. Route `GET /v1/videos/batch` registered BEFORE `/v1/videos/{video_id}` (test that `/v1/videos/batch` never
   reaches getVideo). Optional auth.
2. `ids`: comma-separated, 1..50, valid UUIDs, no duplicates → otherwise 400 VALIDATION_ERROR (field `ids`).
3. Cache first (the getVideo cache), then ONE query for the misses (`id = ANY($1)`); keep only videos getVideo would
   return to this caller right now (READY, not HIDDEN, PRIVATE only for the owner, same `domain.CanView`).
   Return `VideoSummary` items in the order of `ids`; unreadable/unknown ids silently omitted.
4. `Cache-Control: private, no-store` when authenticated, `public, max-age=30` otherwise. Metric
   `video_batch_get_ids` (histogram of ids per request).

# DEFINITION OF DONE
- Unit + integration (testkit PG, WINKEY_REQUIRE_DOCKER=1, 0 skipped), Spec.Check on every response: order kept;
  PRIVATE video returned to the owner only; HIDDEN/non-READY/unknown omitted; 51 ids / duplicate / bad uuid / empty →
  400; anonymous vs authed Cache-Control; exactly one DB query for N cache misses (count queries).
- go vet, golangci-lint, go test -race, arm64/amd64 build, CI green. Handoff Report with real output.
````
