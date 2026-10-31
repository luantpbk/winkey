-- The enum value FRIEND_ACCEPTED stays (PostgreSQL cannot drop an enum value); its rows must be gone before the
-- older constraint comes back.
DELETE FROM social.notifications WHERE kind::text = 'FRIEND_ACCEPTED';
ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind::text = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('NEW_SUBSCRIBER', 'FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED') AND video_id IS NULL
        AND comment_id IS NULL AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('POST_COMMENT', 'POST_COMMENT_REPLY') AND post_id IS NOT NULL AND post_comment_id IS NOT NULL
        AND video_id IS NULL AND comment_id IS NULL)
    OR (kind::text IN ('POST_MENTION', 'POST_RESHARE', 'POST_REACTION') AND post_id IS NOT NULL
        AND post_comment_id IS NULL AND video_id IS NULL AND comment_id IS NULL)
);
DROP TABLE social.friend_request_dismissals;
