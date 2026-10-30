-- SOC-3b (ADR-049 addendum 2026-10-31): encrypted chat attachments and passphrase key backup.
-- The server still never sees plaintext or keys: attachments are AES-256-GCM ciphertext in the private
-- `winkey-chat` bucket, their file key travels inside the Megolm message; key backups are opaque blobs that the
-- client encrypts with a key derived from the user's recovery passphrase (Argon2id). No cross-schema FKs.

-- PENDING: upload URL issued, object not confirmed yet. UPLOADED: object confirmed (HEAD, exact size).
-- A row is deleted (and its object) when its message is deleted, when it was never attached to a message within
-- 24 h, or when it expires (30 days after creation; the bucket lifecycle rule deletes objects at 30 days too).
CREATE TYPE chat.attachment_state AS ENUM ('PENDING', 'UPLOADED');

CREATE TABLE chat.attachments (
    id               uuid PRIMARY KEY,                 -- UUIDv7; object key "c/<conversation_id>/<id>"
    conversation_id  uuid NOT NULL REFERENCES chat.conversations (id) ON DELETE CASCADE,
    uploader_id      uuid NOT NULL,
    uploader_device_id uuid NOT NULL,
    size_bytes       bigint NOT NULL,                  -- ciphertext size, fixed when the upload URL is issued
    state            chat.attachment_state NOT NULL DEFAULT 'PENDING',
    message_seq      bigint,                           -- set once, when a message references it
    created_at       timestamptz NOT NULL DEFAULT now(),
    uploaded_at      timestamptz,
    expires_at       timestamptz NOT NULL,
    CONSTRAINT attachments_size CHECK (size_bytes BETWEEN 1 AND 26214400),               -- 25 MiB
    CONSTRAINT attachments_uploaded CHECK ((state = 'UPLOADED') = (uploaded_at IS NOT NULL)),
    CONSTRAINT attachments_linked CHECK (message_seq IS NULL OR state = 'UPLOADED'),
    CONSTRAINT attachments_expiry CHECK (expires_at > created_at),
    CONSTRAINT attachments_message FOREIGN KEY (conversation_id, message_seq)
        REFERENCES chat.messages (conversation_id, seq) ON DELETE CASCADE
);
CREATE INDEX attachments_message ON chat.attachments (conversation_id, message_seq) WHERE message_seq IS NOT NULL;
-- Janitor: never-attached rows after 24 h, and expired rows.
CREATE INDEX attachments_unlinked ON chat.attachments (created_at) WHERE message_seq IS NULL;
CREATE INDEX attachments_expires ON chat.attachments (expires_at);
-- Per-user quota of live attachment bytes.
CREATE INDEX attachments_uploader ON chat.attachments (uploader_id);

-- One optional key backup per user. auth_data is opaque to the server: the Argon2id salt and parameters and the
-- backup key wrapped with the passphrase-derived key. Replacing the backup bumps version and drops its sessions.
CREATE TABLE chat.key_backups (
    user_id    uuid PRIMARY KEY,
    version    bigint NOT NULL,
    algorithm  text NOT NULL,
    auth_data  jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT key_backups_version CHECK (version >= 1),
    CONSTRAINT key_backups_algorithm CHECK (algorithm IN ('winkey.backup.v1')),
    CONSTRAINT key_backups_auth_data CHECK (jsonb_typeof(auth_data) = 'object' AND pg_column_size(auth_data) <= 4096)
);

-- Megolm inbound session keys, each encrypted by the client with the backup key. Upsert keeps the row whose
-- first_message_index is lowest (it decrypts more history); on a tie the newer upload wins.
CREATE TABLE chat.key_backup_sessions (
    user_id             uuid NOT NULL REFERENCES chat.key_backups (user_id) ON DELETE CASCADE,
    conversation_id     uuid NOT NULL,                 -- no FK: a backup outlives a left conversation
    session_id          text NOT NULL,
    first_message_index integer NOT NULL,
    ciphertext          text NOT NULL,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id, session_id),
    CONSTRAINT key_backup_sessions_shape CHECK (char_length(session_id) BETWEEN 1 AND 64
                                                AND first_message_index >= 0
                                                AND char_length(ciphertext) BETWEEN 1 AND 10924) -- 8 KiB
);
