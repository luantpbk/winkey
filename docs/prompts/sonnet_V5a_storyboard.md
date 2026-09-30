# Kickoff — Sonnet 5.5 · Task V5a (seek-preview storyboard)

Starts after SEC1-a (#82, merged). Migration 000008 (`media.videos.storyboard_key`), the optional
`storyboard_key` of `video.ready` and `Playback.storyboard_url` are on main.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-v5a -b agent/sonnet/v5a-storyboard origin/main
READ FIRST: db/migrations/000008_storyboard.up.sql, contracts/events/video.ready.schema.json (storyboard_key),
contracts/openapi/video.v1.yaml (Playback.storyboard_url, SEC1 signing), services/transcoder (pipeline.go poster
step, tools.go ffmpeg calls, uploadAll, store.go ready UPDATE), services/video (models.go playback + SEC1 signing).
You own: services/transcoder, services/video, libs/go. Branch: agent/sonnet/v5a-storyboard.

# TASK V5a — implement exactly
1. Transcoder, after the HLS renditions (best effort — any error is logged at warn with the video id and the job
   continues WITHOUT a storyboard; storyboard_key = null in the DB and the event):
   - interval = max(2 s, duration / 200) (≤ 200 frames per video), tiles 160×90 (keep aspect: scale with
     force_original_aspect_ratio=decrease + pad, black bars), 10×10 tiles per sheet, JPEG quality ≈ 75:
     one ffmpeg call, e.g. -vf "fps=1/{interval},scale=160:90:force_original_aspect_ratio=decrease,
     pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x10" storyboard/sheet-%03d.jpg (use the hardware decoder only if the
     HLS step did; the CPU path must work on edge nodes).
   - storyboard/storyboard.vtt (WEBVTT): one cue per frame, start = i*interval, end = min((i+1)*interval,
     duration), payload `sheet-NNN.jpg#xywh=X,Y,160,90` — RELATIVE file names so the SEC1 signed prefix applies.
     Timestamps HH:MM:SS.mmm. Frames the video never reaches are not listed.
   - upload with Content-Type image/jpeg / text/vtt and the same Cache-Control as the other immutable outputs;
     keys under v/{video_id}/a{attempt}/storyboard/.
   - store.go: set storyboard_key in the SAME UPDATE that switches the row to READY; video.ready carries it.
   - Must not add more than ~10 % to transcode time on the benchmark clip; measure and report.
2. video-svc: Playback.storyboard_url = media URL of storyboard_key (null when NULL), signed exactly like
   hls_url when the video is not publicly watchable (reuse signMediaURL; same expires).
3. The media-janitor / delete path already removes v/{id}/ recursively — verify storyboard objects go too.

# DEFINITION OF DONE
- Unit: VTT generation (cue math at the edges: duration not a multiple of interval, very short 3 s video →
  ≥ 1 cue, 2 h video → ≤ 200 cues, sheet index / x,y for tile 0, 9, 10, 99, 100), best-effort path
  (ffmpeg failure → READY without storyboard, warn log, event storyboard_key null).
- Integration (testkit Garage + PostgreSQL 17, WINKEY_REQUIRE_DOCKER=1): a real short clip produces sheets +
  vtt in Garage with the right content types, the row and event carry storyboard_key, video-svc returns a
  plain storyboard_url for a public video and a signed one for a private one (Spec.Check on responses,
  event validated against video.ready.schema.json).
- go vet, golangci-lint, go test -race; arm64 cross-build; README of both services. PR = Handoff Report with
  real output and the timing numbers.

# OUT OF SCOPE
Player UI (Antigravity 1, after this), subtitles / auto-captions (V5b, later), any contract or migration change.
````
