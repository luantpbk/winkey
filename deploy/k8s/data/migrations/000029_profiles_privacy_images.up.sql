-- Task SOC-1b (ADR-049 + SOC-1b addendum): profiles, private accounts, blocks/mutes, social images.
--   auth.users: bio, links, banner_key, is_private (auth-svc); auth.public_profiles exposes them.
--   social.follow_requests / blocks / mutes (social-svc) + two notification kinds.
--   media.images (upload-svc creates, transcoder processes) + media.ready_images, the only image data other
--   services read (auth-svc checks an avatar/banner choice against it).

ALTER TABLE auth.users
    ADD COLUMN bio        text,
    ADD COLUMN links      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"url":"https://…","label":"…"}], ≤ 5
    ADD COLUMN banner_key text,                                -- object key in the media bucket
    ADD COLUMN is_private boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT users_bio_len CHECK (bio IS NULL OR char_length(bio) BETWEEN 1 AND 300),
    ADD CONSTRAINT users_links_shape CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 5);

-- New columns go at the end so CREATE OR REPLACE keeps the existing ones (and their grants).
CREATE OR REPLACE VIEW auth.public_profiles AS
SELECT id, handle::text AS handle, display_name, avatar_key, bio, links, banner_key, is_private, created_at
FROM auth.users
WHERE status = 'ACTIVE';

CREATE TABLE social.follow_requests (
    requester_id uuid NOT NULL,
    target_id    uuid NOT NULL,             -- a private account
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (requester_id, target_id),
    CONSTRAINT follow_requests_not_self CHECK (requester_id <> target_id)
);
CREATE INDEX follow_requests_target ON social.follow_requests (target_id, created_at DESC, requester_id);

CREATE TABLE social.blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);
-- "Is either side blocking the other?" needs both directions.
CREATE INDEX blocks_blocked ON social.blocks (blocked_id, blocker_id);
CREATE INDEX blocks_blocker_recent ON social.blocks (blocker_id, created_at DESC, blocked_id);

CREATE TABLE social.mutes (
    muter_id   uuid NOT NULL,
    muted_id   uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (muter_id, muted_id),
    CONSTRAINT mutes_not_self CHECK (muter_id <> muted_id)
);
CREATE INDEX mutes_muter_recent ON social.mutes (muter_id, created_at DESC, muted_id);

-- Followers / following lists, newest first, need the subscriber side with a tie-breaker.
CREATE INDEX subscriptions_channel_page ON social.subscriptions (channel_id, created_at DESC, subscriber_id);
CREATE INDEX subscriptions_subscriber_page ON social.subscriptions (subscriber_id, created_at DESC, channel_id);

ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'FOLLOW_REQUEST';
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'FOLLOW_REQUEST_APPROVED';
-- The two new kinds carry neither a video nor a comment; dedup (notifications_dedup) is per actor, so a request
-- that is rejected and sent again does not notify twice. kind::text: a new enum value cannot be referenced as a
-- literal in the transaction that adds it.
ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind::text = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL)
    OR (kind::text IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL)
    OR (kind::text IN ('NEW_SUBSCRIBER', 'FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED') AND video_id IS NULL
        AND comment_id IS NULL)
);

CREATE TYPE media.image_purpose AS ENUM ('AVATAR', 'BANNER', 'POST');
CREATE TYPE media.image_status AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED');

CREATE TABLE media.images (
    id           uuid PRIMARY KEY,
    owner_id     uuid NOT NULL,
    purpose      media.image_purpose NOT NULL,
    status       media.image_status NOT NULL DEFAULT 'UPLOADING',
    content_type text NOT NULL,             -- declared by the client; the transcoder trusts only the probe
    size_bytes   bigint NOT NULL,
    raw_bucket   text NOT NULL,
    raw_key      text NOT NULL,             -- deleted by the transcoder once READY or FAILED
    image_key    text,                      -- media bucket, WebP
    thumb_key    text,                      -- media bucket, WebP
    width        integer,                   -- of image_key
    height       integer,
    output_bytes bigint,                    -- image + thumb, for storage accounting
    error        text,                      -- failure reason code (FAILED)
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT images_size CHECK (size_bytes BETWEEN 1 AND 20971520),
    CONSTRAINT images_content_type CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
    CONSTRAINT images_ready CHECK (status <> 'READY' OR (image_key IS NOT NULL AND thumb_key IS NOT NULL
        AND width > 0 AND height > 0 AND output_bytes > 0)),
    CONSTRAINT images_failed CHECK ((status = 'FAILED') = (error IS NOT NULL))
);
CREATE TRIGGER images_set_updated_at
    BEFORE UPDATE ON media.images
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Upload quotas (per owner, last 24 h) and the janitor for abandoned uploads.
CREATE INDEX images_owner_created ON media.images (owner_id, created_at DESC);
CREATE INDEX images_stale_uploads ON media.images (created_at) WHERE status = 'UPLOADING';

-- What other services may read (grant SELECT on this view, not on media.images).
CREATE VIEW media.ready_images AS
SELECT id, owner_id, purpose, image_key, thumb_key, width, height
FROM media.images
WHERE status = 'READY';
