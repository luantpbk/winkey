\set ON_ERROR_STOP on

INSERT INTO media.videos (id, owner_id, title, raw_bucket, raw_key, content_type, size_bytes)
VALUES ('00000000-0000-7000-8000-00000000f901', '00000000-0000-7000-8000-0000000000c0',
        'Trending', 'winkey-raw', 'k9', 'video/mp4', 1024);

INSERT INTO media.video_views_hourly (video_id, hour, views)
VALUES ('00000000-0000-7000-8000-00000000f901', '2026-09-30T06:00:00Z', 5);
-- the flusher's upsert adds to the bucket
INSERT INTO media.video_views_hourly (video_id, hour, views)
VALUES ('00000000-0000-7000-8000-00000000f901', '2026-09-30T06:00:00Z', 3)
ON CONFLICT (video_id, hour) DO UPDATE SET views = media.video_views_hourly.views + EXCLUDED.views;

INSERT INTO media.trending (video_id, rank, score, computed_at)
VALUES ('00000000-0000-7000-8000-00000000f901', 1, 8.0, now());

DO $$
DECLARE
    bad text[] := ARRAY[
        $q$INSERT INTO media.video_views_hourly VALUES ('00000000-0000-7000-8000-00000000f901', '2026-09-30T07:00:00Z', 0)$q$,
        $q$INSERT INTO media.video_views_hourly VALUES ('00000000-0000-7000-8000-00000000f9ff', '2026-09-30T07:00:00Z', 1)$q$,
        $q$INSERT INTO media.trending VALUES ('00000000-0000-7000-8000-00000000f9ff', 2, 1.0, now())$q$,
        $q$UPDATE media.trending SET rank = 0$q$,
        $q$UPDATE media.trending SET score = 0$q$
    ];
    q text;
BEGIN
    IF (SELECT views FROM media.video_views_hourly WHERE video_id = '00000000-0000-7000-8000-00000000f901') <> 8 THEN
        RAISE EXCEPTION 'TEST FAILED: hourly upsert did not add';
    END IF;
    FOREACH q IN ARRAY bad LOOP
        BEGIN
            EXECUTE q;
            RAISE EXCEPTION 'TEST FAILED: accepted %', q;
        EXCEPTION
            WHEN check_violation OR foreign_key_violation THEN NULL;
        END;
    END LOOP;
END $$;

DELETE FROM media.videos WHERE id = '00000000-0000-7000-8000-00000000f901';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM media.video_views_hourly WHERE video_id = '00000000-0000-7000-8000-00000000f901')
       OR EXISTS (SELECT 1 FROM media.trending WHERE video_id = '00000000-0000-7000-8000-00000000f901') THEN
        RAISE EXCEPTION 'TEST FAILED: rows survived the video';
    END IF;
END $$;

\echo ok 009_trending
