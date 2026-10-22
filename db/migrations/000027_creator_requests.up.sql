-- Task ROLE1 (ADR-046): open registration with viewer-only accounts; creators are approved by an admin.
--   auth.users.roles default → {viewer} (auth-svc also sets it explicitly on register and on Google sign-up).
--   auth.creator_requests — one row per upgrade request; at most one PENDING per user. Approving one adds
--   `creator` to auth.users.roles in the same transaction (auth-svc). Existing accounts keep their roles.

ALTER TABLE auth.users ALTER COLUMN roles SET DEFAULT '{viewer}';

CREATE TYPE auth.creator_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE auth.creator_requests (
    id            uuid PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    status        auth.creator_request_status NOT NULL DEFAULT 'PENDING',
    message       text NOT NULL,
    decision_note text,
    decided_by    uuid,                      -- auth.users.id of the admin
    decided_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creator_requests_message_len CHECK (char_length(message) BETWEEN 10 AND 1000),
    CONSTRAINT creator_requests_note_len CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
    CONSTRAINT creator_requests_decision_consistent CHECK (
        (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
        OR (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CONSTRAINT creator_requests_reject_has_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL)
);

-- At most one open request per user (createCreatorRequest → 409 REQUEST_PENDING on conflict).
CREATE UNIQUE INDEX creator_requests_one_pending ON auth.creator_requests (user_id) WHERE status = 'PENDING';
-- Admin queue: PENDING oldest first; decided lists most recently decided first.
CREATE INDEX creator_requests_queue ON auth.creator_requests (created_at, id) WHERE status = 'PENDING';
CREATE INDEX creator_requests_decided ON auth.creator_requests (status, decided_at DESC, id DESC) WHERE status <> 'PENDING';
-- getMyCreatorRequest and the 24 h cooldown: latest request of a user.
CREATE INDEX creator_requests_user_latest ON auth.creator_requests (user_id, created_at DESC, id DESC);
