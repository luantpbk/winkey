# Kickoff — Sonnet 2 · Task V5a-b (storyboard backfill for videos made before V5a)

V5a (#86) makes a seek-preview storyboard for every NEW video. Videos that became READY before V5a, or whose
storyboard step failed (best effort), have `media.videos.storyboard_key IS NULL`, so the player shows no
preview when seeking. This task fills them in once, with a CLI in the transcoder module. No contract, migration
or event change: `Playback.storyboard_url` already exists and video-svc already signs it.

````text
# ROLE
You are "Sonnet 2", a Go engineer on "Winkey" (repo luantpbk/winkey). The architect (Claude Opus) reviews and
merges your PRs. Read AGENTS.md first and follow it exactly.
You own services/transcoder and services/upload. Sonnet (the other Go engineer) owns services/video,
services/analytics and libs/go: if you need a change there, open an issue and assign it to Sonnet; never edit it.
Never edit contracts/, db/, deploy/, .github/.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet2 -b agent/sonnet2/v5ab-storyboard-backfill origin/main
Before every commit: `git branch --show-current` must print agent/sonnet2/v5ab-storyboard-backfill.
READ FIRST: docs/prompts/sonnet_V5a_storyboard.md, db/migrations/000008_storyboard.up.sql,
db/migrations/000003_media.up.sql (media.videos, media.video_renditions, the status guard trigger),
services/transcoder/internal/job/{pipeline.go,storyboard.go}, internal/media/storyboard.go, internal/store,
internal/objects, and cmd/replay-dlq (the existing one-shot CLI: copy its config/logging style).

# TASK V5a-b — build (services/transcoder)
1. New binary `cmd/storyboard-backfill`, shipped in the existing transcoder images (cpu and nvenc) next to
   `transcoder` and `replay-dlq`. Same env config as the worker (DATABASE_URL, S3_*, FFMPEG path) plus:
   - `BACKFILL_LIMIT` (default 100, max 10 000): videos per run.
   - `BACKFILL_CONCURRENCY` (default 1, max 4): parallel ffmpeg runs; gpu-01 runs it with 1.
   - `--dry-run` flag: list what would be done, write nothing.
2. Selection: `status = 'READY' AND storyboard_key IS NULL`, ordered by `created_at DESC, id DESC` (newest
   videos first: they get watched most), keyset-paged, at most BACKFILL_LIMIT.
3. Per video, reuse the V5a code. Do not copy it: refactor into a shared function if needed, and keep
   pipeline behaviour unchanged.
   - Input = the same rendition V5a would choose (`media.StoryboardRendition` over the rows in
     media.video_renditions). Download that rendition's `index.m3u8`, init segment and media segments from the
     media bucket into a temp dir under the worker's scratch dir, then run `Tools.Storyboard` with
     `KeyframesOnly: true`. If no rendition qualifies, skip the video and log it. Never download the source.
   - Upload the sheets + storyboard.vtt under the SAME key prefix and naming the pipeline uses for new videos,
     with the same Content-Type and Cache-Control.
   - Then `UPDATE media.videos SET storyboard_key = $2 WHERE id = $1 AND status = 'READY' AND storyboard_key IS NULL`.
     If 0 rows were updated (the video was deleted or already has a storyboard), delete the objects you just
     uploaded.
   - Always remove the temp dir (defer), including on error and on SIGINT/SIGTERM.
4. Failures are per video: log (JSON, video_id, error class, ffmpeg stderr tail) and continue. Exit code 0 when
   the run finished (even with per-video failures), 1 on config/DB/S3 connection errors. Print a final summary
   line: selected, done, skipped_no_rendition, failed, lost_race, duration.
5. Idempotent and safe to re-run or interrupt at any point: a second run selects only what is still NULL.
   Never touch a video that is not READY.
6. README in services/transcoder: a "Storyboard backfill" section with the env table, a dry-run example, and the
   command for gpu-01: `docker run --rm --env-file … <transcoder-cpu image> storyboard-backfill`
   The binary goes in /usr/local/bin like replay-dlq: add it to both Dockerfile.cpu and Dockerfile.nvenc.

# DEFINITION OF DONE
- Unit tests: selection query order/paging, dry-run writes nothing, the lost-race path deletes the uploaded
  objects, temp dir removed on error.
- Integration test (testcontainers PG + Garage/MinIO as the existing transcoder integration tests do,
  WINKEY_REQUIRE_DOCKER=1, 0 skipped): seed 3 READY videos without a storyboard (real HLS renditions made by
  the existing test helpers), 1 READY video that already has one, 1 PROCESSING video. One run must:
  - storyboard exactly the 3;
  - make every sheet the .vtt refers to exist in the bucket;
  - leave the other two untouched.
  A second run must select 0.
- `go vet ./...`, `go test -race ./...` in services/transcoder; cross-build linux/amd64 and linux/arm64;
  CI green, including both transcoder image jobs.
- Open the PR yourself against main. The description is the Handoff Report
  (.github/pull_request_template.md) with real command output, including one real dry-run plus a real run
  against `make dev` with at least 2 videos, and `curl` of `GET /v1/videos/{id}` showing `storyboard_url`
  afterwards. No secrets in the PR.

# OUT OF SCOPE
Running it on production/gpu-01 (Antigravity 2 does that after merge), any contract/migration/event change,
regenerating storyboards that already exist, services/video.
````
