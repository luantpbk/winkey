DROP INDEX social.posts_one_per_social_video;
ALTER TABLE social.posts DROP CONSTRAINT posts_video_social, DROP COLUMN video_social;
ALTER TABLE social.videos DROP CONSTRAINT social_videos_purpose, DROP COLUMN purpose;
-- Social videos would become ordinary UNLISTED films; delete them instead (their rows cascade per existing FKs).
DELETE FROM media.videos WHERE purpose = 'SOCIAL';
DROP INDEX media.videos_social_unattached;
ALTER TABLE media.videos DROP CONSTRAINT videos_attached_social, DROP CONSTRAINT videos_social_size, DROP CONSTRAINT videos_social_unlisted;
ALTER TABLE media.videos DROP COLUMN attached_at, DROP COLUMN purpose;
DROP TYPE media.video_purpose;
