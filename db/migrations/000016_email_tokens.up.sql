-- A6 (ADR-026): one-time email tokens (verify email, reset password) and the auth mail queue.
-- Owned by auth-svc. Tokens are stored as SHA-256 only; the raw token lives in mail_queue.params
-- until the mail is sent (or given up), then params is cleared.

CREATE TYPE auth.email_token_purpose AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

CREATE TABLE auth.email_tokens (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    purpose     auth.email_token_purpose NOT NULL,
    token_hash  bytea NOT NULL UNIQUE,      -- SHA-256 of the opaque token
    email       citext NOT NULL,            -- address it was sent to; must still equal users.email when used
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    CONSTRAINT email_tokens_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT email_tokens_expiry CHECK (expires_at > created_at),
    CONSTRAINT email_tokens_used CHECK (used_at IS NULL OR used_at >= created_at)
);
-- Live tokens of a user per purpose (issuing a new one invalidates the older ones; rate limit by count).
CREATE INDEX email_tokens_user_live ON auth.email_tokens (user_id, purpose, created_at DESC) WHERE used_at IS NULL;
CREATE INDEX email_tokens_expires ON auth.email_tokens (expires_at);

CREATE TYPE auth.mail_template AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD', 'PASSWORD_CHANGED');

-- Transactional mail queue (same idea as the outbox, ADR-008): rows are written in the request's
-- transaction and sent by a background loop in auth-svc. Never published to NATS (they carry tokens).
CREATE TABLE auth.mail_queue (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         uuid REFERENCES auth.users (id) ON DELETE CASCADE,
    to_email        citext NOT NULL,
    template        auth.mail_template NOT NULL,
    locale          text NOT NULL DEFAULT 'vi',
    params          jsonb,                  -- e.g. {"link": "..."}; NULL once sent or dead
    created_at      timestamptz NOT NULL DEFAULT now(),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    dead_at         timestamptz,
    last_error      text,
    CONSTRAINT mail_queue_locale CHECK (locale IN ('vi', 'en')),
    CONSTRAINT mail_queue_attempts CHECK (attempts >= 0),
    CONSTRAINT mail_queue_one_outcome CHECK (sent_at IS NULL OR dead_at IS NULL),
    CONSTRAINT mail_queue_params_cleared CHECK ((sent_at IS NULL AND dead_at IS NULL) OR params IS NULL)
);
CREATE INDEX mail_queue_pending ON auth.mail_queue (next_attempt_at) WHERE sent_at IS NULL AND dead_at IS NULL;
CREATE INDEX mail_queue_created ON auth.mail_queue (created_at);
