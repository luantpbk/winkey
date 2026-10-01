\set ON_ERROR_STOP on

INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-000000001201', '00000000-0000-7000-8000-0000000012c1'),
    ('00000000-0000-7000-8000-000000001202', '00000000-0000-7000-8000-0000000012c1');
INSERT INTO social.playlists (id, owner_id, title) VALUES
    ('00000000-0000-7000-8000-000000001211', '00000000-0000-7000-8000-0000000012a1', 'Nhạc');
INSERT INTO social.playlists (id, owner_id, kind, title) VALUES
    ('00000000-0000-7000-8000-000000001212', '00000000-0000-7000-8000-0000000012a1', 'WATCH_LATER', 'Xem sau');

DO $$
DECLARE
    bad text[] := ARRAY[
        -- second watch-later list for the same user
        $q$INSERT INTO social.playlists (id, owner_id, kind, title)
           VALUES ('00000000-0000-7000-8000-000000001213', '00000000-0000-7000-8000-0000000012a1', 'WATCH_LATER', 'x')$q$,
        -- watch-later must stay private
        $q$UPDATE social.playlists SET visibility = 'PUBLIC' WHERE id = '00000000-0000-7000-8000-000000001212'$q$,
        -- empty title, unknown visibility
        $q$INSERT INTO social.playlists (id, owner_id, title)
           VALUES ('00000000-0000-7000-8000-000000001214', '00000000-0000-7000-8000-0000000012a1', '')$q$,
        $q$UPDATE social.playlists SET visibility = 'SECRET' WHERE id = '00000000-0000-7000-8000-000000001211'$q$,
        -- unknown video (FK) and duplicate item
        $q$INSERT INTO social.playlist_items (playlist_id, video_id, position)
           VALUES ('00000000-0000-7000-8000-000000001211', '00000000-0000-7000-8000-0000000012ff', 1)$q$
    ];
    q text;
    n int;
BEGIN
    FOREACH q IN ARRAY bad LOOP
        BEGIN
            EXECUTE q;
            RAISE EXCEPTION 'TEST FAILED: accepted %', q;
        EXCEPTION
            WHEN unique_violation OR check_violation OR foreign_key_violation THEN NULL;
        END;
    END LOOP;

    INSERT INTO social.playlist_items (playlist_id, video_id, position) VALUES
        ('00000000-0000-7000-8000-000000001211', '00000000-0000-7000-8000-000000001201', 1048576),
        ('00000000-0000-7000-8000-000000001211', '00000000-0000-7000-8000-000000001202', 2097152);
    SELECT item_count INTO n FROM social.playlists WHERE id = '00000000-0000-7000-8000-000000001211';
    IF n <> 2 THEN RAISE EXCEPTION 'TEST FAILED: item_count % after 2 inserts', n; END IF;

    BEGIN
        INSERT INTO social.playlist_items (playlist_id, video_id, position)
        VALUES ('00000000-0000-7000-8000-000000001211', '00000000-0000-7000-8000-000000001201', 3145728);
        RAISE EXCEPTION 'TEST FAILED: duplicate video accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- Renumbering through a temporary duplicate position works when the constraint is deferred.
    SET CONSTRAINTS social.playlist_items_position DEFERRED;
    UPDATE social.playlist_items SET position = 2097152 WHERE video_id = '00000000-0000-7000-8000-000000001201';
    UPDATE social.playlist_items SET position = 1048576 WHERE video_id = '00000000-0000-7000-8000-000000001202';
    SET CONSTRAINTS social.playlist_items_position IMMEDIATE;

    -- Deleting a video removes it from playlists and fixes the count.
    DELETE FROM social.videos WHERE id = '00000000-0000-7000-8000-000000001201';
    SELECT item_count INTO n FROM social.playlists WHERE id = '00000000-0000-7000-8000-000000001211';
    IF n <> 1 THEN RAISE EXCEPTION 'TEST FAILED: item_count % after video delete', n; END IF;

    -- The item cap is enforced by the CHECK on item_count.
    UPDATE social.playlists SET item_count = 5000 WHERE id = '00000000-0000-7000-8000-000000001212';
    BEGIN
        INSERT INTO social.playlist_items (playlist_id, video_id, position)
        VALUES ('00000000-0000-7000-8000-000000001212', '00000000-0000-7000-8000-000000001202', 1);
        RAISE EXCEPTION 'TEST FAILED: 5001st item accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Deleting a playlist cascades to its items.
    DELETE FROM social.playlists WHERE id = '00000000-0000-7000-8000-000000001211';
    IF EXISTS (SELECT 1 FROM social.playlist_items WHERE playlist_id = '00000000-0000-7000-8000-000000001211') THEN
        RAISE EXCEPTION 'TEST FAILED: items left after playlist delete';
    END IF;
END $$;

\echo ok 012_playlists
