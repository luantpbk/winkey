\set ON_ERROR_STOP on

-- Owner A has two videos, owner B one.
INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-000000001701', '00000000-0000-7000-8000-0000000017a0'),
    ('00000000-0000-7000-8000-000000001702', '00000000-0000-7000-8000-0000000017a0'),
    ('00000000-0000-7000-8000-000000001703', '00000000-0000-7000-8000-0000000017b0');
INSERT INTO social.playlists (id, owner_id, title, visibility) VALUES
    ('00000000-0000-7000-8000-000000001711', '00000000-0000-7000-8000-0000000017a0', 'Series A', 'PUBLIC'),
    ('00000000-0000-7000-8000-000000001712', '00000000-0000-7000-8000-0000000017a0', 'Mixed list', 'PUBLIC');

-- Default is not a series; marking an own-videos list as a series works.
UPDATE social.playlists SET is_series = true WHERE id = '00000000-0000-7000-8000-000000001711';
INSERT INTO social.playlist_items (playlist_id, video_id, position) VALUES
    ('00000000-0000-7000-8000-000000001711', '00000000-0000-7000-8000-000000001701', 1048576),
    ('00000000-0000-7000-8000-000000001711', '00000000-0000-7000-8000-000000001702', 2097152);
-- A normal list may still hold other channels' videos.
INSERT INTO social.playlist_items (playlist_id, video_id, position) VALUES
    ('00000000-0000-7000-8000-000000001712', '00000000-0000-7000-8000-000000001701', 1048576),
    ('00000000-0000-7000-8000-000000001712', '00000000-0000-7000-8000-000000001703', 2097152);

DO $$
DECLARE
    bad text[] := ARRAY[
        -- a foreign video cannot enter a series
        $q$INSERT INTO social.playlist_items (playlist_id, video_id, position) VALUES ('00000000-0000-7000-8000-000000001711', '00000000-0000-7000-8000-000000001703', 3145728)$q$,
        -- a list holding a foreign video cannot become a series
        $q$UPDATE social.playlists SET is_series = true WHERE id = '00000000-0000-7000-8000-000000001712'$q$,
        -- watch-later is never a series
        $q$INSERT INTO social.playlists (id, owner_id, kind, title, visibility, is_series) VALUES ('00000000-0000-7000-8000-000000001713', '00000000-0000-7000-8000-0000000017a0', 'WATCH_LATER', 'Xem sau', 'PRIVATE', true)$q$
    ];
    stmt text;
BEGIN
    FOREACH stmt IN ARRAY bad LOOP
        BEGIN
            EXECUTE stmt;
            RAISE EXCEPTION 'expected failure: %', stmt;
        EXCEPTION WHEN check_violation THEN
            NULL;
        END;
    END LOOP;
END $$;

DO $$
BEGIN
    IF (SELECT count(*) FROM social.playlist_items WHERE playlist_id = '00000000-0000-7000-8000-000000001711') <> 2 THEN
        RAISE EXCEPTION 'series items changed unexpectedly';
    END IF;
    IF (SELECT is_series FROM social.playlists WHERE id = '00000000-0000-7000-8000-000000001712') THEN
        RAISE EXCEPTION 'mixed list became a series';
    END IF;
END $$;

\echo ok 017_cin2_series
