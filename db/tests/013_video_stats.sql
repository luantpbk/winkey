\set ON_ERROR_STOP on

-- A normal row and an upsert (what analytics-worker does on every rollup).
INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers,
                                   startup_p50_ms, startup_p95_ms, refreshed_at)
VALUES ('00000000-0000-7000-8000-000000001301', '00000000-0000-7000-8000-0000000013c1', '2026-10-01',
        3, 90000, 500, 0, 2, 400, 900, now());
INSERT INTO analytics.video_daily AS d (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers,
                                        startup_p50_ms, startup_p95_ms, refreshed_at)
VALUES ('00000000-0000-7000-8000-000000001301', '00000000-0000-7000-8000-0000000013c1', '2026-10-01',
        5, 150000, 700, 1, 4, NULL, NULL, now())
ON CONFLICT (video_id, day) DO UPDATE
   SET starts = EXCLUDED.starts, watched_ms = EXCLUDED.watched_ms, rebuffer_ms = EXCLUDED.rebuffer_ms,
       errors = EXCLUDED.errors, viewers = EXCLUDED.viewers, startup_p50_ms = EXCLUDED.startup_p50_ms,
       startup_p95_ms = EXCLUDED.startup_p95_ms, refreshed_at = EXCLUDED.refreshed_at;

DO $$
BEGIN
    IF (SELECT starts FROM analytics.video_daily
         WHERE video_id = '00000000-0000-7000-8000-000000001301' AND day = '2026-10-01') <> 5 THEN
        RAISE EXCEPTION 'upsert did not replace the row';
    END IF;
    IF (SELECT count(*) FROM analytics.video_daily) <> 1 THEN
        RAISE EXCEPTION 'upsert created a second row';
    END IF;
END $$;

DO $$
DECLARE
    bad text[] := ARRAY[
        -- negative counters
        $q$INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, refreshed_at)
           VALUES ('00000000-0000-7000-8000-000000001302', '00000000-0000-7000-8000-0000000013c1', '2026-10-01', -1, 0, 0, 0, 0, now())$q$,
        $q$INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, refreshed_at)
           VALUES ('00000000-0000-7000-8000-000000001302', '00000000-0000-7000-8000-0000000013c1', '2026-10-01', 0, -5, 0, 0, 0, now())$q$,
        -- p50 above p95
        $q$INSERT INTO analytics.video_daily (video_id, owner_id, day, starts, watched_ms, rebuffer_ms, errors, viewers,
                                              startup_p50_ms, startup_p95_ms, refreshed_at)
           VALUES ('00000000-0000-7000-8000-000000001302', '00000000-0000-7000-8000-0000000013c1', '2026-10-01', 1, 1, 0, 0, 1, 900, 400, now())$q$,
        -- missing owner
        $q$INSERT INTO analytics.video_daily (video_id, day, starts, watched_ms, rebuffer_ms, errors, viewers, refreshed_at)
           VALUES ('00000000-0000-7000-8000-000000001302', '2026-10-01', 0, 0, 0, 0, 0, now())$q$
    ];
    q text;
BEGIN
    FOREACH q IN ARRAY bad LOOP
        BEGIN
            EXECUTE q;
            RAISE EXCEPTION 'accepted invalid row: %', q;
        EXCEPTION WHEN check_violation OR not_null_violation THEN
            NULL;
        END;
    END LOOP;
END $$;

\echo ok 013_video_stats
