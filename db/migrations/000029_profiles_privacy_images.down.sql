-- The notification kinds FOLLOW_REQUEST and FOLLOW_REQUEST_APPROVED stay (PostgreSQL cannot drop enum values);
-- the rows using them are deleted so an older social-svc never reads them.
DROP VIEW IF EXISTS media.ready_images;
DROP TABLE IF EXISTS media.images;
DROP TYPE IF EXISTS media.image_status;
DROP TYPE IF EXISTS media.image_purpose;
DELETE FROM social.notifications WHERE kind::text IN ('FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED');
ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL)
    OR (kind IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL)
    OR (kind = 'NEW_SUBSCRIBER' AND video_id IS NULL AND comment_id IS NULL)
);
DROP INDEX IF EXISTS social.subscriptions_subscriber_page;
DROP INDEX IF EXISTS social.subscriptions_channel_page;
DROP TABLE IF EXISTS social.mutes;
DROP TABLE IF EXISTS social.blocks;
DROP TABLE IF EXISTS social.follow_requests;
DROP VIEW IF EXISTS auth.public_profiles;
CREATE VIEW auth.public_profiles AS
SELECT id, handle::text AS handle, display_name, avatar_key
FROM auth.users
WHERE status = 'ACTIVE';
ALTER TABLE auth.users
    DROP CONSTRAINT IF EXISTS users_links_shape,
    DROP CONSTRAINT IF EXISTS users_bio_len,
    DROP COLUMN IF EXISTS is_private,
    DROP COLUMN IF EXISTS banner_key,
    DROP COLUMN IF EXISTS links,
    DROP COLUMN IF EXISTS bio;
