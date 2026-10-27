-- Task SOC-1a (ADR-049 §3): account security. Owned by auth-svc.
--   TOTP second factor (secret encrypted by auth-svc, never stored in clear) + one-time recovery codes.
--   Passkeys (WebAuthn credentials): passwordless sign-in and second factor.
--   auth.sessions — one row per refresh-token family (sid): device, country, last use, step-up, revocation.
--     The user's session list and "sign out other devices" read this table. New families get a row on
--     sign-in; existing live families are backfilled below. auth-svc stops writing refresh_tokens.ip
--     (ADR-049: no IP in clear); the column stays for old rows and is dropped in a later migration.
--   auth.security_events — the user-visible security log (kept 1 year by auth-svc's janitor).
--   Mail template NEW_SIGN_IN and email-token purpose SESSION_REPORT ("this wasn't me" link).

ALTER TABLE auth.users
    ADD COLUMN totp_secret_enc bytea,        -- AES-256-GCM(nonce || ciphertext || tag) of the raw TOTP secret
    ADD COLUMN totp_key_id     text,         -- which TOTP_ENCRYPTION_KEYS entry encrypted it (key rotation)
    ADD COLUMN totp_enabled_at timestamptz,
    ADD COLUMN totp_last_step  bigint,       -- last accepted 30 s step: a code is never accepted twice
    ADD CONSTRAINT users_totp_consistent CHECK (
        (totp_secret_enc IS NULL AND totp_key_id IS NULL AND totp_enabled_at IS NULL AND totp_last_step IS NULL)
        OR (totp_secret_enc IS NOT NULL AND totp_key_id IS NOT NULL AND totp_enabled_at IS NOT NULL));

CREATE TABLE auth.recovery_codes (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    code_hash  text NOT NULL,               -- argon2id PHC string of the normalized code
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz,
    CONSTRAINT recovery_codes_used CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX recovery_codes_user_unused ON auth.recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE auth.passkeys (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    credential_id   bytea NOT NULL UNIQUE,
    public_key      bytea NOT NULL,         -- COSE_Key
    sign_count      bigint NOT NULL DEFAULT 0,
    transports      text[] NOT NULL DEFAULT '{}',
    aaguid          uuid,
    backup_eligible boolean NOT NULL DEFAULT false,
    backup_state    boolean NOT NULL DEFAULT false,
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz,
    CONSTRAINT passkeys_name_len CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT passkeys_sign_count CHECK (sign_count >= 0),
    CONSTRAINT passkeys_credential_len CHECK (octet_length(credential_id) BETWEEN 16 AND 1023)
);
CREATE INDEX passkeys_user ON auth.passkeys (user_id, created_at);

CREATE TABLE auth.sessions (
    id            uuid PRIMARY KEY,         -- = auth.refresh_tokens.family_id = the access token's sid
    user_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz NOT NULL DEFAULT now(),
    device_label  text,                     -- e.g. "Chrome trên Windows", derived from the User-Agent
    country       char(2),                  -- ISO 3166-1 alpha-2 from the sign-in IP; NULL when unknown
    ip_hash       bytea,                    -- HMAC-SHA256(SESSION_IP_SALT, ip): "new device" detection only
    amr           text[] NOT NULL DEFAULT '{}',  -- methods used at sign-in (RFC 8176 style)
    step_up_at    timestamptz,              -- last successful re-authentication (valid 10 min)
    revoked_at    timestamptz,
    revoke_reason text,
    CONSTRAINT sessions_amr CHECK (amr <@ ARRAY['pwd', 'otp', 'rcode', 'passkey', 'google', 'email']::text[]),
    CONSTRAINT sessions_country CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
    CONSTRAINT sessions_ip_hash_len CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
    CONSTRAINT sessions_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN
        ('LOGOUT', 'USER_REVOKED', 'REVOKE_OTHERS', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'SUSPENDED', 'DELETED',
         'REPORTED', 'MFA_DISABLED', 'EXPIRED')),
    CONSTRAINT sessions_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX sessions_user_active ON auth.sessions (user_id, last_used_at DESC) WHERE revoked_at IS NULL;
-- "Seen this device before?": live or past sessions of the user with the same IP hash.
CREATE INDEX sessions_user_ip ON auth.sessions (user_id, ip_hash);

-- Backfill: one session per live refresh family (newest token of the family carries the latest use).
INSERT INTO auth.sessions (id, user_id, created_at, last_used_at, device_label, amr)
SELECT f.family_id, f.user_id, f.created_at, f.last_used_at, NULL, '{}'
FROM (
    SELECT family_id, user_id, min(issued_at) AS created_at, max(coalesce(rotated_at, issued_at)) AS last_used_at
    FROM auth.refresh_tokens
    GROUP BY family_id, user_id
    HAVING bool_or(revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now())
) f
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN auth.refresh_tokens.ip IS 'Deprecated by SOC-1a (ADR-049): no longer written; see auth.sessions.ip_hash.';

CREATE TYPE auth.security_event_kind AS ENUM (
    'SIGN_IN',
    'SIGN_IN_NEW_DEVICE',
    'MFA_FAILED',
    'TOTP_ENABLED',
    'TOTP_DISABLED',
    'RECOVERY_CODES_GENERATED',
    'RECOVERY_CODE_USED',
    'PASSKEY_ADDED',
    'PASSKEY_REMOVED',
    'SESSION_REVOKED',
    'OTHER_SESSIONS_REVOKED',
    'SESSION_REPORTED',
    'PASSWORD_CHANGED',
    'PASSWORD_RESET',
    'STEP_UP'
);

-- Written in the same transaction as the change it records. Never updated by the service.
CREATE TABLE auth.security_events (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    kind         auth.security_event_kind NOT NULL,
    session_id   uuid,                      -- the session that did it (or was revoked); no FK, sessions are purged
    device_label text,
    country      char(2),
    details      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"passkey_name":"iPhone"}; never secrets or IPs
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT security_events_country CHECK (country IS NULL OR country ~ '^[A-Z]{2}$')
);
CREATE INDEX security_events_user ON auth.security_events (user_id, created_at DESC, id DESC);
CREATE INDEX security_events_created ON auth.security_events (created_at);

ALTER TYPE auth.mail_template ADD VALUE IF NOT EXISTS 'NEW_SIGN_IN';
ALTER TYPE auth.email_token_purpose ADD VALUE IF NOT EXISTS 'SESSION_REPORT';
