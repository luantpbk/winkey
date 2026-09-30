DROP TABLE IF EXISTS media.outbox;
DROP TABLE IF EXISTS media.transcode_jobs;
DROP TABLE IF EXISTS media.video_renditions;
DROP TABLE IF EXISTS media.videos;
DROP FUNCTION IF EXISTS media.guard_video_status();
DROP TYPE IF EXISTS media.job_status;
DROP TYPE IF EXISTS media.visibility;
DROP TYPE IF EXISTS media.video_status;
