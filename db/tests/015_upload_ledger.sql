\set ON_ERROR_STOP on

-- UQ1-b: the upload ledger is append-only; only rows older than 25 h can be deleted.
INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes)
VALUES ('00000000-0000-7000-8000-0000000017a1', '00000000-0000-7000-8000-0000000017aa', 1000);
INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
VALUES ('00000000-0000-7000-8000-0000000017a2', '00000000-0000-7000-8000-0000000017aa', 2000,
        now() - interval '26 hours');

DO $$
BEGIN
    UPDATE media.upload_ledger SET size_bytes = 1 WHERE video_id = '00000000-0000-7000-8000-0000000017a1';
    RAISE EXCEPTION 'TEST FAILED: ledger row was updated';
EXCEPTION WHEN restrict_violation THEN NULL;
END $$;
DO $$
BEGIN
    DELETE FROM media.upload_ledger WHERE video_id = '00000000-0000-7000-8000-0000000017a1';
    RAISE EXCEPTION 'TEST FAILED: a recent ledger row was deleted';
EXCEPTION WHEN restrict_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes)
    VALUES ('00000000-0000-7000-8000-0000000017a3', '00000000-0000-7000-8000-0000000017aa', 0);
    RAISE EXCEPTION 'TEST FAILED: zero size was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Retention sweep: rows outside every window can go.
DELETE FROM media.upload_ledger WHERE created_at < now() - interval '25 hours';

-- Deleting the video does not touch the ledger (no FK), so the daily quota still counts it.
INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-0000000017a4', '00000000-0000-7000-8000-0000000017aa', 'x', 'raw', 'k17', 'video/mp4', 500);
INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes)
VALUES ('00000000-0000-7000-8000-0000000017a4', '00000000-0000-7000-8000-0000000017aa', 500);
DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-0000000017a4';

DO $$
BEGIN
    IF (SELECT count(*) FROM media.upload_ledger WHERE owner_id = '00000000-0000-7000-8000-0000000017aa') <> 2
       OR (SELECT sum(size_bytes) FROM media.upload_ledger
           WHERE owner_id = '00000000-0000-7000-8000-0000000017aa' AND created_at > now() - interval '24 hours') <> 1500 THEN
        RAISE EXCEPTION 'TEST FAILED: ledger counts after retention sweep and video delete';
    END IF;
END $$;

\echo ok 015_upload_ledger
