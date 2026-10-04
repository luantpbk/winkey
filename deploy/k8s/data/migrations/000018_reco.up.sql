-- Task R2 (ADR-028): recommendation v1 ("Dành cho bạn").
-- Both tables are written ONLY by analytics-worker (role analytics_svc) on gpu-01, which recomputes them from
-- ClickHouse winkey.playback_events every RECO_INTERVAL and replaces their whole content in ONE transaction
-- (readers never see a half-written table). video-svc (role media_svc) only SELECTs them, so the feed keeps working
-- while gpu-01 is off (it just stops learning). No FK to media.videos (no cross-schema FKs): rows of deleted or
-- hidden videos are filtered at read time by the public-feed rule, like media.trending.

-- Item-to-item co-view: for each video, its top neighbours among videos qualified-watched by the same viewers.
-- score = co_viewers / sqrt(viewers(video_id) * viewers(neighbor_id)) (cosine on binary watch vectors).
-- Pairs seen by fewer than 3 distinct viewers are never stored (noise, and no pair reveals one person's history).
CREATE TABLE analytics.video_coview (
    video_id     uuid        NOT NULL,
    neighbor_id  uuid        NOT NULL,
    co_viewers   integer     NOT NULL CHECK (co_viewers >= 3),
    score        real        NOT NULL CHECK (score > 0 AND score <= 1),
    refreshed_at timestamptz NOT NULL,
    PRIMARY KEY (video_id, neighbor_id),
    CONSTRAINT video_coview_not_self CHECK (video_id <> neighbor_id)
);

-- Recent qualified watches of SIGNED-IN viewers only. viewer_key is the 64-hex HMAC of ADR-022
-- (hex(HMAC-SHA256(ANALYTICS_VIEWER_SALT, 'u:<user id>'))); no user id in clear. At most RECO_HISTORY rows per viewer.
CREATE TABLE analytics.viewer_history (
    viewer_key      char(64)    NOT NULL CHECK (viewer_key ~ '^[0-9a-f]{64}$'),
    video_id        uuid        NOT NULL,
    last_watched_at timestamptz NOT NULL,
    watched_ms      bigint      NOT NULL CHECK (watched_ms > 0),
    refreshed_at    timestamptz NOT NULL,
    PRIMARY KEY (viewer_key, video_id)
);

-- Feed read: WHERE viewer_key = $1 ORDER BY last_watched_at DESC LIMIT 50.
CREATE INDEX viewer_history_recent ON analytics.viewer_history (viewer_key, last_watched_at DESC);
