-- Task R2-a (ADR-020): trending feed v1.
-- video_views_hourly: counted views per video per UTC hour, written by the view flusher (C3) in the SAME
-- transaction as media.videos.view_count. Kept 8 days by video-svc.
CREATE TABLE media.video_views_hourly (
    video_id uuid        NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    hour     timestamptz NOT NULL,
    views    bigint      NOT NULL CHECK (views > 0),
    PRIMARY KEY (video_id, hour)
);
CREATE INDEX video_views_hourly_hour_idx ON media.video_views_hourly (hour);

-- trending: the current ranking, replaced as a whole by video-svc every 10 minutes (one transaction).
CREATE TABLE media.trending (
    video_id    uuid             PRIMARY KEY REFERENCES media.videos (id) ON DELETE CASCADE,
    rank        integer          NOT NULL CHECK (rank >= 1),
    score       double precision NOT NULL CHECK (score > 0),
    computed_at timestamptz      NOT NULL
);
CREATE UNIQUE INDEX trending_rank_idx ON media.trending (rank);
