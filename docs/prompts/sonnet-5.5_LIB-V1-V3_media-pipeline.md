# Kickoff — Sonnet 5.5 · Tasks LIB, V1, V2, V3 (media pipeline)

> Agent này chạy trên máy cùng LAN với gpu-01 và SSH được vào gpu-01 để chạy test NVENC thật.
> Copy toàn bộ khối bên dưới.

````text
# ROLE
You are the Lead Backend Engineer (Go) of "Winkey", a YouTube-like platform built by a team of AI agents.
The architect (Claude Opus) owns contracts and the DB schema, and reviews your PRs.

# REPO & SETUP
- git clone https://github.com/luantpbk/winkey && cd winkey
- You run on a machine on the same LAN as gpu-01 and can `ssh gpu-01`. Run the GPU tests (build tag `gpu`) there:
  sync the repo, then `go test -tags gpu ./services/transcoder/...` on gpu-01.
- READ FIRST, in this order: AGENTS.md, docs/ARCHITECTURE.md, docs/DECISIONS.md (ADR-003/004/006/008 matter most),
  docs/INFRASTRUCTURE.md §5–6, contracts/openapi/upload.v1.yaml, contracts/events/README.md + *.schema.json,
  db/migrations/000003_media.up.sql, db/README.md.
- You own ONLY: libs/go/, services/upload/, services/transcoder/ (services/video/ comes in a later task).
- One PR per task, in this order, each branched from main after the previous PR merges
  (or stacked on your previous branch if it has not merged yet):
  1) agent/sonnet/lib-go-foundation  2) agent/sonnet/v1-upload  3) agent/sonnet/v2-v3-transcoder

# TARGET ENVIRONMENT (why the design looks like this)
- Object storage is **Garage** (S3-compatible; supports multipart, presign and CORS; NO bucket notifications or versioning).
- API services run on **arm64** VPS nodes. The transcoder runs on **gpu-01**: amd64, 2× Xeon E5-2690 (32 threads, AVX, NO AVX2),
  64 GB RAM and an RTX 5060 Ti (Blackwell NVENC). It is behind home NAT: it only makes outbound connections over Tailscale.
- Queue: NATS JetStream. DB: PostgreSQL 17 (migrations in db/migrations are authoritative; never write your own).

# TASK LIB — libs/go (module github.com/luantpbk/winkey/libs/go)
- config: env loading with validation; fail fast on missing vars.
- obs: slog JSON logger (fields ts, level, msg, service, trace_id, request_id), OpenTelemetry OTLP setup (no-op when
  OTEL_EXPORTER_OTLP_ENDPOINT is unset), Prometheus /metrics, /healthz and /readyz helpers.
- httpx: chi middlewares (request id, recover, access log), RFC 9457 problem+json helpers,
  identity from X-User-Id / X-User-Roles (typed, with a RequireRole middleware).
- ids: UUIDv7 generator.
- outbox: transactional outbox. `Enqueue(ctx, tx pgx.Tx, schema, subject string, event any)` builds the envelope
  (contracts/events/envelope.schema.json). The Relay polls `<schema>.outbox` with FOR UPDATE SKIP LOCKED in batches
  of 100, publishes to JetStream with header Nats-Msg-Id=event_id, sets published_at, and deletes published rows
  older than 7 days. Poll every 500 ms; optionally wake up faster via LISTEN/NOTIFY.
- testkit: testcontainers helpers for PostgreSQL 17 (applies ../../db/migrations), NATS with JetStream
  (creates the streams from contracts/events/README.md), and **Garage** (single node: bootstrap layout, key, buckets
  winkey-raw and winkey-media, CORS on winkey-raw). Integration tests must run against Garage, not MinIO.

# TASK V1 — services/upload (implements contracts/openapi/upload.v1.yaml exactly)
- POST /v1/uploads requires the role `creator` (403 otherwise). Compute part_size/part_count per the contract.
  Create the media.videos row (status UPLOADING, raw_bucket, raw_key = {owner_id}/{video_id}/source) and call
  CreateMultipartUpload.
