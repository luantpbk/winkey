\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fb01', '00000000-0000-7000-8000-0000000000c0',
        'MUX1', '', 'winkey-raw', 'm1', 'video/mp4', 1024);

INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, is_default, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fb11', '00000000-0000-7000-8000-00000000fb01', 'vi', 'Thuyết minh', 'voiceover', true,
        'winkey-raw', 'o/v/audio/1', 'audio/flac', 1000),
       ('00000000-0000-7000-8000-00000000fb12', '00000000-0000-7000-8000-00000000fb01', 'vi', 'Lồng tiếng', 'dub', false,
        'winkey-raw', 'o/v/audio/2', 'audio/wav', 1000);

DO $$
BEGIN
    IF (SELECT status FROM media.video_audio_tracks WHERE id = '00000000-0000-7000-8000-00000000fb11') <> 'UPLOADING' THEN
        RAISE EXCEPTION 'TEST FAILED: default status is UPLOADING';
    END IF;
END $$;

-- One track per (lang, kind).
DO $$
BEGIN
    BEGIN
        INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, raw_bucket, raw_key, content_type, size_bytes)
        VALUES ('00000000-0000-7000-8000-00000000fb13', '00000000-0000-7000-8000-00000000fb01', 'vi', 'x', 'voiceover',
                'winkey-raw', 'k', 'audio/flac', 1);
        RAISE EXCEPTION 'TEST FAILED: duplicate (lang, kind) accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

-- At most one default per video.
DO $$
BEGIN
    BEGIN
        UPDATE media.video_audio_tracks SET is_default = true WHERE id = '00000000-0000-7000-8000-00000000fb12';
        RAISE EXCEPTION 'TEST FAILED: second default accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

-- READY requires a playlist key, and only READY has one.
DO $$
BEGIN
    BEGIN
        UPDATE media.video_audio_tracks SET status = 'READY' WHERE id = '00000000-0000-7000-8000-00000000fb11';
        RAISE EXCEPTION 'TEST FAILED: READY without playlist_key accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
UPDATE media.video_audio_tracks SET status = 'READY', playlist_key = 'v/x/a1/audio/t/index.m3u8', duration_ms = 1000
WHERE id = '00000000-0000-7000-8000-00000000fb11';

-- Bad kind and bad language are rejected.
DO $$
BEGIN
    BEGIN
        INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, raw_bucket, raw_key, content_type, size_bytes)
        VALUES ('00000000-0000-7000-8000-00000000fb14', '00000000-0000-7000-8000-00000000fb01', 'EN', 'x', 'dub',
                'winkey-raw', 'k', 'audio/flac', 1);
        RAISE EXCEPTION 'TEST FAILED: lang EN accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, raw_bucket, raw_key, content_type, size_bytes)
        VALUES ('00000000-0000-7000-8000-00000000fb15', '00000000-0000-7000-8000-00000000fb01', 'en', 'x', 'music',
                'winkey-raw', 'k', 'audio/flac', 1);
        RAISE EXCEPTION 'TEST FAILED: kind music accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

-- Subtitles gain kind, defaulting to subtitles.
INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fb01', 'vi', 'Tiếng Việt', 'v/x/subtitles/vi-1.vtt', 10);
DO $$
BEGIN
    IF (SELECT kind FROM media.video_subtitles WHERE video_id = '00000000-0000-7000-8000-00000000fb01') <> 'subtitles' THEN
        RAISE EXCEPTION 'TEST FAILED: subtitle kind default';
    END IF;
END $$;

-- Deleting the video cascades to its tracks.
DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fb01';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.video_audio_tracks WHERE video_id = '00000000-0000-7000-8000-00000000fb01') THEN
        RAISE EXCEPTION 'TEST FAILED: cascade';
    END IF;
END $$;
\echo ok 021_audio_tracks
