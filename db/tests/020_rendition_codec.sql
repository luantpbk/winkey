\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fa01', '00000000-0000-7000-8000-0000000000c0',
        'AV1', '', 'winkey-raw', 'a1', 'video/mp4', 1024);

-- A row without codec is H.264 (old writers keep working).
INSERT INTO media.video_renditions (video_id, name, width, height, bitrate_kbps, playlist_key)
VALUES ('00000000-0000-7000-8000-00000000fa01', '1080p', 1920, 1080, 5000, 'v/x/hls/1080p/index.m3u8');
DO $$
BEGIN
    IF (SELECT codec FROM media.video_renditions WHERE video_id = '00000000-0000-7000-8000-00000000fa01') <> 'h264' THEN
        RAISE EXCEPTION 'TEST FAILED: default codec is h264';
    END IF;
END $$;

-- The same rendition name can exist once per codec.
INSERT INTO media.video_renditions (video_id, codec, name, width, height, bitrate_kbps, playlist_key)
VALUES ('00000000-0000-7000-8000-00000000fa01', 'av1', '1080p', 1920, 1080, 3000, 'v/x/hls-av1/1080p/index.m3u8');

-- ...but not twice for the same codec.
DO $$
BEGIN
    BEGIN
        INSERT INTO media.video_renditions (video_id, codec, name, width, height, bitrate_kbps, playlist_key)
        VALUES ('00000000-0000-7000-8000-00000000fa01', 'av1', '1080p', 1920, 1080, 3000, 'dup');
        RAISE EXCEPTION 'TEST FAILED: duplicate (video, codec, name) accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

-- Unknown codecs are rejected.
DO $$
BEGIN
    BEGIN
        INSERT INTO media.video_renditions (video_id, codec, name, width, height, bitrate_kbps, playlist_key)
        VALUES ('00000000-0000-7000-8000-00000000fa01', 'hevc', '720p', 1280, 720, 2000, 'k');
        RAISE EXCEPTION 'TEST FAILED: codec hevc accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

-- Deleting the video still cascades to every codec.
DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fa01';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.video_renditions WHERE video_id = '00000000-0000-7000-8000-00000000fa01') THEN
        RAISE EXCEPTION 'TEST FAILED: cascade';
    END IF;
END $$;
\echo ok 020_rendition_codec
