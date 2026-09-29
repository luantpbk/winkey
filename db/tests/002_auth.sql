\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000aa', 'Luan@Example.com', 'luan.dev', 'Luan');

-- Email and handle are case-insensitive unique.
DO $$
BEGIN
    INSERT INTO auth.users (id, email, handle, display_name)
    VALUES ('00000000-0000-7000-8000-0000000000ab', 'luan@example.com', 'other', 'X');
    RAISE EXCEPTION 'TEST FAILED: duplicate email (case) was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO auth.users (id, email, handle, display_name)
    VALUES ('00000000-0000-7000-8000-0000000000ac', 'b@example.com', 'LUAN.DEV', 'X');
    RAISE EXCEPTION 'TEST FAILED: duplicate handle (case) was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- Handle format.
DO $$
BEGIN
    INSERT INTO auth.users (id, email, handle, display_name)
    VALUES ('00000000-0000-7000-8000-0000000000ad', 'c@example.com', 'bad handle!', 'X');
    RAISE EXCEPTION 'TEST FAILED: invalid handle was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Default roles and public view.
DO $$
BEGIN
    IF (SELECT roles FROM auth.users WHERE handle = 'luan.dev') <> '{viewer,creator}'::auth.role[] THEN
        RAISE EXCEPTION 'TEST FAILED: default roles';
    END IF;
    IF (SELECT count(*) FROM auth.public_profiles WHERE handle = 'luan.dev') <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: public_profiles';
    END IF;
END $$;

-- Refresh token hash must be exactly 32 bytes (SHA-256).
DO $$
BEGIN
    INSERT INTO auth.refresh_tokens (id, user_id, family_id, token_hash, expires_at)
    VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000aa',
            '00000000-0000-7000-8000-0000000000f1', '\x00'::bytea, now() + interval '30 days');
    RAISE EXCEPTION 'TEST FAILED: short token hash was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
INSERT INTO auth.refresh_tokens (id, user_id, family_id, token_hash, expires_at)
VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000aa',
        '00000000-0000-7000-8000-0000000000f1', sha256('token'::bytea), now() + interval '30 days');

-- updated_at is maintained by trigger even if the client tries to set it.
UPDATE auth.users SET display_name = 'Luan 2', updated_at = '2000-01-01' WHERE handle = 'luan.dev';
DO $$
BEGIN
    IF (SELECT updated_at FROM auth.users WHERE handle = 'luan.dev') <> now() THEN
        RAISE EXCEPTION 'TEST FAILED: updated_at trigger';
    END IF;
END $$;

\echo 'ok 002_auth'
