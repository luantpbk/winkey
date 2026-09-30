\set ON_ERROR_STOP on

-- Existing and new projection rows default to PUBLIC; PRIVATE and UNLISTED are accepted; anything else is not.
INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-00000000f701', '00000000-0000-7000-8000-0000000000c0');

DO $$
BEGIN
    IF (SELECT visibility FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000f701') <> 'PUBLIC' THEN
        RAISE EXCEPTION 'TEST FAILED: default visibility is not PUBLIC';
    END IF;
    UPDATE social.videos SET visibility = 'PRIVATE' WHERE id = '00000000-0000-7000-8000-00000000f701';
    UPDATE social.videos SET visibility = 'UNLISTED' WHERE id = '00000000-0000-7000-8000-00000000f701';
    BEGIN
        UPDATE social.videos SET visibility = 'SECRET' WHERE id = '00000000-0000-7000-8000-00000000f701';
        RAISE EXCEPTION 'TEST FAILED: invalid visibility accepted';
    EXCEPTION WHEN check_violation THEN
        NULL; -- expected
    END;
END $$;

\echo ok 007_social_visibility
