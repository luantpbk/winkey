\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, description, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000fe01', '00000000-0000-7000-8000-0000000000c0',
        'HIST1', '', 'winkey-raw', 'h1', 'video/mp4', 1024);

INSERT INTO media.watch_history (user_id, video_id, watched_ms)
VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-00000000fe01', 31000);

DO $$
BEGIN
    BEGIN
        INSERT INTO media.watch_history (user_id, video_id, watched_ms)
        VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-00000000fe01', 1);
        RAISE EXCEPTION 'TEST FAILED: a second row for the same user and video was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO media.watch_history (user_id, video_id, watched_ms)
        VALUES ('00000000-0000-7000-8000-0000000000c2', '00000000-0000-7000-8000-00000000fe01', -1);
        RAISE EXCEPTION 'TEST FAILED: a negative watched_ms was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

-- Deleting the video deletes its history rows.
DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000fe01';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.watch_history WHERE video_id = '00000000-0000-7000-8000-00000000fe01') THEN
        RAISE EXCEPTION 'TEST FAILED: history rows survived the video';
    END IF;
END $$;
