<!-- Handoff Report for review (PR description). Delete this file once the PR is opened. -->
## Task
[V2] transcoder + [V3] orchestration & hygiene (one PR, as specified). **Stacked on `agent/sonnet/lib-go-foundation` (PR 1)**; it does not depend on PR 2 (V1). Retarget to `main` once PR 1 merges.

## What was built
`services/transcoder`:
- **Worker** (JetStream pull consumer `transcoder`: `ack_wait 2m`, `max_deliver 3`, `InProgress` every 30 s, `NakWithDelay(1m × delivery)`, `Term`, DLQ copy on the last delivery), pipeline steps 1-8 of the brief, NVENC→x264 fallback inside the same attempt, progress to `transcode_jobs.progress` and core NATS `rt.video.{id}.progress` (≤ 1 per 5 s), SIGTERM = stop fetching, 30 s grace, then Nak.
- **Max-deliveries watcher**: subscribes to the JetStream `MAX_DELIVERIES` advisory of the `transcoder` consumer; when a message is exhausted without an ack (crashed worker) it fails the video (`FailStuck`: job closed/recorded, video `FAILED`, `video.failed` via the outbox) and copies the message to the DLQ. Idempotent; runs in every worker.
- **V3**: media janitor (`video.deleted` → purge `media_prefix` + `raw_key`, validated against the documented layout; old attempts removed after READY), startup scratch cleanup, `cmd/replay-dlq` (`-dry-run`, `-video-id`, `-max`).
- Outbox relay for `media.outbox` runs in the worker too (it writes `video.ready`/`video.failed`).
- Portable per ADR-015: `FFMPEG_PATH`/`FFPROBE_PATH`, `SCRATCH_DIR`/`ARCHIVE_DIR`, no `/tmp`; builds for `GOOS=windows`, linux/amd64, linux/arm64.
- `Dockerfile.nvenc` (amd64, BtbN FFmpeg 7.1 GPL, `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`), `Dockerfile.cpu` (amd64+arm64, static FFmpeg, `ENCODER=x264`), `scripts/e2e.sh`, README with env table, `.env.example`.

