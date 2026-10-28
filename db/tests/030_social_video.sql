\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000b1', 'soc2b@example.com', 'soc2b_a', 'S2B A');

DO $$
DECLARE
    u constant uuid := '00000000-0000-7000-8000-0000000000b1';
    v constant uuid := '00000000-0000-7000-8000-00000000b001';
BEGIN
    -- Existing and new uploads default to FILM.
    INSERT INTO media.videos (id, owner_id, title, visibility, raw_bucket, raw_key, content_type, size_bytes)
    VALUES (gen_random_uuid(), u, 'Phim', 'PUBLIC', 'raw', 'k1', 'video/mp4', 1000);
    IF EXISTS (SELECT 1 FROM media.videos WHERE owner_id = u AND purpose <> 'FILM') THEN
        RAISE EXCEPTION 'TEST FAILED: default purpose is not FILM';
    END IF;
    -- A social video must be UNLISTED.
    BEGIN
        INSERT INTO media.videos (id, owner_id, title, visibility, purpose, raw_bucket, raw_key, content_type, size_bytes)
        VALUES (gen_random_uuid(), u, 'x', 'PUBLIC', 'SOCIAL', 'raw', 'k2', 'video/mp4', 1000);
        RAISE EXCEPTION 'TEST FAILED: a PUBLIC social video was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO media.videos (id, owner_id, title, visibility, purpose, raw_bucket, raw_key, content_type, size_bytes)
        VALUES (gen_random_uuid(), u, 'big', 'UNLISTED', 'SOCIAL', 'raw', 'k3', 'video/mp4', 314572801);
        RAISE EXCEPTION 'TEST FAILED: a social video over 300 MiB was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO media.videos (id, owner_id, title, visibility, purpose, raw_bucket, raw_key, content_type, size_bytes)
    VALUES (v, u, 'clip', 'UNLISTED', 'SOCIAL', 'raw', 'k4', 'video/mp4', 1000);
    BEGIN
        UPDATE media.videos SET visibility = 'PUBLIC' WHERE id = v;
        RAISE EXCEPTION 'TEST FAILED: a social video became PUBLIC';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- attached_at only for social videos.
    BEGIN
        UPDATE media.videos SET attached_at = now() WHERE owner_id = u AND purpose = 'FILM';
        RAISE EXCEPTION 'TEST FAILED: attached_at was set on a FILM';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- One live post per social video; films may be embedded by many posts.
    INSERT INTO social.videos (id, owner_id, purpose) VALUES (v, u, 'SOCIAL');
    INSERT INTO social.posts (id, author_id, video_id, video_social) VALUES ('00000000-0000-7000-8000-00000000b101', u, v, true);
    BEGIN
        INSERT INTO social.posts (id, author_id, video_id, video_social) VALUES ('00000000-0000-7000-8000-00000000b102', u, v, true);
        RAISE EXCEPTION 'TEST FAILED: a social video was attached to two live posts';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    UPDATE social.posts SET status = 'DELETED' WHERE id = '00000000-0000-7000-8000-00000000b101';
    INSERT INTO social.posts (id, author_id, video_id, video_social) VALUES ('00000000-0000-7000-8000-00000000b103', u, v, true);
    BEGIN
        INSERT INTO social.posts (id, author_id, video_social) VALUES ('00000000-0000-7000-8000-00000000b104', u, true);
        RAISE EXCEPTION 'TEST FAILED: video_social without a video was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO social.videos (id, owner_id, purpose) VALUES (gen_random_uuid(), u, 'CLIP');
        RAISE EXCEPTION 'TEST FAILED: an unknown purpose was accepted in social.videos';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END
$$;
