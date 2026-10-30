\set ON_ERROR_STOP on

-- SOC-6b: friends are mutual follows; friend requests are followers not followed back, minus dismissals. The two
-- lists social-svc runs must be served by indexes on social.subscriptions (EXPLAIN below).
INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000006b1', 'soc6b-me@example.com', 'soc6b_me', 'Tôi'),
       ('00000000-0000-7000-8000-0000000006b2', 'soc6b-friend@example.com', 'soc6b_friend', 'Bạn'),
       ('00000000-0000-7000-8000-0000000006b3', 'soc6b-fan@example.com', 'soc6b_fan', 'Người hâm mộ'),
       ('00000000-0000-7000-8000-0000000006b4', 'soc6b-hidden@example.com', 'soc6b_hidden', 'Đã ẩn');

DO $$
DECLARE
    me constant uuid := '00000000-0000-7000-8000-0000000006b1';
    friend constant uuid := '00000000-0000-7000-8000-0000000006b2';
    fan constant uuid := '00000000-0000-7000-8000-0000000006b3';
    hidden constant uuid := '00000000-0000-7000-8000-0000000006b4';
    ids uuid[];
    line text;
    plan text;
BEGIN
    INSERT INTO social.subscriptions (subscriber_id, channel_id, created_at) VALUES
        (me, friend, now() - interval '2 days'), (friend, me, now() - interval '1 day'),
        (fan, me, now() - interval '3 hours'), (hidden, me, now() - interval '2 hours');
    INSERT INTO social.friend_request_dismissals (user_id, follower_id) VALUES (me, hidden);

    -- Dismissals: never of yourself, once per pair.
    BEGIN
        INSERT INTO social.friend_request_dismissals (user_id, follower_id) VALUES (me, me);
        RAISE EXCEPTION 'TEST FAILED: a self-dismissal was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO social.friend_request_dismissals (user_id, follower_id) VALUES (me, hidden);
        RAISE EXCEPTION 'TEST FAILED: a duplicate dismissal was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- FRIEND_ACCEPTED carries only an actor and is created once per pair.
    INSERT INTO social.notifications (id, user_id, kind, actor_id)
    VALUES (gen_random_uuid(), friend, 'FRIEND_ACCEPTED', me);
    BEGIN
        INSERT INTO social.notifications (id, user_id, kind, actor_id)
        VALUES (gen_random_uuid(), friend, 'FRIEND_ACCEPTED', me);
        RAISE EXCEPTION 'TEST FAILED: a second FRIEND_ACCEPTED for the same pair was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id)
        VALUES (gen_random_uuid(), fan, 'FRIEND_ACCEPTED', me, gen_random_uuid());
        RAISE EXCEPTION 'TEST FAILED: FRIEND_ACCEPTED with a post_id was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Friends: mutual follows only.
    SELECT array_agg(s1.channel_id) INTO ids
    FROM social.subscriptions s1
    JOIN social.subscriptions s2 ON s2.subscriber_id = s1.channel_id AND s2.channel_id = s1.subscriber_id
    WHERE s1.subscriber_id = me;
    IF ids IS DISTINCT FROM ARRAY[friend] THEN
        RAISE EXCEPTION 'TEST FAILED: friends of me are %', ids;
    END IF;

    -- Requests: followers not followed back, without dismissed ones.
    SELECT array_agg(s.subscriber_id) INTO ids
    FROM social.subscriptions s
    WHERE s.channel_id = me
      AND NOT EXISTS (SELECT 1 FROM social.subscriptions b WHERE b.subscriber_id = me AND b.channel_id = s.subscriber_id)
      AND NOT EXISTS (SELECT 1 FROM social.friend_request_dismissals d
                      WHERE d.user_id = me AND d.follower_id = s.subscriber_id);
    IF ids IS DISTINCT FROM ARRAY[fan] THEN
        RAISE EXCEPTION 'TEST FAILED: friend requests of me are %', ids;
    END IF;

    -- EXPLAIN on realistic sizes: 6000 more follows (others follow each other, 300 follow me, I follow 200 of them),
    -- fresh statistics, sequential scans penalised. Both lists must reach social.subscriptions through an index.
    INSERT INTO social.subscriptions (subscriber_id, channel_id)
    SELECT gen_random_uuid(), gen_random_uuid() FROM generate_series(1, 5500);
    CREATE TEMP TABLE soc6b_fans ON COMMIT DROP AS SELECT gen_random_uuid() AS id FROM generate_series(1, 300);
    INSERT INTO social.subscriptions (subscriber_id, channel_id) SELECT id, me FROM soc6b_fans;
    INSERT INTO social.subscriptions (subscriber_id, channel_id) SELECT me, id FROM soc6b_fans LIMIT 200;
    ANALYZE social.subscriptions;
    ANALYZE social.friend_request_dismissals;
    SET LOCAL enable_seqscan = off;

    plan := '';
    FOR line IN EXECUTE format($q$
        EXPLAIN SELECT s1.channel_id, greatest(s1.created_at, s2.created_at) AS since
        FROM social.subscriptions s1
        JOIN social.subscriptions s2 ON s2.subscriber_id = s1.channel_id AND s2.channel_id = s1.subscriber_id
        WHERE s1.subscriber_id = %L
        ORDER BY since DESC, s1.channel_id DESC
        LIMIT 25
    $q$, me) LOOP
        plan := plan || line || E'\n';
    END LOOP;
    IF plan ~ 'Seq Scan on subscriptions' OR plan !~ 'Index (Only )?Scan using subscriptions_' THEN
        RAISE EXCEPTION 'TEST FAILED: the friends list does not use subscriptions indexes:%', E'\n' || plan;
    END IF;

    plan := '';
    FOR line IN EXECUTE format($q$
        EXPLAIN SELECT s.subscriber_id, s.created_at
        FROM social.subscriptions s
        WHERE s.channel_id = %1$L
          AND NOT EXISTS (SELECT 1 FROM social.subscriptions b
                          WHERE b.subscriber_id = %1$L AND b.channel_id = s.subscriber_id)
          AND NOT EXISTS (SELECT 1 FROM social.friend_request_dismissals d
                          WHERE d.user_id = %1$L AND d.follower_id = s.subscriber_id)
        ORDER BY s.created_at DESC, s.subscriber_id DESC
        LIMIT 25
    $q$, me) LOOP
        plan := plan || line || E'\n';
    END LOOP;
    IF plan ~ 'Seq Scan on (subscriptions|friend_request_dismissals)'
       OR plan !~ 'Index (Only )?Scan using subscriptions_channel' THEN
        RAISE EXCEPTION 'TEST FAILED: the friend-requests list does not use subscriptions indexes:%', E'\n' || plan;
    END IF;
END $$;
