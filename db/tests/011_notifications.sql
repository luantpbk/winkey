\set ON_ERROR_STOP on

-- Fixtures: video 1101 owned by channel c1; comment 1111 on it by user u2.
INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-000000001101', '00000000-0000-7000-8000-0000000011c1');
INSERT INTO social.comments (id, video_id, author_id, body) VALUES
    ('00000000-0000-7000-8000-000000001111', '00000000-0000-7000-8000-000000001101',
     '00000000-0000-7000-8000-0000000011a2', 'hello');

-- One of each kind is accepted.
INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id, comment_id) VALUES
    ('00000000-0000-7000-8000-000000001121', '00000000-0000-7000-8000-0000000011a3', 'VIDEO_PUBLISHED',
     '00000000-0000-7000-8000-0000000011c1', '00000000-0000-7000-8000-000000001101', NULL),
    ('00000000-0000-7000-8000-000000001122', '00000000-0000-7000-8000-0000000011c1', 'VIDEO_COMMENT',
     '00000000-0000-7000-8000-0000000011a2', '00000000-0000-7000-8000-000000001101',
     '00000000-0000-7000-8000-000000001111'),
    ('00000000-0000-7000-8000-000000001123', '00000000-0000-7000-8000-0000000011c1', 'NEW_SUBSCRIBER',
     '00000000-0000-7000-8000-0000000011a2', NULL, NULL);

DO $$
DECLARE
    bad text[] := ARRAY[
        -- duplicate subject for the same recipient (re-sent video.ready)
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id)
           VALUES ('00000000-0000-7000-8000-000000001131', '00000000-0000-7000-8000-0000000011a3', 'VIDEO_PUBLISHED',
                   '00000000-0000-7000-8000-0000000011c1', '00000000-0000-7000-8000-000000001101')$q$,
        -- second NEW_SUBSCRIBER from the same subscriber
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id)
           VALUES ('00000000-0000-7000-8000-000000001132', '00000000-0000-7000-8000-0000000011c1', 'NEW_SUBSCRIBER',
                   '00000000-0000-7000-8000-0000000011a2')$q$,
        -- self notification
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id)
           VALUES ('00000000-0000-7000-8000-000000001133', '00000000-0000-7000-8000-0000000011a2', 'NEW_SUBSCRIBER',
                   '00000000-0000-7000-8000-0000000011a2')$q$,
        -- VIDEO_COMMENT without comment_id
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id)
           VALUES ('00000000-0000-7000-8000-000000001134', '00000000-0000-7000-8000-0000000011a4', 'VIDEO_COMMENT',
                   '00000000-0000-7000-8000-0000000011a2', '00000000-0000-7000-8000-000000001101')$q$,
        -- NEW_SUBSCRIBER with a video
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id)
           VALUES ('00000000-0000-7000-8000-000000001135', '00000000-0000-7000-8000-0000000011a4', 'NEW_SUBSCRIBER',
                   '00000000-0000-7000-8000-0000000011a2', '00000000-0000-7000-8000-000000001101')$q$,
        -- unknown video (FK)
        $q$INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id)
           VALUES ('00000000-0000-7000-8000-000000001136', '00000000-0000-7000-8000-0000000011a4', 'VIDEO_PUBLISHED',
                   '00000000-0000-7000-8000-0000000011c1', '00000000-0000-7000-8000-0000000011ff')$q$
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

    -- ON CONFLICT DO NOTHING is how writers stay idempotent.
    INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id)
    VALUES ('00000000-0000-7000-8000-000000001137', '00000000-0000-7000-8000-0000000011a3', 'VIDEO_PUBLISHED',
            '00000000-0000-7000-8000-0000000011c1', '00000000-0000-7000-8000-000000001101')
    ON CONFLICT DO NOTHING;
    SELECT count(*) INTO n FROM social.notifications WHERE user_id = '00000000-0000-7000-8000-0000000011a3';
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: ON CONFLICT DO NOTHING inserted a duplicate (% rows)', n;
    END IF;

    -- Deleting the comment, then the video, cascades.
    DELETE FROM social.comments WHERE id = '00000000-0000-7000-8000-000000001111';
    IF EXISTS (SELECT 1 FROM social.notifications WHERE id = '00000000-0000-7000-8000-000000001122') THEN
        RAISE EXCEPTION 'TEST FAILED: comment delete did not cascade';
    END IF;
    DELETE FROM social.videos WHERE id = '00000000-0000-7000-8000-000000001101';
    IF EXISTS (SELECT 1 FROM social.notifications WHERE id = '00000000-0000-7000-8000-000000001121') THEN
        RAISE EXCEPTION 'TEST FAILED: video delete did not cascade';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM social.notifications WHERE id = '00000000-0000-7000-8000-000000001123') THEN
        RAISE EXCEPTION 'TEST FAILED: NEW_SUBSCRIBER removed by a video delete';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'social' AND indexname = 'notifications_user_unread') THEN
        RAISE EXCEPTION 'TEST FAILED: unread index missing';
    END IF;
END $$;

\echo ok 011_notifications
