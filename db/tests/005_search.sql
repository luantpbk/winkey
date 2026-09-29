\set ON_ERROR_STOP on

-- Folding: case and Vietnamese diacritics (including đ) are removed.
DO $$
BEGIN
    IF public.winkey_fold('Hà Nội Đẹp Lắm') <> 'ha noi dep lam' THEN
        RAISE EXCEPTION 'TEST FAILED: winkey_fold gave %', public.winkey_fold('Hà Nội Đẹp Lắm');
    END IF;
END $$;

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f501', '00000000-0000-7000-8000-0000000000c0',
        'Du lịch Hà Nội mùa thu', 'Phố cổ và hồ Gươm', 'winkey-raw', 'k1', 'video/mp4', 1024),
       ('00000000-0000-7000-8000-00000000f502', '00000000-0000-7000-8000-0000000000c0',
        'Nấu phở bò', 'Công thức Hà Nội', 'winkey-raw', 'k2', 'video/mp4', 1024);

-- The generated vector matches unaccented queries; the title (weight A) outranks the description (B).
DO $$
DECLARE
    q tsquery := plainto_tsquery('simple', public.winkey_fold('ha noi'));
    first uuid;
BEGIN
    IF (SELECT count(*) FROM media.videos WHERE search_vector @@ q) <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: unaccented query should match both videos';
    END IF;
    SELECT id INTO first FROM media.videos WHERE search_vector @@ q
    ORDER BY ts_rank_cd(search_vector, q) DESC LIMIT 1;
    IF first <> '00000000-0000-7000-8000-00000000f501' THEN
        RAISE EXCEPTION 'TEST FAILED: title match should rank first';
    END IF;
END $$;

-- Trigram similarity tolerates a typo in the title.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM media.videos
                   WHERE public.winkey_fold(title) % public.winkey_fold('nau pho bo')) THEN
        RAISE EXCEPTION 'TEST FAILED: trigram match on folded title';
    END IF;
END $$;

-- Editing the title regenerates the vector.
UPDATE media.videos SET title = 'Sài Gòn về đêm' WHERE id = '00000000-0000-7000-8000-00000000f502';
DO $$
BEGIN
    IF NOT (SELECT search_vector @@ plainto_tsquery('simple', 'sai gon')
            FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f502') THEN
        RAISE EXCEPTION 'TEST FAILED: vector not regenerated after title update';
    END IF;
END $$;

\echo ok 005_search
