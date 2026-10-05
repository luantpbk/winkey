# Kickoff — ChatGPT · Takeover of the media pipeline + Task V4-b (upload segments while encoding)

**2026-10-05.** Sonnet 2 is paused. ChatGPT becomes **acting owner of `services/transcoder` and `services/upload`**
(in addition to `services/video`, `services/analytics`, `libs/go`). The first task is **V4-b** of ADR-031. Sonnet 2
finished V4-a (#236, stage metrics) and had not started V4-b: there is no branch to continue, start from `main`.

````text
# ROLE
You are "ChatGPT", acting owner of services/video, services/analytics, libs/go, services/transcoder and
services/upload on Winkey (repo luantpbk/winkey). Sonnet 2 (previous owner of transcoder/upload) is paused; you do not
coordinate with it. Hard rules: AGENTS.md (stay in your directories, never edit contracts/, db/, deploy/, one task per
branch/PR, never merge, never skip/weaken a test, check `git branch --show-current` before every commit).

# READ FIRST (in this order — the transcoder is new to you)
1. AGENTS.md.
2. docs/DECISIONS.md: ADR-003 (pull queue), ADR-006 (HLS CMAF output — must NOT change), ADR-015 (transcoder runs
   outside k3s on gpu-01, outbound only), ADR-017 (signed media), ADR-031 (V4 scope and WHY full-GPU/chunks/DASH are out).
3. docs/INFRASTRUCTURE.md §6 (gpu-01 measurements: NVENC saturates with 1 job, NVDEC slow while the GPU is shared).
4. services/transcoder/README.md end to end — especially "What it does per message", "Failure handling",
   "Heartbeat and stuck-job reconciler", "Media janitor", "Test", and the `init.mp4` naming note
   (FFmpeg may name init segments init_0.mp4, init_1.mp4…; always locate them through #EXT-X-MAP, never by name).
5. docs/prompts/sonnet-2_V4_transcode-latency.md — PART B is the spec of this task.
6. The V4-a code you build on: internal/job/steps.go (StepTiming, concurrency-safe `timings`), pipeline.go run(),
   internal/worker/metrics.go (transcoder_stage_seconds, transcoder_job_seconds, transcoder_upload_bytes_total).

# HOW THE TRANSCODER RUNS IN PRODUCTION (do not change these facts; ask the architect if you think you must)
- gpu-01 (home machine, Ubuntu, RTX 5060 Ti shared with a miner and ComfyUI), systemd service, user `winkey`.
- FFMPEG_PATH=/opt/ffmpeg-7.1/bin/ffmpeg (BtbN n7.1.5-12). Never rely on the system FFmpeg 8.0.
- HWACCEL_DECODE=false, WORKER_CONCURRENCY=1 (measured: CPU decode is faster while the GPU is shared).
- SCRATCH_DIR on NVMe, ARCHIVE_DIR on HDD; connects out over Tailscale to NATS 30422, Postgres 30432, Garage S3 30900.
- The code must keep building for GOOS=windows and linux/arm64 (CI checks it).
- You never deploy: Antigravity 2 does, after the architect merges.

# TASK — V4-b (exactly PART B of the V4 brief; summary)
Worktree: git worktree add ../winkey-gpt-v4b -b agent/gpt/v4b-overlap-upload origin/main
1. media/args.go: `-hls_flags independent_segments+temp_file`. Regenerate the goldens with `go test -update
   ./internal/media` and review the diff: ONLY that flag may change.
2. internal/job: while FFmpeg runs, a goroutine scans the HLS output dir (every 1 s or fsnotify) and uploads each
   finished `<variant>/seg_NNNNN.m4s` exactly once (never a `.tmp`), through the SAME UPLOAD_PARALLELISM limit as
   uploadAll (do not double the parallelism). After FFmpeg exits 0: remaining segments, the init segments, all
   variant playlists, `master.m3u8` LAST, then poster, storyboard, then commit READY. Record the upload step with the
   V4-a `timings` (one `upload` StepTiming covering the overlapped upload; keep `encode` as the FFmpeg wall time).
3. Archive copy runs in parallel with probe+encode and must finish before commit. Today an archive failure is logged
   and does NOT fail the video — keep that behaviour.
4. Failure / cancel: FFmpeg error, timeout, NVENC→x264 retry, or shutdown (SHUTDOWN_GRACE) → stop the scanner, wait for
   in-flight uploads, then the existing cleanup. **The NVENC→x264 retry re-encodes the same attempt**: segments
   uploaded by the failed NVENC run must be deleted (or overwritten) before the x264 run's uploads, so the attempt
   prefix never mixes encoders — test it. No partially uploaded attempt may ever become READY.
5. Progress bar semantics unchanged (download 0–5, probe 5, transcode 5–90, upload 90–99, 100 READY); the overlapped
   upload simply makes 90–99 shorter.

# TESTS (all must pass locally; paste real outputs)
- unit: the scanner never uploads `.tmp`, never uploads a segment twice, uploads master.m3u8 last; cancel stops it.
- real-FFmpeg tests in internal/job (they skip without ffmpeg — install a static ffmpeg locally so they RUN; say which).
- integration (WINKEY_REQUIRE_DOCKER=1, PostgreSQL + NATS + Garage testkit): the uploaded object set after V4-b is
  identical to before (same keys; same bytes for segments and playlists) on the flow fixtures; a forced FFmpeg failure
  leaves no READY row and the attempt prefix cleaned; the NVENC→x264 fallback path leaves only x264 segments.
- GOOS=windows go build ./... && GOOS=linux GOARCH=arm64 go build ./...
- Before/after numbers for the same clip from the V4-a metrics: transcoder_job_seconds and the upload stage.

# DEFINITION OF DONE
go vet, golangci-lint, go test ./... (and the Docker integration suite) green locally and in CI; README updated
("What it does per message" step 7 and the metrics section); PR with the Handoff Report and the real outputs above.
Lint-only cleanups go in a separate PR. Never merge. If anything in the spec conflicts with the code you find, stop and
open an issue for the architect (as you did in #208 and #227) instead of guessing.

# OUT OF SCOPE
Full-GPU, chunked encode, DASH, the x264-for-480p split (V4-c), any change to the HLS layout, services/upload changes
(you own it now, but there is no upload task yet).
````
