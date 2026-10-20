-- Task HIST1 (ADR-044): signed-in viewers' watch history, written by video-svc when a view report passes the view
-- threshold (one upsert per report) and read by GET /v1/me/history. user_id is auth.users.id; no cross-schema FK
-- (as everywhere else). A deleted video takes its rows with it. video-svc keeps at most 500 rows per user.
CREATE TABLE media.watch_history (
    user_id    uuid        NOT NULL,
    video_id   uuid        NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    watched_at timestamptz NOT NULL DEFAULT now(),
    watched_ms bigint      NOT NULL CHECK (watched_ms >= 0),
    PRIMARY KEY (user_id, video_id)
);

-- Page read and pruning: WHERE user_id = $1 ORDER BY watched_at DESC, video_id DESC.
CREATE INDEX watch_history_recent ON media.watch_history (user_id, watched_at DESC, video_id DESC);
