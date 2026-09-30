# transcoder

Pull worker that turns `video.uploaded` messages into HLS CMAF renditions. Owner: Sonnet 5.5 (tasks V2 + V3).
It follows ADR-003 and ADR-015: **standalone binary + FFmpeg, no inbound ports for work, outbound connections only** (NATS, PostgreSQL, Garage over Tailscale). It runs as a systemd service on Linux or a Windows service (WinSW/NSSM) on gpu-01. Paths are configurable (`SCRATCH_DIR`, `ARCHIVE_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`), nothing is hard-coded to `/tmp`, and CI builds for `GOOS=windows`.

## What it does per message

1. `BeginJob` (one transaction): lock the video, skip `READY`/deleted (ack), `UPLOADED|FAILED|PROCESSING → PROCESSING`, retire a crashed worker's stale job, insert `transcode_jobs` (`attempt = max+1`, `RUNNING`, `encoder`, `worker_id = hostname`).
2. Download the raw object to `SCRATCH_DIR/{video}-a{attempt}/` (8 × 16 MiB ranged parts); copy to `ARCHIVE_DIR/{owner}/{video}/source` if set (an archive failure is logged, it does not fail the video). Scratch is always removed.
3. `ffprobe`: needs a video stream and duration > 0; rejects > 12 h or larger than 8K as `INVALID_INPUT` (non-retryable). Reads rotation, SAR, pixel format/bit depth, average frame rate, audio presence.
4. Ladder (ADR-006, matched on the **short edge**, never upscaled, ≥ 1 rendition): 1080p 5000k/5350k/7500k · 720p 2800k/2996k/4200k · 480p 1400k/1498k/2100k (target/maxrate/bufsize). A source below 480p yields one rendition at its own size with the 480p bitrate scaled by pixel count (floor 300k).
5. **One** ffmpeg process: `filter_complex split` → per rendition `scale, fps=<avg, ≤ 60>, format=yuv420p, setsar=1`; HLS fMP4, 4 s segments, keyframe every 2 s; AAC 128k/48k/stereo (silent track via `anullsrc` + `-shortest` when the source has none). NVENC: `-hwaccel cuda` without `-hwaccel_output_format`, `h264_nvenc -profile:v high -preset p5 -tune hq -rc vbr -spatial-aq 1 -bf 3 -no-scenecut 1 -forced-idr 1`. x264: `libx264 -profile:v high -preset $X264_PRESET -sc_threshold 0`. If NVENC fails at runtime the **same attempt retries once with x264** and records `encoder='x264'`.
   Security: `-protocol_whitelist file,pipe`, local input only, timeout `max(10m, 3 × duration)`, container images run as non-root, metadata/chapters are stripped.
   Progress: `-progress pipe:1`, parsed from `out_time_us`.
6. Poster: `v/{id}/a{n}/thumb/poster.jpg` at 10 % of the duration, at most 1280 px wide (never upscaled).
6b. **Storyboard** (V5a, seek preview; best effort): one ffmpeg call over the **smallest HLS rendition of at least 90 px** (its local playlist, CPU, key frames only; the source when no rendition qualifies) with `fps=1/{interval}`, letter-boxed to 160×90 (aspect kept, black bars), `tile=10x10`, JPEG about quality 75 → `v/{id}/a{n}/storyboard/sheet-001.jpg` (…-002 …) and `storyboard.vtt`. `interval = max(2 s, duration / 200)` (at most 200 frames, so at most 2 sheets), cue `i` is `i × interval → min((i+1) × interval, duration)` with the payload `sheet-NNN.jpg#xywh=X,Y,160,90` — **relative** names, so the signed prefix of SEC1 (`/s/{exp}/{sig}/…`) applies to the sheets. A video shorter than one interval still gets one cue. **Any failure is logged at warn with the video id and the job goes on without a storyboard** (`storyboard_key` is NULL in `media.videos` and `null` in `video.ready`); only a shutdown interrupts the job. Budget `max(2 min, duration)`. Measured cost: see *Storyboard cost* below (0.42 s on the benchmark clip).
7. Upload to `winkey-media` under `v/{video_id}/a{attempt}/` with 8 parallel uploads, correct `Content-Type` and `Cache-Control: public, max-age=31536000, immutable`; `master.m3u8` is uploaded **last**.
8. One transaction: replace `video_renditions`, set duration/width/height/keys (including `storyboard_key`, in the same `UPDATE` that makes the row READY), `PROCESSING → READY`, `published_at = coalesce(published_at, now())`, job `SUCCEEDED`, outbox `video.ready` (`data.visibility` is the visibility the row has at that moment, read by `UPDATE … RETURNING visibility` in the statement that makes it READY: an owner who changed it while the video was transcoding is not contradicted; task C4). Then ack, then delete older attempts' prefixes.

