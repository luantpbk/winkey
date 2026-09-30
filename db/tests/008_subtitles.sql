\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f801', '00000000-0000-7000-8000-0000000000c0',
        'Subtitles', 'winkey-raw', 'k8', 'video/mp4', 1024);

INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f801', 'vi', 'Tiếng Việt',
        'v/00000000-0000-7000-8000-00000000f801/subtitles/vi-1.vtt', 120),
       ('00000000-0000-7000-8000-00000000f801', 'en-US', 'English (US)',
        'v/00000000-0000-7000-8000-00000000f801/subtitles/en-US-1.vtt', 80);

DO $$
DECLARE
    bad text[] := ARRAY[
        -- one track per language
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'vi', 'x', 'v/a/subtitles/vi-2.vtt', 1)$q$,
        -- malformed language tags
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'VI', 'x', 'v/a/subtitles/x.vtt', 1)$q$,
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'en_us', 'x', 'v/a/subtitles/x.vtt', 1)$q$,
        -- empty label, unknown source, key outside v/{id}/subtitles/, size limits
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'fr', '', 'v/a/subtitles/x.vtt', 1)$q$,
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, source, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'fr', 'x', 'OTHER', 'v/a/subtitles/x.vtt', 1)$q$,
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'fr', 'x', 'raw/x.vtt', 1)$q$,
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'fr', 'x', 'v/a/subtitles/x.vtt', 0)$q$,
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f801', 'fr', 'x', 'v/a/subtitles/x.vtt', 524289)$q$,
        -- unknown video
        $q$INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes)
           VALUES ('00000000-0000-7000-8000-00000000f8ff', 'fr', 'x', 'v/a/subtitles/x.vtt', 1)$q$
    ];
    q text;
BEGIN
    FOREACH q IN ARRAY bad LOOP
        BEGIN
            EXECUTE q;
            RAISE EXCEPTION 'TEST FAILED: accepted %', q;
        EXCEPTION
            WHEN unique_violation OR check_violation OR foreign_key_violation THEN NULL;
        END;
    END LOOP;
END $$;

-- Deleting the video removes its tracks.
DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f801';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.video_subtitles WHERE video_id = '00000000-0000-7000-8000-00000000f801') THEN
        RAISE EXCEPTION 'TEST FAILED: subtitles survived the video';
    END IF;
END $$;

\echo ok 008_subtitles