## Key decisions & deviations from contracts/ADRs
- No contract deviations.
- **`init.mp4` naming** (the brief's CAUTION): verified on FFmpeg 9.0.2 that init segments are written **inside each variant directory** but suffixed with the variant (`init_0.mp4`, `init_1.mp4`, …; `-hls_fmp4_init_filename init.mp4` is not honoured verbatim with `-var_stream_map`). Playlists reference the right file, so playback is unaffected. Code and tests find it via `#EXT-X-MAP`; uploads treat `.mp4` as `video/mp4`. If a different FFmpeg (e.g. the 7.1 image build) writes plain `init.mp4`, the same checks pass.
- **Windows gotcha found and fixed**: ffmpeg's HLS muxer fails with "Permission denied" when the process working directory is on a different drive than the output (e.g. service cwd on `C:`, `SCRATCH_DIR` on `D:`). The worker runs ffmpeg with `cmd.Dir = output dir`.
- Progress is one **overall** bar (download 0-5, probe 5, transcode 5-90, upload 90-99, 100 on READY); `stage` says what the worker is doing. `transcode_jobs.progress` uses the same number.
- Additions beyond the brief: `-map_metadata -1 -map_chapters -1` (strip GPS/metadata), `setsar=1`, SAR-corrected display size, poster width `min(1280, width)` (never upscaled), master playlist uploaded last, output verified before upload (`media.VerifyOutput`), `-nostdin`.
- Ladder for sources below 480p: one rendition at the source size with the 480p bitrate scaled by pixel count (floor 300k); name is the short edge (`360p`).
- The raw-archive copy is best effort: a failure is logged, the video still transcodes.
- `video.failed.retryable` reports whether the failure class is retryable (also on the terminal attempt after `max_deliver`), so operators know a `replay-dlq` may help.
- Max-deliveries watcher limits: advisories are core-NATS and not persisted; JetStream emits one when a puller asks for messages after the last `ack_wait` expired (so it arrives once a worker runs; the watcher subscribes before the consumer starts). An advisory published while no watcher is subscribed is missed and that video stays `PROCESSING` until an operator resets/replays it.

## How to run & test
```bash
cd services/transcoder
go test ./...                                          # real-ffmpeg tests skip if ffmpeg is missing
WINKEY_REQUIRE_DOCKER=1 go test ./...                  # + integration on PostgreSQL 17 / NATS / Garage
go test -tags gpu -run GPU -v -timeout 30m ./internal/job/...   # on gpu-01
GOOS=windows go build ./... ; GOOS=linux GOARCH=arm64 go build ./...
scripts/e2e.sh
```

## Test evidence (dev machine: Windows 10, i5-6200U 4 threads, FFmpeg 9.0.2 gyan full build, no GPU, no Docker)
- **Pass**: unit tests (ladder incl. landscape 1080p / portrait 1080×1920 / 360p / 4K / ultrawide / odd sizes; probe parsing incl. no audio, 10-bit, rotated, anamorphic, cover art, limits; ffmpeg argument **goldens** for NVENC, x264, portrait, silent, single rendition; progress parser; failure mapping; media-janitor validation; scratch cleanup).
- **Pass, real ffmpeg**: landscape 30 s, portrait, silent (silent track present in every variant), 360p (single rendition), 10-bit → yuv420p, rotated (display matrix 90° → 720×1280 renditions): `master.m3u8` has `BANDWIDTH`, `RESOLUTION`, `CODECS` for every variant, each variant has its own init segment, ffprobe reads every variant, poster is ≤ 1280 px wide.
- **Pass, real ffmpeg + in-memory ports**: full pipeline (content types, immutable cache headers, master uploaded last, progress events, scratch cleaned, archive copy, old-attempt removal, video deleted meanwhile → output discarded), retry/Nak/Term/DLQ lifecycle, invalid input → terminal without DLQ, shutdown interruption → Nak without blaming the video, **NVENC failure → automatic x264 fallback** (this machine has no NVENC, so `ENCODER=nvenc` really fell back).
- **Pass on a real nats-server + PostgreSQL 17.5** (in-process `nats-server` with JetStream and embedded PostgreSQL, real migrations, temporary uncommitted testkit patches): the max-deliveries watcher end to end (consumer with `max_deliver 2`, never acked → advisory → video `FAILED`, `video.failed` published through the outbox relay, DLQ copy) and `replay-dlq` (dry run, filter, replay, not offered twice).
- **Pass on a real PostgreSQL 17.5** (embedded binaries, real `db/migrations`, run locally via a temporary uncommitted testkit patch): store lifecycle (BeginJob/attempt numbering/stale-job retirement, `FailStuck` incl. idempotency, Complete + renditions + `video.ready` in the outbox, terminal FailJob + `video.failed`, READY/UPLOADING/FAILED handling, state-machine trigger). Same run verified the `libs/go` outbox relay (LISTEN/NOTIFY wake-up, cleanup) and the upload-svc store (PR 2).
- **Not run**: the rest of `internal/integration` (full flow with Garage, the JetStream *consumer* path incl. its own DLQ copy, `video.deleted` purge against Garage) and both Dockerfiles; `golangci-lint`; `go test -race`; `scripts/e2e.sh` (syntax-checked only; `jq` is not installed here). **All GPU tests (`-tags gpu`) and nvenc numbers: not run — gpu-01 was unreachable.**

### Benchmark
| Encoder | Machine | Clip | Encode wall | ×realtime | Peak CPU / GPU |
|---|---|---|---|---|---|
| x264 `veryfast`, 3 renditions | dev PC, i5-6200U (4 threads) | 30 s 1080p30 testsrc2 | 26.8 s | **1.1×** | not measured |
| nvenc | gpu-01 | — | **not measured** | — | — |
| x264 `veryfast` | gpu-01 (32 threads) | — | **not measured** | — | — |

The dev-PC x264 figure only shows the pipeline works; it says nothing about gpu-01. `TestGPUBenchmark` (`-tags gpu`) prints ×realtime and peak CPU/GPU/NVENC utilisation for nvenc ×1, x264 ×1 and nvenc ×2 concurrent; please run it on gpu-01 and paste the table here before merge.

## Known limitations / risks
- Docker images not built; the BtbN URL in `Dockerfile.nvenc` is a moving `latest` tag (pin a release before production).
- NVENC path (`-hwaccel cuda` + CPU filters, Blackwell) is unverified on real hardware.
- `WORKER_CONCURRENCY` auto = 2 (nvenc) / 1 (x264). The Windows service wrapper is not included (use WinSW/NSSM; documented).

## Open questions for the architect
- Do we want a periodic reconciler for videos stuck in `PROCESSING` with no live job (covers a missed advisory), or is the current behaviour enough?
- Pin the FFmpeg build for the images (7.1 release tag vs. `latest`)?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