**Progress** is one bar for the whole job (download 0–5, probe 5, transcode 5–90, upload 90–99, 100 when READY). It is written to `transcode_jobs.progress` and published on core NATS `rt.video.{id}.progress`, at most once per 5 s. `stage` says what the worker is doing.

## Failure handling (contracts/events/README.md)

| Situation | `video.failed.reason` | Retryable | What happens |
|---|---|---|---|
| unreadable / no video / > 12 h / > 8K | `INVALID_INPUT` | no | job + video `FAILED`, `video.failed`, `Term` (no DLQ) |
| ffmpeg over its time budget | `TIMEOUT` | yes | see below |
| ffmpeg/ffprobe error | `ENCODER_ERROR` | yes | see below |
| Garage download/upload error | `STORAGE_ERROR` | yes | see below |
| anything else (DB, …) | `INTERNAL` | yes | see below |

Retryable, not last delivery: job `FAILED`, video stays `PROCESSING`, `NakWithDelay(1m × delivery)`. Last delivery (`NumDelivered == 3`): job and video `FAILED`, `video.failed`, copy to `dlq.video.uploaded`, `Term`. `InProgress` every 30 s while working; consumer `transcoder`: pull, `ack_wait 2m`, `max_deliver 3`, no backoff. Owner-facing messages are fixed strings (no paths or stderr).
**SIGTERM**: stop fetching, running jobs get `SHUTDOWN_GRACE` (30 s), then are cancelled and `Nak`'d (the job row is closed non-terminally; the video is not blamed).

**Max-deliveries watcher.** If every delivery of a message ends without an ack (worker crash, power loss, lost heartbeat, or a Nak on the last delivery), no code runs on the last delivery. JetStream then publishes a core-NATS advisory (`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.VIDEO.transcoder`). The watcher loads the original message by `stream_seq`, and in one transaction closes the active job (or records a `FAILED` one if none ever ran), marks the video `FAILED` (`INTERNAL`, retryable, "Processing did not complete after several attempts.") and enqueues `video.failed`; it then copies the message to `dlq.video.uploaded` (same `Nats-Msg-Id` as the consumer path, so no duplicates). It is idempotent (READY/FAILED/deleted videos are left alone), so it can run in every worker. Limits: advisories are not persisted and JetStream emits one when a puller asks for messages after the last `ack_wait` expired, so it arrives once a worker is running; the watcher subscribes before the consumer starts pulling. An advisory published while no watcher is subscribed is missed and that video stays `PROCESSING` until an operator resets or replays it.

**Heartbeat and stuck-job reconciler (V3b).** While a job runs, every 30 s the pipeline calls `msg.InProgress()` **and** sets `transcode_jobs.heartbeat_at = now()` for that job. Every worker also runs a reconciler (every `RECONCILE_INTERVAL`, default 60 s) that picks `RUNNING` jobs with `coalesce(heartbeat_at, started_at)` older than `STALE_JOB_AFTER` (default 10 min): the job is marked `FAILED` ("worker lost (no heartbeat)"); then, if the video is still `PROCESSING` and the job's attempt is below `MAX_JOB_ATTEMPTS` (3), a **new** `video.uploaded` (fresh `event_id`, same data) is enqueued through the outbox in the same transaction, otherwise the video is failed like the watcher does (`FAILED` + `video.failed`, reason `INTERNAL`). Unlike the watcher it does not depend on JetStream advisories, so it also covers a worker that died while no watcher was subscribed. Concurrency: each candidate is handled in its own transaction that locks the video row first with `FOR UPDATE SKIP LOCKED` (the same lock order as `BeginJob`, so no deadlock), then the job row with a re-check that it is still `RUNNING` and still stale, so several reconcilers never handle the same job twice. A job whose video already left `PROCESSING` is just closed. No DLQ copy is written for videos failed this way (the original message is not available to the reconciler); reset or re-upload by an operator.

## Media janitor (V3)

