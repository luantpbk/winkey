\set ON_ERROR_STOP on

-- The slug folds case and Vietnamese accents (đ → d) and turns punctuation/space runs into one '-'.
DO $$
BEGIN
    IF public.winkey_tag_slug('Phim ngắn') <> 'phim-ngan' THEN RAISE EXCEPTION 'TEST FAILED: Phim ngắn'; END IF;
    IF public.winkey_tag_slug('  ĐẲNG  lang nữ!! ') <> 'dang-lang-nu' THEN RAISE EXCEPTION 'TEST FAILED: Đẳng'; END IF;
    IF public.winkey_tag_slug('#Hà_Nội 2026') <> 'ha-noi-2026' THEN RAISE EXCEPTION 'TEST FAILED: Hà Nội'; END IF;
    IF public.winkey_tag_slug('phim-ngan') <> 'phim-ngan' THEN RAISE EXCEPTION 'TEST FAILED: slug is idempotent'; END IF;
    IF public.winkey_tag_slug('!!!') <> '' THEN RAISE EXCEPTION 'TEST FAILED: punctuation only → empty'; END IF;
    IF public.winkey_tag_slug('电影') <> '' THEN RAISE EXCEPTION 'TEST FAILED: non-Latin → empty'; END IF;
END $$;

INSERT INTO media.videos (id, owner_id, title, description, tags, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f901', '00000000-0000-7000-8000-0000000000c0',
        'Video một', '', ARRAY['Phim ngắn', '!!!', 'Dân gian'], 'winkey-raw', 's1', 'video/mp4', 1024),
       ('00000000-0000-7000-8000-00000000f902', '00000000-0000-7000-8000-0000000000c0',
        'Video hai', '', '{}', 'winkey-raw', 's2', 'video/mp4', 1024);

-- tag_slugs is aligned with tags (same length and order, '' kept) and empty for no tags.
DO $$
DECLARE
    got text[];
BEGIN
    SELECT tag_slugs INTO got FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f901';
    IF got IS DISTINCT FROM ARRAY['phim-ngan', '', 'dan-gian'] THEN
        RAISE EXCEPTION 'TEST FAILED: aligned slugs, got %', got;
    END IF;
    SELECT tag_slugs INTO got FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f902';
    IF got IS DISTINCT FROM '{}'::text[] THEN
        RAISE EXCEPTION 'TEST FAILED: no tags → empty slugs, got %', got;
    END IF;
END $$;

-- Updating tags refreshes the slugs, and the containment lookup used by listVideos?tag= works.
UPDATE media.videos SET tags = ARRAY['phim  NGẮN'] WHERE id = '00000000-0000-7000-8000-00000000f902';
DO $$
BEGIN
    IF (SELECT count(*) FROM media.videos WHERE tag_slugs @> ARRAY['phim-ngan']
        AND id IN ('00000000-0000-7000-8000-00000000f901', '00000000-0000-7000-8000-00000000f902')) <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: both spellings should share the slug';
    END IF;
END $$;

\echo ok 019_tag_slugs
