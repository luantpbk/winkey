-- The enum values POST_* (social.notification_kind) and POST / POST_COMMENT (social.report_target) stay:
-- PostgreSQL cannot drop an enum value, and rows using them must be gone before an older social-svc runs.
DELETE FROM social.notifications WHERE kind::text LIKE 'POST\_%';
DELETE FROM social.reports WHERE target_type::text IN ('POST', 'POST_COMMENT');

DROP INDEX social.notifications_post_comment;
DROP INDEX social.notifications_post;
DROP INDEX social.notifications_dedup;
CREATE UNIQUE INDEX notifications_dedup ON social.notifications (user_id, kind, COALESCE(comment_id, video_id, actor_id));

ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind::text = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL)
    OR (kind::text IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL)
    OR (kind::text IN ('NEW_SUBSCRIBER', 'FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED') AND video_id IS NULL
        AND comment_id IS NULL)
);
ALTER TABLE social.notifications DROP COLUMN post_comment_id, DROP COLUMN post_id;

DROP TABLE social.post_scores;
DROP TABLE social.post_mentions;
DROP TABLE social.post_hashtags;
DROP TABLE social.post_comments;
DROP FUNCTION social.post_comment_counts();
DROP FUNCTION social.guard_post_comment_parent();
DROP TABLE social.post_reactions;
DROP FUNCTION social.post_reaction_counts();
DROP TABLE social.post_media;
DROP TABLE social.posts;
DROP FUNCTION social.post_reshare_counts();
DROP TYPE social.reaction_kind;
DROP TYPE social.post_status;
DROP TYPE social.post_visibility;
