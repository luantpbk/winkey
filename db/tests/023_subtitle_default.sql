\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fd01', '00000000-0000-7000-8000-0000000000c0',
        'DEF1', '', 'winkey-raw', 'd1', 'video/mp4', 1024);

INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fd01', 'vi', 'Tiếng Việt', 'v/x/subtitles/vi-1.vtt', 10),
       ('00000000-0000-7000-8000-00000000fd01', 'en', 'English', 'v/x/subtitles/en-1.vtt', 10);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.video_subtitles WHERE video_id = '00000000-0000-7000-8000-00000000fd01' AND is_default) THEN
        RAISE EXCEPTION 'TEST FAILED: is_default defaults to false';
    END IF;
END $$;

-- One default per video.
UPDATE media.video_subtitles SET is_default = true
WHERE video_id = '00000000-0000-7000-8000-00000000fd01' AND lang = 'vi';

DO $$
BEGIN
    BEGIN
        UPDATE media.video_subtitles SET is_default = true
        WHERE video_id = '00000000-0000-7000-8000-00000000fd01' AND lang = 'en';
        RAISE EXCEPTION 'TEST FAILED: a second default was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fd01';
