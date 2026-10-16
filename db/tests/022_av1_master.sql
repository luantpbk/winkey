\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fc01', '00000000-0000-7000-8000-0000000000c0',
        'ENC2', '', 'winkey-raw', 'e1', 'video/mp4', 1024);

DO $$
BEGIN
    IF (SELECT hls_av1_master_key FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fc01') IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: hls_av1_master_key defaults to NULL';
    END IF;
END $$;

-- A key under the video's own v/{id}/av1/ prefix is accepted.
UPDATE media.videos SET hls_av1_master_key = 'v/00000000-0000-7000-8000-00000000fc01/av1/01a0/master.m3u8'
WHERE id = '00000000-0000-7000-8000-00000000fc01';

-- Another video's prefix, or the H.264 attempt directory, is refused.
DO $$
BEGIN
    BEGIN
        UPDATE media.videos SET hls_av1_master_key = 'v/00000000-0000-7000-8000-00000000ffff/av1/x/master.m3u8'
        WHERE id = '00000000-0000-7000-8000-00000000fc01';
        RAISE EXCEPTION 'TEST FAILED: a key of another video was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE media.videos SET hls_av1_master_key = 'v/00000000-0000-7000-8000-00000000fc01/a1/hls-av1/master.m3u8'
        WHERE id = '00000000-0000-7000-8000-00000000fc01';
        RAISE EXCEPTION 'TEST FAILED: a key inside an attempt directory was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fc01';
