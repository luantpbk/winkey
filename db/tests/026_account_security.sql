\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000e1', 'soc1a-user@example.com', 'soc1a_user', 'S1A');

DO $$
BEGIN
    -- TOTP columns are all set or all NULL.
    BEGIN
        UPDATE auth.users SET totp_secret_enc = '\x01'::bytea WHERE id = '00000000-0000-7000-8000-0000000000e1';
        RAISE EXCEPTION 'TEST FAILED: a TOTP secret without key id / enabled_at was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE auth.users SET totp_secret_enc = '\x01'::bytea, totp_key_id = 'k1', totp_enabled_at = now()
    WHERE id = '00000000-0000-7000-8000-0000000000e1';

    -- Passkey name length and unique credential id.
    INSERT INTO auth.passkeys (id, user_id, credential_id, public_key, name)
    VALUES ('00000000-0000-7000-8000-00000000e101', '00000000-0000-7000-8000-0000000000e1',
            decode(repeat('ab', 16), 'hex'), '\x00'::bytea, 'Laptop');
    BEGIN
        INSERT INTO auth.passkeys (id, user_id, credential_id, public_key, name)
        VALUES ('00000000-0000-7000-8000-00000000e102', '00000000-0000-7000-8000-0000000000e1',
                decode(repeat('ab', 16), 'hex'), '\x00'::bytea, 'Phone');
        RAISE EXCEPTION 'TEST FAILED: a duplicate credential id was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO auth.passkeys (id, user_id, credential_id, public_key, name)
        VALUES ('00000000-0000-7000-8000-00000000e103', '00000000-0000-7000-8000-0000000000e1',
                decode(repeat('cd', 16), 'hex'), '\x00'::bytea, '');
        RAISE EXCEPTION 'TEST FAILED: an empty passkey name was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Sessions: amr values, revocation consistency, country format.
    INSERT INTO auth.sessions (id, user_id, amr, country)
    VALUES ('00000000-0000-7000-8000-00000000e201', '00000000-0000-7000-8000-0000000000e1', '{pwd,otp}', 'VN');
    BEGIN
        INSERT INTO auth.sessions (id, user_id, amr)
        VALUES ('00000000-0000-7000-8000-00000000e202', '00000000-0000-7000-8000-0000000000e1', '{sms}');
        RAISE EXCEPTION 'TEST FAILED: an unknown amr value was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE auth.sessions SET revoked_at = now() WHERE id = '00000000-0000-7000-8000-00000000e201';
        RAISE EXCEPTION 'TEST FAILED: revoked_at without a reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE auth.sessions SET revoked_at = now(), revoke_reason = 'USER_REVOKED'
    WHERE id = '00000000-0000-7000-8000-00000000e201';
    BEGIN
        INSERT INTO auth.sessions (id, user_id, country)
        VALUES ('00000000-0000-7000-8000-00000000e203', '00000000-0000-7000-8000-0000000000e1', 'vn');
        RAISE EXCEPTION 'TEST FAILED: a lower-case country was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Security events and the new enum values.
    INSERT INTO auth.security_events (id, user_id, kind, session_id, country)
    VALUES ('00000000-0000-7000-8000-00000000e301', '00000000-0000-7000-8000-0000000000e1', 'TOTP_ENABLED',
            '00000000-0000-7000-8000-00000000e201', 'VN');
    INSERT INTO auth.mail_queue (user_id, to_email, template, params)
    VALUES ('00000000-0000-7000-8000-0000000000e1', 'soc1a-user@example.com', 'NEW_SIGN_IN', '{"device":"Chrome"}');
    INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, expires_at)
    VALUES ('00000000-0000-7000-8000-00000000e401', '00000000-0000-7000-8000-0000000000e1', 'SESSION_REPORT',
            decode(repeat('ef', 32), 'hex'), 'soc1a-user@example.com', now() + interval '7 days');

    -- Deleting the user removes everything (cascade).
    DELETE FROM auth.mail_queue WHERE user_id = '00000000-0000-7000-8000-0000000000e1';
    DELETE FROM auth.users WHERE id = '00000000-0000-7000-8000-0000000000e1';
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = '00000000-0000-7000-8000-0000000000e1')
       OR EXISTS (SELECT 1 FROM auth.passkeys WHERE user_id = '00000000-0000-7000-8000-0000000000e1')
       OR EXISTS (SELECT 1 FROM auth.security_events WHERE user_id = '00000000-0000-7000-8000-0000000000e1') THEN
        RAISE EXCEPTION 'TEST FAILED: user deletion did not cascade';
    END IF;
END $$;
