\set ON_ERROR_STOP on

-- A READY video without a storyboard is valid (best effort), and the key can be set later.
INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes,
                          status, duration_ms, published_at, hls_master_key, thumbnail_key)
VALUES ('00000000-0000-7000-8000-00000000f601', '00000000-0000-7000-8000-0000000000c0',
        'Storyboard', 'winkey-raw', 'k6', 'video/mp4', 1024,
        'READY', 60000, now(), 'v/x/a1/hls/master.m3u8', 'v/x/a1/thumb/poster.jpg');

UPDATE media.videos SET storyboard_key = 'v/x/a1/storyboard/storyboard.vtt'
WHERE id = '00000000-0000-7000-8000-00000000f601';

DO $$
BEGIN
    IF (SELECT storyboard_key FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f601')
       <> 'v/x/a1/storyboard/storyboard.vtt' THEN
        RAISE EXCEPTION 'TEST FAILED: storyboard_key not stored';
    END IF;
END $$;

\echo ok 006_storyboard
