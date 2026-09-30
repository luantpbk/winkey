\set ON_ERROR_STOP on

INSERT INTO media.subscriptions (subscriber_id, channel_id)
VALUES ('00000000-0000-7000-8000-00000000fa01', '00000000-0000-7000-8000-00000000fa02');

DO $$
DECLARE
    bad text[] := ARRAY[
        $q$INSERT INTO media.subscriptions (subscriber_id, channel_id)
           VALUES ('00000000-0000-7000-8000-00000000fa01', '00000000-0000-7000-8000-00000000fa02')$q$,
        $q$INSERT INTO media.subscriptions (subscriber_id, channel_id)
           VALUES ('00000000-0000-7000-8000-00000000fa03', '00000000-0000-7000-8000-00000000fa03')$q$
    ];
    q text;
BEGIN
    FOREACH q IN ARRAY bad LOOP
        BEGIN
            EXECUTE q;
            RAISE EXCEPTION 'TEST FAILED: accepted %', q;
        EXCEPTION
            WHEN unique_violation OR check_violation THEN NULL;
        END;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'media' AND indexname = 'videos_owner_published') THEN
        RAISE EXCEPTION 'TEST FAILED: feed index missing';
    END IF;
END $$;

\echo ok 010_subscription_feed
