-- Task N1 (ADR-023): in-app notifications, owned by social-svc. One row per recipient (fan-out on write).
-- Rows are created by social-svc in the same transaction as the comment / subscription, or by its social-videos
-- consumer on video.ready / video.visibility_changed (same transaction as the projection update).
CREATE TYPE social.notification_kind AS ENUM ('VIDEO_PUBLISHED', 'VIDEO_COMMENT', 'COMMENT_REPLY', 'NEW_SUBSCRIBER');

CREATE TABLE social.notifications (
    id         uuid PRIMARY KEY,                    -- UUIDv7 from the app
    user_id    uuid NOT NULL,                       -- recipient
    kind       social.notification_kind NOT NULL,
    actor_id   uuid NOT NULL,                       -- channel (VIDEO_PUBLISHED), comment author, or subscriber
    video_id   uuid REFERENCES social.videos (id) ON DELETE CASCADE,
    comment_id uuid REFERENCES social.comments (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at    timestamptz,
    CONSTRAINT notifications_not_self CHECK (user_id <> actor_id),
    CONSTRAINT notifications_refs CHECK (
        (kind = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL)
        OR (kind IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL)
        OR (kind = 'NEW_SUBSCRIBER' AND video_id IS NULL AND comment_id IS NULL)
    )
);

-- At most one notification per recipient and subject: a re-sent video.ready, a PRIVATE → PUBLIC → PRIVATE →
-- PUBLIC flip or an unsubscribe + subscribe never notify twice. Writers use INSERT … ON CONFLICT DO NOTHING.
-- Subject = the comment, else the video, else the actor (NEW_SUBSCRIBER).
CREATE UNIQUE INDEX notifications_dedup ON social.notifications (user_id, kind, COALESCE(comment_id, video_id, actor_id));

-- listNotifications (keyset on created_at, id) and the unread list / badge count.
CREATE INDEX notifications_user ON social.notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_user_unread ON social.notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

-- ON DELETE CASCADE from videos / comments, and the 90-day janitor.
CREATE INDEX notifications_video ON social.notifications (video_id) WHERE video_id IS NOT NULL;
CREATE INDEX notifications_comment ON social.notifications (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX notifications_created ON social.notifications (created_at);
