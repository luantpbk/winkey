-- Task MUX1 (ADR-042): extra audio tracks (dub, voice-over, commentary) of a video, uploaded separately and encoded
-- as HLS alternate audio renditions. Upload-svc creates the row (UPLOADING) and completes it (UPLOADED); the
-- transcoder moves it to PROCESSING, then READY (playlist_key set) or FAILED. At most 8 per video (checked by the
-- services) and one per (lang, kind); at most one default per video.
CREATE TABLE media.video_audio_tracks (
    id             uuid        PRIMARY KEY,
    video_id       uuid        NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    lang           text        NOT NULL CHECK (lang ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
    label          text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 50),
    kind           text        NOT NULL CHECK (kind IN ('original', 'dub', 'voiceover', 'commentary')),
    is_default     boolean     NOT NULL DEFAULT false,
    status         text        NOT NULL DEFAULT 'UPLOADING'
                               CHECK (status IN ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED')),
    raw_bucket     text        NOT NULL,
    raw_key        text        NOT NULL,
    s3_upload_id   text,                                   -- multipart upload id while UPLOADING
    content_type   text        NOT NULL,
    size_bytes     bigint      NOT NULL CHECK (size_bytes BETWEEN 1 AND 4294967296),
    playlist_key   text,                                   -- v/{video}/a{n}/audio/{track}/index.m3u8 once READY
    duration_ms    integer     CHECK (duration_ms > 0),
    error          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT video_audio_tracks_lang_kind UNIQUE (video_id, lang, kind),
    CONSTRAINT video_audio_tracks_ready_playlist CHECK ((status = 'READY') = (playlist_key IS NOT NULL))
);

CREATE UNIQUE INDEX video_audio_tracks_one_default ON media.video_audio_tracks (video_id) WHERE is_default;
CREATE INDEX video_audio_tracks_status ON media.video_audio_tracks (status, updated_at)
    WHERE status IN ('UPLOADING', 'UPLOADED', 'PROCESSING');

-- Subtitle kind (MUX1): captions describe sounds for deaf and hard-of-hearing viewers. One track per language.
ALTER TABLE media.video_subtitles
    ADD COLUMN kind text NOT NULL DEFAULT 'subtitles' CHECK (kind IN ('subtitles', 'captions'));
