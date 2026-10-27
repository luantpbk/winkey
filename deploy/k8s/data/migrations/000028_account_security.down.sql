-- The enum values NEW_SIGN_IN (auth.mail_template) and SESSION_REPORT (auth.email_token_purpose) stay:
-- PostgreSQL cannot drop an enum value, and rows using them must be gone before an older auth-svc runs.
DELETE FROM auth.mail_queue WHERE template::text = 'NEW_SIGN_IN';
DELETE FROM auth.email_tokens WHERE purpose::text = 'SESSION_REPORT';
COMMENT ON COLUMN auth.refresh_tokens.ip IS NULL;
DROP TABLE IF EXISTS auth.security_events;
DROP TYPE IF EXISTS auth.security_event_kind;
DROP TABLE IF EXISTS auth.sessions;
DROP TABLE IF EXISTS auth.passkeys;
DROP TABLE IF EXISTS auth.recovery_codes;
ALTER TABLE auth.users
    DROP CONSTRAINT IF EXISTS users_totp_consistent,
    DROP COLUMN IF EXISTS totp_last_step,
    DROP COLUMN IF EXISTS totp_enabled_at,
    DROP COLUMN IF EXISTS totp_key_id,
    DROP COLUMN IF EXISTS totp_secret_enc;
