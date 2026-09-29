-- media schema — owned by upload-svc, transcoder and video-svc (tasks V1–V3, S1).

CREATE TYPE media.video_status AS ENUM ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');
CREATE TYPE media.visibility AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');
CREATE TYPE media.job_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE media.videos (
    id             uuid PRIMARY KEY,
    owner_id       uuid NOT NULL,           -- auth.users.id; no cross-schema FK (ADR-007)
    title          text NOT NULL,
    description    text NOT NULL DEFAULT '',
    visibility     media.visibility NOT NULL DEFAULT 'PUBLIC',
    status         media.video_status NOT NULL DEFAULT 'UPLOADING',
    raw_bucket     text NOT NULL,
    raw_key        text NOT NULL,
    s3_upload_id   text,                    -- multipart upload id; cleared once UPLOADED
    content_type   text NOT NULL,
    size_bytes     bigint NOT NULL,
    duration_ms    integer,
    width          integer,
    height         integer,
    hls_master_key text,                    -- current attempt's master.m3u8 key in the media bucket
    thumbnail_key  text,
    error          text,                    -- owner-safe message of the last failure
    view_count     bigint NOT NULL DEFAULT 0,
    like_count     bigint NOT NULL DEFAULT 0,
    published_at   timestamptz,             -- first time the video became READY
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT videos_title_len CHECK (char_length(title) BETWEEN 1 AND 100),
    CONSTRAINT videos_description_len CHECK (char_length(description) <= 5000),
    CONSTRAINT videos_size CHECK (size_bytes > 0 AND size_bytes <= 21474836480),
    CONSTRAINT videos_ready_has_output CHECK (
        status <> 'READY' OR (hls_master_key IS NOT NULL AND thumbnail_key IS NOT NULL
                              AND duration_ms IS NOT NULL AND published_at IS NOT NULL)),
    CONSTRAINT videos_counts CHECK (view_count >= 0 AND like_count >= 0)
);

CREATE INDEX videos_owner_created ON media.videos (owner_id, created_at DESC, id DESC);
CREATE INDEX videos_public_feed ON media.videos (published_at DESC, id DESC)
    WHERE status = 'READY' AND visibility = 'PUBLIC';
CREATE INDEX videos_stale_uploads ON media.videos (created_at) WHERE status = 'UPLOADING';

CREATE TRIGGER videos_set_updated_at
    BEFORE UPDATE ON media.videos
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Defence in depth for the state machine; services must still use conditional updates
-- (UPDATE ... WHERE status = $expected) to detect races.
--   UPLOADING  -> UPLOADED | FAILED
--   UPLOADED   -> PROCESSING | FAILED
--   PROCESSING -> READY | FAILED
--   FAILED     -> PROCESSING            (manual retry)
--   READY      -> PROCESSING            (re-encode; the old output keeps serving until the new one is READY)
CREATE FUNCTION media.guard_video_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF (OLD.status, NEW.status) IN (
        ('UPLOADING'::media.video_status,  'UPLOADED'::media.video_status),
        ('UPLOADING',  'FAILED'),
        ('UPLOADED',   'PROCESSING'),
        ('UPLOADED',   'FAILED'),
        ('PROCESSING', 'READY'),
        ('PROCESSING', 'FAILED'),
        ('FAILED',     'PROCESSING'),
        ('READY',      'PROCESSING')
    ) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid video status transition % -> % for video %', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER videos_guard_status
    BEFORE UPDATE OF status ON media.videos
    FOR EACH ROW EXECUTE FUNCTION media.guard_video_status();

CREATE TABLE media.video_renditions (
    video_id     uuid NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    name         text NOT NULL,             -- '1080p', '720p', '480p'
    width        integer NOT NULL CHECK (width > 0),
    height       integer NOT NULL CHECK (height > 0),
    bitrate_kbps integer NOT NULL CHECK (bitrate_kbps > 0),
    playlist_key text NOT NULL,
    PRIMARY KEY (video_id, name),
    CONSTRAINT video_renditions_name CHECK (name ~ '^[0-9]{3,4}p$')
);

CREATE TABLE media.transcode_jobs (
    id          uuid PRIMARY KEY,
    video_id    uuid NOT NULL REFERENCES media.videos (id) ON DELETE CASCADE,
    attempt     integer NOT NULL CHECK (attempt >= 1),
    status      media.job_status NOT NULL DEFAULT 'QUEUED',
    encoder     text CHECK (encoder IN ('nvenc', 'x264')),
    worker_id   text,                       -- hostname/pod of the worker that ran it
    progress    real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz,
    UNIQUE (video_id, attempt)
);
-- At most one active job per video.
CREATE UNIQUE INDEX transcode_jobs_one_active ON media.transcode_jobs (video_id)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE media.outbox (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE,
    subject      text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX media_outbox_pending ON media.outbox (id) WHERE published_at IS NULL;
