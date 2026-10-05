-- Task R2-ab (ADR-030): where a playback started (surface) and the A/B arm of the recommended feed (reco_variant).
-- Applied by analytics-worker at start-up like 0001 (every statement is idempotent). Columns are Nullable: rows
-- written before this file, and samples from older clients, stay NULL ("unknown").
-- Ships in the SAME PR as the worker change that names its INSERT columns (ADR-030): the worker before R2-ab-w
-- inserts without a column list and would break on the new columns.

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

-- Every source column is qualified with `e.`: the output aliases reuse the source names (reco_variant, surface), and
-- ClickHouse substitutes aliases inside WHERE, so an unqualified `reco_variant IS NOT NULL` would test
-- assumeNotNull(...) and admit NULL-variant rows as an empty arm (#227, reproduced on 24.8, 25.8 and 26.9).
CREATE MATERIALIZED VIEW IF NOT EXISTS winkey.reco_ab_daily_mv TO winkey.reco_ab_daily AS
SELECT
    toDate(e.received_at, 'Asia/Ho_Chi_Minh') AS day,
    assumeNotNull(e.reco_variant)             AS reco_variant,
    ifNull(e.surface, 'unknown')              AS surface,
    count()                                   AS samples,
    countIf(e.kind = 'start')                 AS starts,
    sum(toUInt64(e.watched_ms))               AS watched_ms,
    uniqState(e.viewer_key)                   AS viewers
FROM winkey.playback_events AS e
WHERE e.authenticated AND e.reco_variant IS NOT NULL
GROUP BY day, reco_variant, surface;
