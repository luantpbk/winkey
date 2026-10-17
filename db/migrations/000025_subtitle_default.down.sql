DROP INDEX IF EXISTS media.video_subtitles_one_default;
ALTER TABLE media.video_subtitles DROP COLUMN IF EXISTS is_default;
