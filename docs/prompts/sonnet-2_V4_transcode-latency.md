> **2026-10-05:** V4-a merged (#236). Sonnet 2 is paused; **V4-b is reassigned to ChatGPT** — see
> [chatgpt_V4b_transcoder-takeover.md](chatgpt_V4b_transcoder-takeover.md). Part B below stays the spec.

# Kickoff — Sonnet 2 · Task V4 (shorter upload → READY: measure every stage, then overlap upload with encode)

Design: ADR-031 in docs/DECISIONS.md (read it first — it explains why full-GPU / chunked parallel / DASH are NOT in
scope). Two PRs, in order: **V4-a** (stage metrics) then **V4-b** (upload overlap). No contract, migration or output
format change.

````text
# ROLE
You are Sonnet 2, owner of services/upload and services/transcoder on Winkey (repo luantpbk/winkey). Read AGENTS.md,
ADR-006, ADR-015, ADR-031 and docs/INFRASTRUCTURE.md §6. Never edit contracts/, db/, deploy/.

# PART A — V4-a: measure every stage
Worktree: git worktree add ../winkey-sonnet2-v4a -b agent/sonnet-2/v4a-stage-metrics origin/main
1. In internal/job/pipeline.go time each stage of run(): download, archive, probe, encode, poster, storyboard,
   upload, commit. Add to Stats a per-stage duration map (or fields) and keep EncodeWall/TotalWall as today.
2. Metrics (internal/worker): histogram transcoder_stage_seconds{stage} (buckets suited to 0.1 s … 1 h),
   histogram transcoder_job_seconds (download start → READY), counter transcoder_upload_bytes_total. Observe only on
   success for job_seconds; stage_seconds also on failure for the stages that ran, with label result=ok|error.
3. One JSON log line per finished job: video_id, attempt, encoder, media_sec, renditions, upload_bytes and each stage
   duration in seconds. No user data.
4. Tests: unit test that a fake pipeline run records every stage once and in order; the metrics are registered once.
DoD: go vet, golangci-lint, go test ./... green; README (metrics table); PR with real outputs. Lint-only cleanups in a
separate PR.

# PART B — V4-b: upload segments while FFmpeg is still encoding
Worktree: git worktree add ../winkey-sonnet2-v4b -b agent/sonnet-2/v4b-overlap-upload origin/main (after V4-a merges)
1. media/args.go: `-hls_flags independent_segments+temp_file` (update the golden files; nothing else in the args
   changes — the ladder, segment length and names stay exactly as ADR-006).
2. internal/job: while FFmpeg runs, a goroutine scans the HLS output dir (every 1 s, or fsnotify) and uploads each
   finished `<rendition>/seg_NNNNN.m4s` (never a .tmp) exactly once, through the same UPLOAD_PARALLELISM limit as
   uploadAll. After FFmpeg exits 0, upload the remaining segments, then init.mp4 files and all *.m3u8 (master LAST),
   then poster and storyboard, then commit READY. Upload progress keeps the 90..99 % band; encode progress unchanged.
3. Archive copy runs concurrently with probe+encode; the job fails if it fails, and it must finish before commit.
4. FFmpeg failure or ctx cancel → stop the uploader, wait for in-flight uploads, then the existing attempt cleanup
   (cleanupPrefix / RemoveOldAttempts) runs as today. No partially uploaded attempt may ever become READY.
5. Tests:
   - unit: the scanner never uploads a .tmp or the same segment twice, and uploads master.m3u8 last;
   - integration (existing flow test with the real FFmpeg/MinIO testkit): the uploaded object set is identical to the
     pre-V4 run (same keys, same bytes for segments/playlists); a forced FFmpeg failure leaves no READY row and the
     attempt prefix is cleaned;
   - stage metrics from V4-a show upload overlapping encode (upload stage shorter than before on the same fixture —
     paste both numbers).
DoD: go vet, golangci-lint, go test ./... green; README; PR with real outputs, including transcoder_job_seconds for
the same test clip before and after.

# OUT OF SCOPE
Full-GPU pipeline, chunked parallel encode, DASH, the x264-for-480p split (V4-c — only after V4-a data says encode is
the bottleneck), any change to the HLS output layout.
````
