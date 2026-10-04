# Kickoff — ChatGPT · Task R2-ab (surface + A/B of the recommended feed: worker then video-svc)

Design: ADR-030 in docs/DECISIONS.md. Contracts (merged by the architect): `PlaybackSample.surface` in
contracts/openapi/video.v1.yaml; `surface` and `reco_variant` in contracts/events/analytics.playback.schema.json;
ClickHouse `db/clickhouse/0002_reco_ab.sql`. Two PRs, in this order: **R2-ab-w** (analytics-worker) then **R2-ab-v**
(video-svc). The worker must be deployed before video-svc starts sending the new fields.

````text
# ROLE
You are "ChatGPT", acting owner of services/video, services/analytics and libs/go on Winkey (repo luantpbk/winkey).
Read AGENTS.md, ADR-022 (all addenda), ADR-028 and ADR-030. Never edit contracts/, db/, deploy/.

# PART A — R2-ab-w: analytics-worker accepts and stores the new fields
Worktree: git worktree add ../winkey-gpt-r2abw -b agent/gpt/r2ab-w-worker-fields origin/main
1. internal/event: decode the optional `surface` (enum per the schema, or null/absent) and `reco_variant`
   ("reco" | "control" | null/absent); any other value → Malformed (Term), like the other fields. Keep
   DisallowUnknownFields.
2. Insert both columns (Nullable) in the same single INSERT; keep the dedup token and the #193 reconciliation exactly.
3. ClickHouse schema: in THIS PR, add `db/clickhouse/0002_reco_ab.sql` with EXACTLY the SQL in the appendix below
   (architect-authored; this is the one exception to "never edit db/", because the file must ship in the same PR as the
   worker change: `chdb.InsertBatch` uses `INSERT INTO winkey.playback_events` without a column list, so adding columns
   before the worker writes them breaks every INSERT — CI proved it on #225). Make the INSERT name its columns
   explicitly. Update TestMigrationsAreAppliedOnceAndTheSchemaIsThere for [0001, 0002]. Make sure 0002 applies on 25.8
   and 26.9 and that the reco_ab_daily materialized view fills (integration test: signed-in samples with a variant land
   in reco_ab_daily; anonymous or variant-null samples do not; a retried batch does not double the sums).
   Also add surface/reco_variant to the decode test fixtures (the shared contract example stays without them so the
   currently deployed worker keeps passing).
4. Tests: unit (decode valid/invalid/absent values) + integration as above. DoD: vet, golangci-lint, go test ./...
   green; README updated; PR with real outputs. Lint-only cleanups in a separate PR.

# PART B — R2-ab-v: video-svc assigns the arm, applies it to the feed and records it
Worktree: git worktree add ../winkey-gpt-r2abv -b agent/gpt/r2ab-v-assignment origin/main
1. Config: RECO_AB_ENABLED (default true), RECO_AB_SEED (default "r2ab-1"), RECO_AB_TREATMENT_PERCENT (0..100,
   default 50); validated; README env table.
2. One function `Variant(seed, percent, userID) string` exactly as ADR-030 (first 8 bytes of SHA-256(seed+":"+id),
   big-endian uint64, mod 100). Unit test with fixed vectors and a distribution check (10 000 random ids at 50 % →
   between 48 % and 52 % reco).
3. getRecommendedFeed: signed-in `control` → s_c = s_s = 0 (trending then newest) with the SAME exclusions, diversity
   and pagination; `reco` → unchanged. The Valkey list cache key must include the arm (a seed/percent change must not
   serve the other arm's cached list). Metric video_reco_requests_total gains label `variant` (reco|control|none).
4. recordPlaybackHeartbeats: accept `surface` (contract enum), copy it into the event; for signed-in callers set
   `reco_variant` with the SAME Variant function (null when RECO_AB_ENABLED=false or anonymous). Never log user ids.
5. Tests: integration — a control user gets the anonymous-style ranking but still without own/watched videos; a reco
   user gets the personal ranking; the heartbeat event carries surface and the same arm the feed used; invalid surface
   → 400 per the contract; responses validate against the contract checker.
DoD: vet, golangci-lint, go test ./... green; README; PR with real outputs. Do not merge; tell the user that R2-ab-v
must be deployed only after R2-ab-w is live.
````

## Appendix — `db/clickhouse/0002_reco_ab.sql` (copy verbatim)

```sql
-- Task R2-ab (ADR-030): where a playback started (surface) and the A/B arm of the recommended feed (reco_variant).
-- Applied by analytics-worker at start-up like 0001 (every statement is idempotent). Columns are Nullable: rows
-- written before this file, and samples from older clients, stay NULL ("unknown").

ALTER TABLE winkey.playback_events
    ADD COLUMN IF NOT EXISTS surface      LowCardinality(Nullable(String)),
    ADD COLUMN IF NOT EXISTS reco_variant LowCardinality(Nullable(String));

-- Daily engagement per A/B arm and surface, signed-in viewers in the experiment only, kept 1 year.
-- `day` is a calendar day in Asia/Ho_Chi_Minh (UTC+7, no DST), like analytics.video_daily (R1-b).
-- Primary metric (ADR-030): watch time per active viewer and day, per arm, over ALL surfaces:
--   SELECT day, reco_variant, sum(watched_ms) / uniqMerge(viewers) AS watched_ms_per_viewer
--   FROM winkey.reco_ab_daily GROUP BY day, reco_variant ORDER BY day
-- (uniqMerge over all surfaces of a day counts each viewer once.)
CREATE TABLE IF NOT EXISTS winkey.reco_ab_daily
(
    day          Date,
    reco_variant LowCardinality(String),
    surface      LowCardinality(String),
    samples      SimpleAggregateFunction(sum, UInt64),
    starts       SimpleAggregateFunction(sum, UInt64),
    watched_ms   SimpleAggregateFunction(sum, UInt64),
    viewers      AggregateFunction(uniq, FixedString(64))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, reco_variant, surface)
TTL day + INTERVAL 1 YEAR DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS winkey.reco_ab_daily_mv TO winkey.reco_ab_daily AS
SELECT
    toDate(received_at, 'Asia/Ho_Chi_Minh') AS day,
    assumeNotNull(reco_variant)             AS reco_variant,
    ifNull(surface, 'unknown')              AS surface,
    count()                                 AS samples,
    countIf(kind = 'start')                 AS starts,
    sum(toUInt64(watched_ms))               AS watched_ms,
    uniqState(viewer_key)                   AS viewers
FROM winkey.playback_events
WHERE authenticated AND reco_variant IS NOT NULL
GROUP BY day, reco_variant, surface;
```
