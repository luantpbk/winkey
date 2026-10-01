-- Task R1-b (ADR-022 addendum R1-b): daily per-video player statistics for creators.
-- Written ONLY by analytics-worker (role analytics_svc), which rolls video_qoe_hourly in ClickHouse up into this
-- table every few minutes; read by video-svc (role media_svc, SELECT only) for the studio stats endpoints, so the
-- studio keeps working while gpu-01 is off (numbers just stop advancing).
-- `day` is a calendar day in Asia/Ho_Chi_Minh (UTC+7, no DST). No FK to media.videos (no cross-schema FKs):
-- rows of deleted videos stay until the 2-year retention and are never shown, because every read joins
-- media.videos for ownership.
CREATE SCHEMA analytics;

CREATE TABLE analytics.video_daily (
    video_id       uuid        NOT NULL,
    owner_id       uuid        NOT NULL,
    day            date        NOT NULL,
    starts         bigint      NOT NULL CHECK (starts >= 0),
    watched_ms     bigint      NOT NULL CHECK (watched_ms >= 0),
    rebuffer_ms    bigint      NOT NULL CHECK (rebuffer_ms >= 0),
    errors         bigint      NOT NULL CHECK (errors >= 0),
    viewers        bigint      NOT NULL CHECK (viewers >= 0),   -- approximate unique viewers of THAT day (uniq)
    startup_p50_ms integer     CHECK (startup_p50_ms >= 0),     -- NULL when the day had no start with a startup time
    startup_p95_ms integer     CHECK (startup_p95_ms >= 0),
    refreshed_at   timestamptz NOT NULL,
    PRIMARY KEY (video_id, day),
    CONSTRAINT video_daily_startup_order CHECK (startup_p50_ms IS NULL OR startup_p95_ms IS NULL
                                                OR startup_p50_ms <= startup_p95_ms)
);

-- Channel totals: WHERE owner_id = $1 AND day BETWEEN $2 AND $3.
CREATE INDEX video_daily_owner_day ON analytics.video_daily (owner_id, day);
-- Retention sweep: DELETE WHERE day < $1.
CREATE INDEX video_daily_day ON analytics.video_daily (day);
