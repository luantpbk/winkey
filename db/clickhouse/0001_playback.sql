-- ClickHouse schema for player analytics (task R1, ADR-022). Owner: architect.
-- Applied in file-name order by analytics-worker at start-up (every statement is idempotent: IF NOT EXISTS);
-- each applied file is recorded in winkey.schema_migrations. Never edit an applied file: add 0002_… instead.
-- Target: ClickHouse 25.x (single node on gpu-01, non-replicated MergeTree family).

CREATE DATABASE IF NOT EXISTS winkey;

CREATE TABLE IF NOT EXISTS winkey.schema_migrations
(
    name       String,
    applied_at DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree
ORDER BY name;

-- One row per player sample (analytics.playback v1). (playback_id, seq) is unique per playback; event_id is
-- UUIDv5(playback_id:seq), so a sample re-sent by the client or a batch re-inserted by the worker collapses on
-- merge (ReplacingMergeTree) and, for a retried INSERT, already at insert time. The worker MUST insert with
--   SETTINGS insert_deduplication_token = '<first stream seq>-<last stream seq>',
--            deduplicate_blocks_in_dependent_materialized_views = 1
-- and both tables keep a non-replicated deduplication window, so a retried batch is dropped by the base table
-- AND by video_qoe_hourly (without the second setting the hourly sums would count the retry twice — verified).
CREATE TABLE IF NOT EXISTS winkey.playback_events
(
    event_id        UUID,
    received_at     DateTime64(3, 'UTC'),
    sent_at         DateTime64(3, 'UTC'),
    playback_id     UUID,
    video_id        UUID,
    owner_id        UUID,
    viewer_key      FixedString(64),
    authenticated   Bool,
    kind            Enum8('start' = 1, 'heartbeat' = 2, 'end' = 3),
    seq             UInt32,
    position_ms     UInt32,
    watched_ms      UInt32,
    rebuffer_ms     UInt32,
    rebuffer_count  UInt16,
    startup_ms      Nullable(UInt32),
    rendition       LowCardinality(Nullable(String)),
    bitrate_kbps    Nullable(UInt32),
    error_code      LowCardinality(Nullable(String)),
    client          LowCardinality(String),
    country         LowCardinality(Nullable(FixedString(2)))
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (video_id, playback_id, seq)
TTL toDateTime(received_at) + INTERVAL 90 DAY DELETE
SETTINGS non_replicated_deduplication_window = 1000;

-- Hourly QoE and watch time per video, kept 2 years. Read with the -Merge / sum combinators, e.g.
--   SELECT hour, sum(watched_ms), sum(rebuffer_ms) / (sum(watched_ms) + sum(rebuffer_ms)) AS rebuffer_ratio,
--          quantilesMerge(0.5, 0.95)(startup_ms_q) AS startup_p50_p95, uniqMerge(viewers) AS viewers
--   FROM winkey.video_qoe_hourly WHERE video_id = {id:UUID} GROUP BY hour ORDER BY hour
CREATE TABLE IF NOT EXISTS winkey.video_qoe_hourly
(
    hour            DateTime('UTC'),
    video_id        UUID,
    owner_id        SimpleAggregateFunction(any, UUID),
    samples         SimpleAggregateFunction(sum, UInt64),
    starts          SimpleAggregateFunction(sum, UInt64),
    watched_ms      SimpleAggregateFunction(sum, UInt64),
    rebuffer_ms     SimpleAggregateFunction(sum, UInt64),
    rebuffer_count  SimpleAggregateFunction(sum, UInt64),
    errors          SimpleAggregateFunction(sum, UInt64),
    startup_ms_q    AggregateFunction(quantiles(0.5, 0.95), UInt32),
    viewers         AggregateFunction(uniq, FixedString(64))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (video_id, hour)
TTL hour + INTERVAL 2 YEAR DELETE
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS winkey.video_qoe_hourly_mv TO winkey.video_qoe_hourly AS
SELECT
    toStartOfHour(received_at)                         AS hour,
    video_id,
    any(owner_id)                                      AS owner_id,
    count()                                            AS samples,
    countIf(kind = 'start')                            AS starts,
    sum(toUInt64(watched_ms))                          AS watched_ms,
    sum(toUInt64(rebuffer_ms))                         AS rebuffer_ms,
    sum(toUInt64(rebuffer_count))                      AS rebuffer_count,
    countIf(kind = 'end' AND error_code IS NOT NULL)   AS errors,
    quantilesStateIf(0.5, 0.95)(assumeNotNull(startup_ms), kind = 'start' AND startup_ms IS NOT NULL) AS startup_ms_q,
    uniqState(viewer_key)                              AS viewers
FROM winkey.playback_events
GROUP BY hour, video_id;