- `video.deleted` (durable `media-janitor`): deletes everything under `media_prefix` plus `raw_key`. The event is **validated against the layout** first (`v/{video_id}/`, `{owner_id}/{video_id}/source`, configured buckets) so a malformed event can never delete anything else.
- After `READY`, older attempts (`v/{id}/a{k}/`, `k < current`) are deleted.
- On startup, leftover `<uuid>-a<N>` directories in `SCRATCH_DIR` from crashed jobs are removed.
- `cmd/replay-dlq`: re-publishes `dlq.video.uploaded` after a fix.

```bash
NATS_URL=nats://... replay-dlq -dry-run              # list what would be replayed
NATS_URL=nats://... replay-dlq -video-id <uuid>      # one video
NATS_URL=nats://... replay-dlq -max 10
```
Messages keep their payload (same `event_id`; the transcoder is idempotent) and get a fresh `Nats-Msg-Id`. A durable consumer remembers what was replayed. The video must be `FAILED` or `PROCESSING` (both are accepted by `BeginJob`).

S3 access goes through the shared client `libs/go/s3x` (internal endpoint only; the transcoder never presigns).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL, role `media_svc` |
| `NATS_URL` | required | NATS with JetStream (streams `VIDEO`, `DLQ` must exist) |
| `S3_ENDPOINT` | required | Garage S3 (internal/Tailscale endpoint) |
| `S3_REGION` | `garage` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | required | |
| `S3_RAW_BUCKET` / `S3_MEDIA_BUCKET` | `winkey-raw` / `winkey-media` | |
| `ENCODER` | `auto` | `auto` = NVENC if a 1-frame test encode works at startup, else x264; or `nvenc` / `x264` |
| `X264_PRESET` | `veryfast` | |
| `HWACCEL_DECODE` | `true` | NVENC only. `false` = decode on the CPU, encode on the GPU. **gpu-01 uses `false` with `WORKER_CONCURRENCY=1`**: with the miner running, `-hwaccel cuda` decode measured 3.0x realtime vs 5.6x with CPU decode (docs/INFRASTRUCTURE.md section 6) |
| `WORKER_CONCURRENCY` | auto | 2 with NVENC (GeForce allows ~8 sessions, each job uses 3), 1 with x264 |
| `UPLOAD_PARALLELISM` | `8` | parallel uploads per job |
| `SCRATCH_DIR` | `<os temp>/winkey-scratch` | fast local disk (NVMe) |
| `ARCHIVE_DIR` | unset | optional raw archive |
| `FFMPEG_PATH` / `FFPROBE_PATH` | **required** | absolute paths; production never relies on `PATH` (gpu-01: `/opt/ffmpeg-7.1/bin/ffmpeg`, `/opt/ffmpeg-7.1/bin/ffprobe`) |
| `SHUTDOWN_GRACE` | `30s` | |
| `RECONCILE_INTERVAL` | `60s` | how often each worker sweeps for lost jobs |
| `STALE_JOB_AFTER` | `10m` | a `RUNNING` job with no heartbeat for this long is considered lost |
| `MAX_JOB_ATTEMPTS` | `3` | lost job with fewer attempts is retried; otherwise the video is failed |
| `HTTP_ADDR` | `:8081` | `/healthz`, `/readyz` (PostgreSQL, NATS, S3), `/metrics` |
| `LOG_LEVEL` | `info` | JSON logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | tracing is a no-op when unset |

Metrics: `transcoder_jobs_total{outcome}`, `transcoder_jobs_in_flight`, `transcoder_encode_realtime_ratio{encoder}`.

## Run

```bash
cp .env.example .env    # edit and export
go run ./cmd/transcoder
```

**gpu-01 (Ubuntu, systemd)**: the unit, env template, `install.sh` (install / upgrade / rollback / status) and the runbook are in [`deploy/gpu-01/`](deploy/gpu-01/README.md).

**Windows**: build `GOOS=windows go build -o transcoder.exe ./cmd/transcoder`, set the variables machine-wide or in the service wrapper (WinSW/NSSM), point `FFMPEG_PATH`/`FFPROBE_PATH` at an FFmpeg with NVENC and `SCRATCH_DIR` at the NVMe. ffmpeg's HLS muxer fails with "Permission denied" when its working directory is on another drive than the output; the worker runs it in the output directory, so any drive layout works.
**Linux**: a systemd unit with `EnvironmentFile=`, `User=transcoder`, `Restart=always`, `KillSignal=SIGTERM`, `TimeoutStopSec=60`.

