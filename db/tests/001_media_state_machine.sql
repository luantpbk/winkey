-- Runs inside a transaction that is rolled back; see scripts/db-test.sh.
\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-0000000000aa',
        'test', 'winkey-raw', 'k', 'video/mp4', 1024);

-- Invalid jump UPLOADING -> READY is rejected by the guard trigger.
DO $$
BEGIN
    UPDATE media.videos SET status = 'READY' WHERE id = '00000000-0000-7000-8000-000000000001';
    RAISE EXCEPTION 'TEST FAILED: UPLOADING -> READY was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Happy path.
UPDATE media.videos SET status = 'UPLOADED', s3_upload_id = NULL WHERE id = '00000000-0000-7000-8000-000000000001';
UPDATE media.videos SET status = 'PROCESSING' WHERE id = '00000000-0000-7000-8000-000000000001';

-- READY without output columns is rejected by videos_ready_has_output.
DO $$
BEGIN
    UPDATE media.videos SET status = 'READY' WHERE id = '00000000-0000-7000-8000-000000000001';
    RAISE EXCEPTION 'TEST FAILED: READY without output was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

UPDATE media.videos
SET status = 'READY', hls_master_key = 'v/x/a1/hls/master.m3u8', thumbnail_key = 'v/x/a1/thumb/poster.jpg',
    duration_ms = 1000, published_at = now()
WHERE id = '00000000-0000-7000-8000-000000000001';

-- Re-encode is allowed, backwards to UPLOADED is not.
UPDATE media.videos SET status = 'PROCESSING' WHERE id = '00000000-0000-7000-8000-000000000001';
DO $$
BEGIN
    UPDATE media.videos SET status = 'UPLOADED' WHERE id = '00000000-0000-7000-8000-000000000001';
    RAISE EXCEPTION 'TEST FAILED: PROCESSING -> UPLOADED was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Only one active transcode job per video.
INSERT INTO media.transcode_jobs (id, video_id, attempt, status)
VALUES ('00000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000001', 1, 'RUNNING');
DO $$
BEGIN
    INSERT INTO media.transcode_jobs (id, video_id, attempt, status)
    VALUES ('00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000001', 2, 'QUEUED');
    RAISE EXCEPTION 'TEST FAILED: second active job was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
UPDATE media.transcode_jobs SET status = 'FAILED' WHERE id = '00000000-0000-7000-8000-000000000011';
INSERT INTO media.transcode_jobs (id, video_id, attempt, status)
VALUES ('00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000001', 2, 'QUEUED');

-- Oversized upload is rejected.
DO $$
BEGIN
    INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
    VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-0000000000aa',
            'big', 'winkey-raw', 'k2', 'video/mp4', 21474836481);
    RAISE EXCEPTION 'TEST FAILED: >20 GiB upload was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

\echo 'ok 001_media_state_machine'
