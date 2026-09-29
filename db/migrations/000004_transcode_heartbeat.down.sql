DROP INDEX IF EXISTS media.transcode_jobs_running_heartbeat;
ALTER TABLE media.transcode_jobs DROP COLUMN IF EXISTS heartbeat_at;
