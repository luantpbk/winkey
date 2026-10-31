-- SOC-6b (ADR-049, decision 2026-10-31): friends = mutual follows (social.subscriptions in both directions), so there
-- is no friendship table. social-svc lists friends and friend requests (followers the caller does not follow back)
-- from social.subscriptions; this migration only adds the dismissals of friend requests and one notification kind.
-- EXPLAIN tests for both lists: db/tests/034.

-- "Hide this friend request": user_id dismissed follower_id, who keeps following. social-svc deletes the row when
-- user_id follows follower_id back, and when either blocks the other. No cross-schema FKs (ADR-007).
CREATE TABLE social.friend_request_dismissals (
    user_id     uuid NOT NULL,
    follower_id uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, follower_id),
    CONSTRAINT friend_request_dismissals_not_self CHECK (user_id <> follower_id)
);

-- FRIEND_ACCEPTED: actor followed the recipient back. Like NEW_SUBSCRIBER it carries no video, comment or post, and
-- notifications_dedup (user_id, kind, …, actor_id) makes it once per pair. kind::text: a new enum value cannot be
-- referenced as a literal in the transaction that adds it.
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'FRIEND_ACCEPTED';
ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind::text = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('NEW_SUBSCRIBER', 'FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED', 'FRIEND_ACCEPTED')
        AND video_id IS NULL AND comment_id IS NULL AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('POST_COMMENT', 'POST_COMMENT_REPLY') AND post_id IS NOT NULL AND post_comment_id IS NOT NULL
        AND video_id IS NULL AND comment_id IS NULL)
    OR (kind::text IN ('POST_MENTION', 'POST_RESHARE', 'POST_REACTION') AND post_id IS NOT NULL
        AND post_comment_id IS NULL AND video_id IS NULL AND comment_id IS NULL)
);