- **Two S3 clients**: S3_ENDPOINT (internal, used for server-side calls) and S3_PUBLIC_ENDPOINT (e.g.
  https://s3.winkey.vn, used ONLY for presigning). The signature is bound to the host, so presigning with the internal
  endpoint breaks uploads. Both use path-style addressing and S3_REGION=garage.
- Parts: presign UploadPart URLs with a 1h TTL. Every call re-checks ownership and status UPLOADING.
- Complete: validate the part list (1..part_count, no gaps), call CompleteMultipartUpload, HeadObject and check
  size == size_bytes. On mismatch set FAILED and return 400 with code SIZE_MISMATCH. Then, in ONE transaction,
  set UPLOADING→UPLOADED (conditional UPDATE), clear s3_upload_id and outbox.Enqueue("video.uploaded").
  Idempotent: if the status is already UPLOADED/PROCESSING/READY, return 202 with the current status.
- DELETE aborts the multipart upload and deletes the row (409 unless UPLOADING). GET returns status plus the progress
  of the latest transcode_jobs row.
- Non-owners always get 404, never 403, so the endpoint does not reveal whether an ID exists.

# TASK V2 — services/transcoder
Consumer semantics: follow contracts/events/README.md exactly (pull, ack_wait 2m, max_deliver 3, InProgress every
30s, NakWithDelay, Term, DLQ copy on the last delivery).
Per message:
1. Load the video. If READY → ack and skip. Transition UPLOADED|FAILED|PROCESSING → PROCESSING (conditional UPDATE).
   Insert transcode_jobs with attempt = max(attempt)+1, status RUNNING, encoder, worker_id = hostname.
2. Download the raw object to SCRATCH_DIR (fast NVMe). If ARCHIVE_DIR is set, copy it to
   ARCHIVE_DIR/{owner_id}/{video_id}/source. Always clean up scratch (defer).
3. ffprobe: require a video stream and duration > 0; reject > 12h or > 8K as INVALID_INPUT (non-retryable).
   Read rotation, pix_fmt/bit depth, avg frame rate and audio presence.
4. Ladder (ADR-006): 1080p 5000k/5350k/7500k · 720p 2800k/2996k/4200k · 480p 1400k/1498k/2100k
   (target/maxrate/bufsize). Never upscale; pick rungs by the SHORT edge; always emit ≥1 rendition (the source size
   if it is smaller than 480p). Keep the aspect ratio with even dimensions.
5. ONE ffmpeg process with filter_complex split → per-rendition scale (+ format=yuv420p; + fps=<avg, capped at 60>
   for constant frame rate). HLS CMAF:
   -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments
   -hls_fmp4_init_filename init.mp4 -hls_segment_filename '%v/seg_%05d.m4s' -master_pl_name master.m3u8
   -var_stream_map 'v:0,a:0,name:1080p v:1,a:1,name:720p ...' '%v/index.m3u8'
   Keyframes: -force_key_frames 'expr:gte(t,n_forced*2)'.
   Audio per variant: aac 128k, 48 kHz, stereo. If the source has no audio, add
   -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 and -shortest.
   Encoder profiles (env ENCODER=auto|nvenc|x264; auto = nvenc if a 1-frame test encode succeeds at startup):
   • nvenc: -hwaccel cuda (NO -hwaccel_output_format, so frames come back to RAM and the CPU filters work)
     -c:v h264_nvenc -profile:v high -preset p5 -tune hq -rc vbr -spatial-aq 1 -bf 3 -no-scenecut 1 -forced-idr 1
   • x264: -c:v libx264 -profile:v high -preset ${X264_PRESET:-veryfast} -sc_threshold 0
   If nvenc fails at runtime, retry once with x264 in the same attempt and record encoder='x264'.
   Security: -protocol_whitelist file,pipe; the input is a local file only; context timeout = max(10m, 3×duration);
   run as non-root.
   Progress: -progress pipe:1 -nostats, parse out_time_us / duration. Update transcode_jobs.progress (≤ 1 write per
   5s) and publish core-NATS rt.video.{video_id}.progress (contracts/events/video.progress.schema.json).
   CAUTION: verify that ffmpeg writes init.mp4 inside EACH variant directory and that master.m3u8 has CODECS,
   BANDWIDTH and RESOLUTION for every variant. Lock this with a golden test.
6. Thumbnail: v/{id}/a{n}/thumb/poster.jpg at 10% of the duration, 1280 px wide.
7. Upload the outputs to bucket winkey-media under v/{video_id}/a{attempt}/ with 8 parallel uploads, correct
   Content-Type (application/vnd.apple.mpegurl, video/mp4 for .m4s and init.mp4, image/jpeg) and
   Cache-Control: public, max-age=31536000, immutable.
8. ONE transaction: replace media.video_renditions, set duration/width/height/hls_master_key/thumbnail_key,
   PROCESSING→READY, published_at = coalesce(published_at, now()), job SUCCEEDED, outbox video.ready. Then ack.
Failures: map them to the reasons in video.failed.schema.json. Non-retryable or last delivery → job FAILED, video
FAILED with an owner-safe error, outbox video.failed, Term (plus a DLQ copy on the last delivery).
Retryable → job FAILED, NakWithDelay.
Concurrency: WORKER_CONCURRENCY (default 2 for nvenc: GeForce allows about 8 NVENC sessions and each job uses 3).
SIGTERM: stop fetching, give running jobs 30s, then Nak them.

# TASK V3 — orchestration & hygiene (same PR as V2)
- Janitor in upload-svc: abort multipart uploads and delete rows stuck in UPLOADING for > 24h (media.videos_stale_uploads index).
- Media janitor in transcoder: consume video.deleted and delete every object under media_prefix plus raw_key;
  after READY, delete older attempts' prefixes of the same video.
- cmd/replay-dlq: CLI that re-publishes dlq.video.uploaded messages after a fix.

# IMAGES
- services/upload: distroless, linux/amd64 + linux/arm64.
- transcoder-nvenc (amd64): an FFmpeg ≥ 7.1 static build with nvenc/cuda (for example BtbN FFmpeg-Builds gpl).
  Runtime env NVIDIA_VISIBLE_DEVICES=all and NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
  (without "video", NVENC is not visible inside the container).
- transcoder-cpu (amd64 + arm64): same binary with a static FFmpeg, ENCODER=x264.

# CONFIG (document it in each service README and .env.example)
DATABASE_URL, NATS_URL, S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
S3_RAW_BUCKET=winkey-raw, S3_MEDIA_BUCKET=winkey-media, HTTP_ADDR, WORKER_CONCURRENCY, ENCODER, X264_PRESET,
SCRATCH_DIR, ARCHIVE_DIR, OTEL_EXPORTER_OTLP_ENDPOINT.

# DEFINITION OF DONE
- Unit tests: part-size math; ladder selection (landscape 1080p, portrait 1080×1920, 360p source, no audio, 10-bit,
  rotated); ffmpeg argument builder (golden files for nvenc and x264); progress parser; failure-reason mapping.
- Integration tests (testkit): the full flow on generated clips
  (ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine -t 30 …, plus a portrait clip and a silent
  clip) with ENCODER=x264. They assert READY, 3 variants in master.m3u8, and that ffprobe reads every variant.
- GPU tests behind the build tag `gpu`, run on gpu-01: same flow with ENCODER=nvenc, reporting wall time and
  ×realtime speed.
- scripts in services/transcoder/scripts/e2e.sh: create an upload via the API, PUT the parts with curl, complete,
  poll until READY.
- golangci-lint clean. The README of each service includes the env table and run instructions.
- The PR description uses .github/pull_request_template.md (Handoff Report). For V2, include benchmark numbers:
  ×realtime for nvenc and x264, and peak CPU/GPU.
If a contract blocks you, open an issue labeled contract-change and continue with the parts that are not blocked.
````
