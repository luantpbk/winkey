-- Liveness of running transcode jobs, for the stuck-job reconciler (task V3b).
-- The worker sets heartbeat_at = now() whenever it calls msg.InProgress() (every 30s).
-- A RUNNING job whose heartbeat is older than ack_wait × max_deliver is considered dead.
ALTER TABLE media.transcode_jobs ADD COLUMN heartbeat_at timestamptz;

CREATE INDEX transcode_jobs_running_heartbeat ON media.transcode_jobs (heartbeat_at)
    WHERE status = 'RUNNING';
