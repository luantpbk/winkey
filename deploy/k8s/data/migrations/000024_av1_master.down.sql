ALTER TABLE media.videos DROP CONSTRAINT IF EXISTS videos_av1_master_key_prefix;
ALTER TABLE media.videos DROP COLUMN IF EXISTS hls_av1_master_key;
