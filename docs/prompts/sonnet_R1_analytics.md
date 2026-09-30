# Kickoff — Sonnet 5.5 · Task R1 (player analytics: heartbeat endpoint + analytics-worker → ClickHouse)

Design: ADR-022. Contract: `recordPlaybackHeartbeats` in contracts/openapi/video.v1.yaml (tag `analytics`), event
`analytics.playback` v1 (contracts/events/analytics.playback.schema.json + README sections "Telemetry" and
"Consumer analytics-worker"), ClickHouse schema db/clickhouse/0001_playback.sql (verified on ClickHouse 26.9, incl.
the dedup settings). Antigravity 2 does the stream, NATS permissions, the gateway route, go.work / CI / image
plumbing for the new module and the gpu-01 deployment (task R1-infra) in parallel.

````text
# ROLE
You are the Go engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-sonnet-r1 -b agent/sonnet/r1-analytics origin/main
READ FIRST: docs/DECISIONS.md ADR-022 (and ADR-008, ADR-015, ADR-020), contracts/openapi/video.v1.yaml
(recordPlaybackHeartbeats, PlaybackHeartbeatBatch, PlaybackSample, PlaybackHeartbeatResult; recordView for the
viewer identity + TRUST_PROXY_CIDRS rules), contracts/events/analytics.playback.schema.json + README,
db/clickhouse/0001_playback.sql (read the header comment: the two INSERT settings are mandatory).
You own: services/video, services/analytics (NEW Go module), libs/go. Branch: agent/sonnet/r1-analytics.
Do NOT edit go.work, .github/, deploy/ (Antigravity 2 wires the new module into go.work/CI/images in R1-infra;
until then build/test the module with GOWORK=off) and never db/clickhouse (architect).

# TASK R1 — part A: video-svc
1. `POST /v1/playback/heartbeats`: optional auth; strict JSON decode (unknown fields → 400), body ≤ 16 KiB (413),
   1..20 samples, every field validated per the contract (400 for the whole batch on a schema error).
   Rate limit 30/min per client IP (same limiter + TRUST_PROXY_CIDRS logic as recordView) → 429.
2. Per sample: the video must exist and be readable by the caller (getVideo rules, READY) — otherwise drop the
   sample silently (not an error). Look the videos of a batch up in ONE query (distinct ids), reuse the video cache.
3. Build `analytics.playback` v1: event_id = UUIDv5(fixed namespace constant, "<playback_id>:<seq>"), owner_id from
   the video, received_at = server now (UTC), viewer_key = hex(HMAC-SHA256(ANALYTICS_VIEWER_SALT, viewer)) where
   viewer = user id when authenticated, else C3's anonymous viewer hash — reuse the exact C3 function; never put
   the IP or UA in the event. Publish to JetStream subject `analytics.playback` with header Nats-Msg-Id = event_id,
   async publish with a bounded in-flight window; a publish error → drop + metric
   `video_analytics_samples_total{result="published|dropped_invalid_video|publish_error"}`, never a 5xx.
   Response 202 {accepted: n}.
4. Config: ANALYTICS_VIEWER_SALT (required, ≥ 32 bytes, fail fast at start), ANALYTICS_ENABLED (default true;
   false → 202 {accepted:0} without publishing). README + .env.example (dummy values).

# TASK R1 — part B: services/analytics (analytics-worker)
1. New module github.com/luantpbk/winkey/services/analytics, cmd/analytics-worker; libs/go for logging, health
   (/healthz, /readyz = NATS + ClickHouse reachable, /metrics), config from env only.
2. ClickHouse client: github.com/ClickHouse/clickhouse-go/v2 (native protocol, localhost:9000). At start-up apply
   every db/clickhouse/*.sql not yet in winkey.schema_migrations, in name order. Read them from the directory
   CLICKHOUSE_MIGRATIONS_DIR (default /migrations), which compose mounts read-only from db/clickhouse — no copy
   inside services/analytics, so the files can never drift from db/. Split statements on `;` outside comments.
3. Consumer: durable `analytics-clickhouse` on stream ANALYTICS, filter analytics.playback, deliver_policy all,
   ack explicit, ack_wait 60s, max_deliver -1, max_ack_pending 20000 (CreateOrUpdateConsumer; wait for the
   stream like the R2-b consumer does). Fetch batches: up to 5000 messages or 2 s. Decode + validate each message
   strictly (like R2-b's Decode); malformed / unknown version → Term + metric, excluded from the batch.
   ONE `INSERT INTO winkey.playback_events` per batch with SETTINGS
   insert_deduplication_token='<first stream seq>-<last stream seq>', deduplicate_blocks_in_dependent_materialized_views=1.
   Success → ack every message of the batch; failure → NakWithDelay(5s × attempt, cap 60 s) for all of them and
   retry; never Term a valid message. Graceful shutdown: finish/abandon the current batch without acking.
4. Metrics: analytics_batches_total{result}, analytics_rows_inserted_total, analytics_batch_seconds (histogram),
   analytics_consumer_pending (gauge from consumer info, every 30 s).
5. Dockerfile (distroless static, multi-arch like the other Go services), README (env table, how to run against a
   local ClickHouse: `docker run -p 9000:9000 clickhouse/clickhouse-server`).

# DEFINITION OF DONE
- video-svc unit + integration (testkit PG + NATS, WINKEY_REQUIRE_DOCKER=1, 0 skipped): valid batch → N events on
  the stream with the right Nats-Msg-Id and payload validated against the JSON schema (reuse the schema-check
  helper you used for R2-b); unreadable/unknown video dropped; 400/413/429; anonymous viewer_key stable for the
  same viewer and different from the authenticated one; no IP/UA anywhere in the event (assert); Spec.Check on
  every response.
- analytics-worker integration with testcontainers NATS + ClickHouse (clickhouse/clickhouse-server pinned):
  migrations applied once (2nd start = no-op); 10 000 events → 10 000 rows and correct video_qoe_hourly sums;
  ClickHouse stopped mid-run → no ack, nothing lost after restart, sums still exact (dedup token + MV setting);
  malformed message → Term, the rest inserted.
- go vet, golangci-lint, go test -race (GOWORK=off for the new module), arm64 + amd64 cross-build, CI green for
  services/video (the new module's CI job arrives with R1-infra). Handoff Report with real output.

# OUT OF SCOPE
Player code (Antigravity 1, U8), dashboards/Grafana (I3), creator stats API (R1-b), deploy/, contracts, db/.
````
