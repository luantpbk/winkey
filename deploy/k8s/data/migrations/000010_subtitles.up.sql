-- Task V5b (ADR-018): WebVTT subtitle tracks, one per language per video.
-- UPLOAD = the owner uploaded the file; AUTO is reserved for auto-captions (V5c, not built yet).
-- object_key is a NEW key on every upload (v/{video_id}/subtitles/{lang}-{uuid}.vtt), so objects stay
-- immutable and cacheable; the media janitor already removes v/{video_id}/ when the video is deleted.
CREATE TABLE media.video_subtitles (
    video_id   uuid        NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    lang       text        NOT NULL CHECK (lang ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
    label      text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 50),
    source     text        NOT NULL DEFAULT 'UPLOAD' CHECK (source IN ('UPLOAD', 'AUTO')),
    object_key text        NOT NULL CHECK (object_key LIKE 'v/%/subtitles/%.vtt'),
    size_bytes integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, lang)
);
