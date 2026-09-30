-- Task C4: social-svc learns each video's visibility so PRIVATE videos accept no comments or likes from
-- outsiders. Fed by video.ready (optional `visibility`) and video.visibility_changed. Text + CHECK, not the
-- media enum: no cross-schema dependency (ADR-007). Existing rows default to PUBLIC = today's behaviour.
ALTER TABLE social.videos
    ADD COLUMN visibility text NOT NULL DEFAULT 'PUBLIC',
    ADD CONSTRAINT social_videos_visibility CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE'));
