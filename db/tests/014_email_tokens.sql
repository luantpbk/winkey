\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000016aa', 'mail@example.com', 'mail.user', 'Mail');

INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, expires_at)
VALUES ('00000000-0000-7000-8000-0000000016b1', '00000000-0000-7000-8000-0000000016aa', 'RESET_PASSWORD',
        sha256('t1'), 'mail@example.com', now() + interval '1 hour');

-- Token hash must be 32 bytes and unique; expiry after creation.
DO $$
BEGIN
    INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, expires_at)
    VALUES ('00000000-0000-7000-8000-0000000016b2', '00000000-0000-7000-8000-0000000016aa', 'VERIFY_EMAIL',
            '\x00'::bytea, 'mail@example.com', now() + interval '1 hour');
    RAISE EXCEPTION 'TEST FAILED: short token hash was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, expires_at)
    VALUES ('00000000-0000-7000-8000-0000000016b3', '00000000-0000-7000-8000-0000000016aa', 'VERIFY_EMAIL',
            sha256('t1'), 'mail@example.com', now() + interval '1 hour');
    RAISE EXCEPTION 'TEST FAILED: duplicate token hash was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, created_at, expires_at)
    VALUES ('00000000-0000-7000-8000-0000000016b4', '00000000-0000-7000-8000-0000000016aa', 'VERIFY_EMAIL',
            sha256('t4'), 'mail@example.com', now(), now() - interval '1 second');
    RAISE EXCEPTION 'TEST FAILED: expiry before creation was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Mail queue: pending row keeps params; a sent row must have params cleared and only one outcome.
INSERT INTO auth.mail_queue (user_id, to_email, template, params)
VALUES ('00000000-0000-7000-8000-0000000016aa', 'mail@example.com', 'RESET_PASSWORD', '{"link":"x"}');
DO $$
BEGIN
    UPDATE auth.mail_queue SET sent_at = now() WHERE to_email = 'mail@example.com';
    RAISE EXCEPTION 'TEST FAILED: sent row kept its params';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
UPDATE auth.mail_queue SET sent_at = now(), params = NULL WHERE to_email = 'mail@example.com';
DO $$
BEGIN
    UPDATE auth.mail_queue SET dead_at = now() WHERE to_email = 'mail@example.com';
    RAISE EXCEPTION 'TEST FAILED: row both sent and dead';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO auth.mail_queue (to_email, template, locale, params)
    VALUES ('mail@example.com', 'VERIFY_EMAIL', 'fr', '{}');
    RAISE EXCEPTION 'TEST FAILED: unknown locale was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Deleting the user removes its tokens and queued mail.
DELETE FROM auth.users WHERE id = '00000000-0000-7000-8000-0000000016aa';
DO $$
BEGIN
    IF (SELECT count(*) FROM auth.email_tokens) <> 0 OR (SELECT count(*) FROM auth.mail_queue) <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: cascade on user delete';
    END IF;
END $$;

\echo ok 014_email_tokens
