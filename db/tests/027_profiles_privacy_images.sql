\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000f1', 'soc1b-a@example.com', 'soc1b_a', 'S1B A'),
       ('00000000-0000-7000-8000-0000000000f2', 'soc1b-b@example.com', 'soc1b_b', 'S1B B');

DO $$
BEGIN
    -- Profile fields: bio length, links array of at most 5, exposed by the view.
    UPDATE auth.users SET bio = 'Xin chào', links = '[{"url":"https://winkey.vn","label":"Web"}]', is_private = true
    WHERE id = '00000000-0000-7000-8000-0000000000f1';
    IF NOT (SELECT is_private AND bio = 'Xin chào' AND jsonb_array_length(links) = 1
            FROM auth.public_profiles WHERE id = '00000000-0000-7000-8000-0000000000f1') THEN
        RAISE EXCEPTION 'TEST FAILED: public_profiles does not expose the new profile fields';
    END IF;
    BEGIN
        UPDATE auth.users SET bio = repeat('x', 301) WHERE id = '00000000-0000-7000-8000-0000000000f1';
        RAISE EXCEPTION 'TEST FAILED: a 301-character bio was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE auth.users SET links = '[1,2,3,4,5,6]' WHERE id = '00000000-0000-7000-8000-0000000000f1';
        RAISE EXCEPTION 'TEST FAILED: six links were accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE auth.users SET links = '{"url":"x"}' WHERE id = '00000000-0000-7000-8000-0000000000f1';
        RAISE EXCEPTION 'TEST FAILED: links that are not an array were accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Follow requests, blocks, mutes: no self relations, one row per pair.
    INSERT INTO social.follow_requests (requester_id, target_id)
    VALUES ('00000000-0000-7000-8000-0000000000f2', '00000000-0000-7000-8000-0000000000f1');
    BEGIN
        INSERT INTO social.follow_requests (requester_id, target_id)
        VALUES ('00000000-0000-7000-8000-0000000000f2', '00000000-0000-7000-8000-0000000000f1');
        RAISE EXCEPTION 'TEST FAILED: a duplicate follow request was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO social.blocks (blocker_id, blocked_id)
        VALUES ('00000000-0000-7000-8000-0000000000f1', '00000000-0000-7000-8000-0000000000f1');
        RAISE EXCEPTION 'TEST FAILED: blocking yourself was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO social.blocks (blocker_id, blocked_id)
    VALUES ('00000000-0000-7000-8000-0000000000f1', '00000000-0000-7000-8000-0000000000f2');
    BEGIN
        INSERT INTO social.mutes (muter_id, muted_id)
        VALUES ('00000000-0000-7000-8000-0000000000f2', '00000000-0000-7000-8000-0000000000f2');
        RAISE EXCEPTION 'TEST FAILED: muting yourself was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO social.notifications (id, user_id, kind, actor_id)
    VALUES ('00000000-0000-7000-8000-00000000f301', '00000000-0000-7000-8000-0000000000f1', 'FOLLOW_REQUEST',
            '00000000-0000-7000-8000-0000000000f2');

    -- Images: READY needs outputs, FAILED needs an error, size and type limits; the view shows READY only.
    INSERT INTO media.images (id, owner_id, purpose, content_type, size_bytes, raw_bucket, raw_key)
    VALUES ('00000000-0000-7000-8000-00000000f401', '00000000-0000-7000-8000-0000000000f1', 'AVATAR', 'image/jpeg',
            123456, 'winkey-raw', 'i/f1/f401/source');
    BEGIN
        UPDATE media.images SET status = 'READY' WHERE id = '00000000-0000-7000-8000-00000000f401';
        RAISE EXCEPTION 'TEST FAILED: READY without outputs was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE media.images SET status = 'FAILED' WHERE id = '00000000-0000-7000-8000-00000000f401';
        RAISE EXCEPTION 'TEST FAILED: FAILED without an error was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF EXISTS (SELECT 1 FROM media.ready_images WHERE id = '00000000-0000-7000-8000-00000000f401') THEN
        RAISE EXCEPTION 'TEST FAILED: ready_images shows a non-READY image';
    END IF;
    UPDATE media.images SET status = 'READY', image_key = 'i/f1/f401/image.webp', thumb_key = 'i/f1/f401/thumb.webp',
        width = 400, height = 400, output_bytes = 30000
    WHERE id = '00000000-0000-7000-8000-00000000f401';
    IF NOT EXISTS (SELECT 1 FROM media.ready_images WHERE id = '00000000-0000-7000-8000-00000000f401') THEN
        RAISE EXCEPTION 'TEST FAILED: ready_images hides a READY image';
    END IF;
    BEGIN
        INSERT INTO media.images (id, owner_id, purpose, content_type, size_bytes, raw_bucket, raw_key)
        VALUES ('00000000-0000-7000-8000-00000000f402', '00000000-0000-7000-8000-0000000000f1', 'POST', 'image/gif',
                100, 'winkey-raw', 'k');
        RAISE EXCEPTION 'TEST FAILED: a GIF was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO media.images (id, owner_id, purpose, content_type, size_bytes, raw_bucket, raw_key)
        VALUES ('00000000-0000-7000-8000-00000000f403', '00000000-0000-7000-8000-0000000000f1', 'POST', 'image/png',
                20971521, 'winkey-raw', 'k');
        RAISE EXCEPTION 'TEST FAILED: an image over 20 MiB was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    DELETE FROM social.notifications WHERE id = '00000000-0000-7000-8000-00000000f301';
    DELETE FROM social.blocks WHERE blocker_id = '00000000-0000-7000-8000-0000000000f1';
    DELETE FROM social.follow_requests WHERE target_id = '00000000-0000-7000-8000-0000000000f1';
    DELETE FROM media.images WHERE owner_id = '00000000-0000-7000-8000-0000000000f1';
    DELETE FROM auth.users WHERE id IN ('00000000-0000-7000-8000-0000000000f1', '00000000-0000-7000-8000-0000000000f2');
END $$;