## Storyboard cost

The storyboard is read from the **smallest HLS rendition that is at least 90 px high** (its local playlist under `out/hls/`, `-protocol_whitelist file`, CPU decode, `-skip_frame nokey`): the renditions have a key frame every 2 s, which is the storyboard interval for any video up to 400 s, so only about one small frame per tile is decoded instead of every frame of the source. When no rendition qualifies (a source under 90 px high) the source is read, every frame. There is no GPU branch: decoding a handful of 480p key frames is cheaper than starting NVDEC. For an interval that is not a multiple of 2 s the frame is the last key frame before the slot, at most 2 s early, which is fine for a seek preview.

Measured with `TestStoryboardOverhead` on a **Windows / amd64 laptop, 4 CPUs, x264 `veryfast`**, a 120 s 1080p30 clip at about 8 Mb/s, three full pipeline runs (baseline, with storyboard, baseline). The first design (reading the source) cost 13.0 s and +10.1 %; reading the 480p rendition:

| | wall time |
|---|---|
| job without storyboard | 2 m 01.8 s and 1 m 57.9 s (mean 1 m 59.9 s) |
| job with storyboard | 2 m 02.8 s |
| **storyboard step alone** | **0.42 s** (60 frames, 1 sheet) = 0.4 % of the HLS encode (2 m 00.9 s) |
| whole job | +2.4 %, which is inside the run-to-run noise (the two baselines differ by 3.3 %); the step itself is 0.35 % of the job |

Not measured on gpu-01 or on arm64 edge nodes.

## Test

```bash
go test ./...                                   # unit tests + real-ffmpeg tests (skip if ffmpeg is missing)
WINKEY_REQUIRE_DOCKER=1 go test ./...           # + PostgreSQL/NATS/Garage integration (needs Docker)
go test -tags gpu -run GPU -v -timeout 30m ./internal/job/...   # on gpu-01: NVENC end-to-end + benchmark
BENCH_STORYBOARD=1 go test -run StoryboardOverhead -v ./internal/job   # what the storyboard adds to a transcode
go test -update ./internal/media                # regenerate the ffmpeg argument goldens (review the diff!)
GOOS=windows go build ./... && GOOS=linux GOARCH=arm64 go build ./...
scripts/e2e.sh                                  # against a running stack (see the header for variables)
```

- `internal/media` — pure logic: ladder, probe parsing/validation, ffmpeg argument builder (golden files for NVENC and x264, portrait, silent and single-rendition), progress parser, playlist verification.
- `internal/job` — pipeline, failure mapping, and tests with **real ffmpeg**: landscape/portrait/silent/360p/10-bit/rotated clips → 3 (or fewer) variants, `master.m3u8` has `BANDWIDTH`, `RESOLUTION`, `CODECS`, every variant has its own init segment referenced by `#EXT-X-MAP`, ffprobe reads every variant.
- `internal/integration` — full flow on real PostgreSQL 17 + NATS + Garage (testkit), `video.ready`/`video.failed` events, janitor, DLQ replay.

**`init.mp4` note**: with `-var_stream_map` recent FFmpeg (checked on 9.0) appends the variant index to the requested init file name (`init_0.mp4`, `init_1.mp4`, …) inside each variant directory. The playlists reference the right name, so playback is unaffected; the code and tests locate the init segment through `#EXT-X-MAP`, not by name, so both naming behaviours pass.

## Images

```bash
docker build -f services/transcoder/Dockerfile.nvenc -t transcoder-nvenc .                               # amd64 only
docker buildx build --platform linux/amd64,linux/arm64 -f services/transcoder/Dockerfile.cpu .          # ENCODER=x264
```
**FFmpeg version (both images): n7.1.5-12-g1fdbca85aa**, BtbN FFmpeg-Builds release `autobuild-2026-07-31-14-10`, static GPL (`linux64-gpl-7.1` for amd64/nvenc, `linuxarm64-gpl-7.1` for arm64). Downloads are verified with `sha256sum -c` (`c1e6caf4…0e79` for linux64, `a9a50c57…a71b` for linuxarm64; both match the release's `checksums.sha256`). To upgrade, change the release, archive names and checksums in both Dockerfiles and this paragraph together.

`transcoder-nvenc` needs `--gpus all` (NVIDIA Container Toolkit) and sets `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility` (without `video`, NVENC is invisible in the container). Both run as non-root.
