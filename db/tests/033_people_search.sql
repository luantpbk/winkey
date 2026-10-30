\set ON_ERROR_STOP on

-- SOC-6a: people search matches handles by prefix and display names folded (case, diacritics, đ → d), and never
-- sequentially scans auth.users.
INSERT INTO auth.users (id, email, handle, display_name, status)
VALUES ('00000000-0000-7000-8000-0000000006a1', 'soc6a-1@example.com', 'tuan_anh', 'Tuấn Anh', 'ACTIVE'),
       ('00000000-0000-7000-8000-0000000006a2', 'soc6a-2@example.com', 'ducnv', 'Nguyễn Văn Đức', 'ACTIVE'),
       ('00000000-0000-7000-8000-0000000006a3', 'soc6a-3@example.com', 'Tuyet.Mai', 'Mai Tuyết', 'ACTIVE'),
       ('00000000-0000-7000-8000-0000000006a4', 'soc6a-4@example.com', 'tuan_gone', 'Tuấn Đã Khoá', 'SUSPENDED');

DO $$
DECLARE
    line text;
    plan text;
    ids uuid[];
BEGIN
    -- Short query (< 3 characters): handle prefix or display-name prefix, case-insensitive.
    SELECT array_agg(id ORDER BY id) INTO ids FROM auth.public_profiles p
    WHERE lower(p.handle) LIKE 'tu%' OR public.winkey_fold(p.display_name) LIKE 'tu%';
    IF ids IS DISTINCT FROM ARRAY['00000000-0000-7000-8000-0000000006a1',
                                  '00000000-0000-7000-8000-0000000006a3']::uuid[] THEN
        RAISE EXCEPTION 'TEST FAILED: short query "tu" returned %', ids;
    END IF;

    -- Longer query: handle prefix or folded display-name substring. "duc" finds "Nguyễn Văn Đức" (đ → d),
    -- "tuan" finds "Tuấn Anh" but not the suspended account.
    SELECT array_agg(id) INTO ids FROM auth.public_profiles p
    WHERE lower(p.handle) LIKE 'duc%' OR public.winkey_fold(p.display_name) LIKE '%duc%';
    IF ids IS DISTINCT FROM ARRAY['00000000-0000-7000-8000-0000000006a2']::uuid[] THEN
        RAISE EXCEPTION 'TEST FAILED: query "duc" returned %', ids;
    END IF;
    SELECT array_agg(id) INTO ids FROM auth.public_profiles p
    WHERE lower(p.handle) LIKE 'tuan%' OR public.winkey_fold(p.display_name) LIKE '%tuan%';
    IF ids IS DISTINCT FROM ARRAY['00000000-0000-7000-8000-0000000006a1']::uuid[] THEN
        RAISE EXCEPTION 'TEST FAILED: query "tuan" returned %', ids;
    END IF;

    -- EXPLAIN: on a handful of rows any full scan is cheapest, so the table gets 5000 more active users and fresh
    -- statistics (the file runs in a rolled-back transaction), and sequential scans are penalised. Each branch of the
    -- OR must then be an index condition (BitmapOr of bitmap index scans), never a scan of the whole index.
    INSERT INTO auth.users (id, email, handle, display_name)
    SELECT gen_random_uuid(), 'soc6a-bulk-' || i || '@example.com', 'bulk_' || i, 'Người dùng ' || i
    FROM generate_series(1, 5000) AS i;
    ANALYZE auth.users;
    SET LOCAL enable_seqscan = off;

    plan := '';
    FOR line IN EXECUTE $q$
        EXPLAIN SELECT p.id FROM auth.public_profiles p
        WHERE lower(p.handle) LIKE 'tu%' OR public.winkey_fold(p.display_name) LIKE 'tu%'
    $q$ LOOP
        plan := plan || line || E'\n';
    END LOOP;
    IF plan ~ 'Seq Scan on users' OR plan !~ 'Bitmap Index Scan on users_search_handle_prefix'
       OR plan !~ 'Bitmap Index Scan on users_search_name_(prefix|trgm)' THEN
        RAISE EXCEPTION 'TEST FAILED: short people search does not use the search indexes:%', E'\n' || plan;
    END IF;

    plan := '';
    FOR line IN EXECUTE $q$
        EXPLAIN SELECT p.id FROM auth.public_profiles p
        WHERE lower(p.handle) LIKE 'tuan%' OR public.winkey_fold(p.display_name) LIKE '%tuan%'
    $q$ LOOP
        plan := plan || line || E'\n';
    END LOOP;
    IF plan ~ 'Seq Scan on users' OR plan !~ 'Bitmap Index Scan on users_search_handle_prefix'
       OR plan !~ 'Bitmap Index Scan on users_search_name_trgm' THEN
        RAISE EXCEPTION 'TEST FAILED: people search does not use the search indexes:%', E'\n' || plan;
    END IF;
END $$;
