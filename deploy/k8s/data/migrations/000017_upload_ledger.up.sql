-- UQ1-b (ADR-027, addendum 2026-10-01): append-only ledger of started uploads.
-- Owned by upload-svc. The daily quotas (count and bytes in a sliding 24 h) are computed from this table,
-- not from media.videos, because a video can be hard-deleted: "delete, then upload again" must still count.
-- One row per createUpload that passed the quota check, written in the same transaction as the video row.
-- No FK to media.videos (the video may be deleted) nor to auth.users (no cross-schema FK, ADR-007).

CREATE TABLE media.upload_ledger (
    video_id    uuid PRIMARY KEY,               -- id of the video created by that upload
    owner_id    uuid NOT NULL,
    size_bytes  bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT upload_ledger_size CHECK (size_bytes > 0 AND size_bytes <= 21474836480)
);
CREATE INDEX upload_ledger_owner_created ON media.upload_ledger (owner_id, created_at DESC);
CREATE INDEX upload_ledger_created ON media.upload_ledger (created_at);

-- Append-only: rows are never updated, and only rows older than 25 h (outside every quota window) may be
-- deleted, by the upload janitor's retention sweep.
CREATE FUNCTION media.upload_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'media.upload_ledger is append-only' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.created_at > now() - interval '25 hours' THEN
        RAISE EXCEPTION 'media.upload_ledger rows younger than 25 h cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER upload_ledger_guard
    BEFORE UPDATE OR DELETE ON media.upload_ledger
    FOR EACH ROW EXECUTE FUNCTION media.upload_ledger_guard();

-- Backfill the open window so the switch from media.videos to the ledger loses nothing.
INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
SELECT id, owner_id, size_bytes, created_at
FROM media.videos
WHERE created_at > now() - interval '25 hours';
