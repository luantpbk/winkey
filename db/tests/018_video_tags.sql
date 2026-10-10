\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, tags, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f801', '00000000-0000-7000-8000-0000000000c0',
        'Video số một', 'Không liên quan', ARRAY['Ẩm thực', 'phở'], 'winkey-raw', 't1', 'video/mp4', 1024),
       ('00000000-0000-7000-8000-00000000f802', '00000000-0000-7000-8000-0000000000c0',
        'Video số hai', 'Nói về phở trong mô tả', '{}', 'winkey-raw', 't2', 'video/mp4', 1024);

-- Tags are searchable, folded like the title, and outrank a description match (weight A vs B).
DO $$
DECLARE
    q tsquery := plainto_tsquery('simple', public.winkey_fold('am thuc'));
    q2 tsquery := plainto_tsquery('simple', public.winkey_fold('pho'));
    first uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f801' AND search_vector @@ q) THEN
        RAISE EXCEPTION 'TEST FAILED: unaccented tag should match';
    END IF;
    SELECT id INTO first FROM media.videos WHERE search_vector @@ q2 ORDER BY ts_rank_cd(search_vector, q2) DESC LIMIT 1;
    IF first <> '00000000-0000-7000-8000-00000000f801' THEN
        RAISE EXCEPTION 'TEST FAILED: tag match should outrank a description match';
    END IF;
END $$;

-- Updating tags refreshes the generated vector.
UPDATE media.videos SET tags = ARRAY['du lịch'] WHERE id = '00000000-0000-7000-8000-00000000f801';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f801'
               AND search_vector @@ plainto_tsquery('simple', 'am thuc')) THEN
        RAISE EXCEPTION 'TEST FAILED: old tag still matches after update';
    END IF;
END $$;

-- At most 10 tags.
DO $$
BEGIN
    BEGIN
        UPDATE media.videos SET tags = ARRAY['a','b','c','d','e','f','g','h','i','j','k']
        WHERE id = '00000000-0000-7000-8000-00000000f802';
        RAISE EXCEPTION 'TEST FAILED: 11 tags accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END $$;

\echo ok 018_video_tags
