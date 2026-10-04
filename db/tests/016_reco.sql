\set ON_ERROR_STOP on

-- Valid rows (what analytics-worker writes on every run).
INSERT INTO analytics.video_coview (video_id, neighbor_id, co_viewers, score, refreshed_at)
VALUES ('00000000-0000-7000-8000-000000001601', '00000000-0000-7000-8000-000000001602', 3, 0.5, now()),
       ('00000000-0000-7000-8000-000000001601', '00000000-0000-7000-8000-000000001603', 10, 1, now());
INSERT INTO analytics.viewer_history (viewer_key, video_id, last_watched_at, watched_ms, refreshed_at)
VALUES (repeat('ab', 32), '00000000-0000-7000-8000-000000001601', now() - interval '1 day', 25000, now()),
       (repeat('ab', 32), '00000000-0000-7000-8000-000000001602', now(), 60000, now());

DO $$
BEGIN
    IF (SELECT video_id FROM analytics.viewer_history WHERE viewer_key = repeat('ab', 32)
         ORDER BY last_watched_at DESC LIMIT 1) <> '00000000-0000-7000-8000-000000001602' THEN
        RAISE EXCEPTION 'history is not read newest first';
    END IF;
END $$;

DO $$
DECLARE
    bad text[] := ARRAY[
        -- a video is not its own neighbour
        $q$INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001604', '00000000-0000-7000-8000-000000001604', 5, 0.5, now())$q$,
        -- fewer than 3 co-viewers
        $q$INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001604', '00000000-0000-7000-8000-000000001605', 2, 0.5, now())$q$,
        -- score out of (0, 1]
        $q$INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001604', '00000000-0000-7000-8000-000000001605', 3, 0, now())$q$,
        $q$INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001604', '00000000-0000-7000-8000-000000001605', 3, 1.5, now())$q$,
        -- duplicate pair
        $q$INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001601', '00000000-0000-7000-8000-000000001602', 4, 0.6, now())$q$,
        -- viewer_key that is not 64 lower-case hex (upper case, too short, a raw user id)
        $q$INSERT INTO analytics.viewer_history VALUES (repeat('AB', 32), '00000000-0000-7000-8000-000000001601', now(), 1, now())$q$,
        $q$INSERT INTO analytics.viewer_history VALUES ('abc', '00000000-0000-7000-8000-000000001601', now(), 1, now())$q$,
        $q$INSERT INTO analytics.viewer_history VALUES ('00000000-0000-7000-8000-000000001601', '00000000-0000-7000-8000-000000001601', now(), 1, now())$q$,
        -- no watch time
        $q$INSERT INTO analytics.viewer_history VALUES (repeat('cd', 32), '00000000-0000-7000-8000-000000001601', now(), 0, now())$q$,
        -- duplicate (viewer, video)
        $q$INSERT INTO analytics.viewer_history VALUES (repeat('ab', 32), '00000000-0000-7000-8000-000000001601', now(), 5, now())$q$
    ];
    stmt text;
BEGIN
    FOREACH stmt IN ARRAY bad LOOP
        BEGIN
            EXECUTE stmt;
            RAISE EXCEPTION 'accepted an invalid row: %', stmt;
        EXCEPTION
            WHEN check_violation OR unique_violation OR not_null_violation THEN NULL;
        END;
    END LOOP;
END $$;

-- The worker replaces the whole content in one transaction (the test runner already wraps this file in one).
DELETE FROM analytics.video_coview;
INSERT INTO analytics.video_coview VALUES ('00000000-0000-7000-8000-000000001602', '00000000-0000-7000-8000-000000001601', 3, 0.25, now());
DO $$
BEGIN
    IF (SELECT count(*) FROM analytics.video_coview) <> 1 THEN
        RAISE EXCEPTION 'replace did not leave exactly the new content';
    END IF;
END $$;

\echo ok 016_reco
