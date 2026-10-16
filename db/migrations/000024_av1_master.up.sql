-- Task ENC2 phase 2 (ADR-041): the master playlist of a video's separate AV1 set. NULL until the av1-upgrade job
-- has stored a complete set; its renditions are the media.video_renditions rows with codec = 'av1'. The set lives
-- under v/{id}/av1/{run}/, outside the v/{id}/a{n}/ attempt directories, so an H.264 re-encode keeps it.
ALTER TABLE media.videos ADD COLUMN hls_av1_master_key text;
ALTER TABLE media.videos ADD CONSTRAINT videos_av1_master_key_prefix
    CHECK (hls_av1_master_key IS NULL OR hls_av1_master_key LIKE 'v/' || id::text || '/av1/%');
