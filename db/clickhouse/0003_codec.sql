-- Task AV1-tel (ADR-048): which codec each playback used and whether the device can play AV1, to decide when to raise
-- AV1_TOP_N. Applied by analytics-worker at start-up like 0001/0002 (every statement is idempotent). Columns are
-- Nullable: rows written before this file, and samples from older clients, stay NULL ("unknown").
-- Ships in the SAME PR as the worker change that adds them to its INSERT column list (the worker names its columns
-- since R2-ab, so adding the columns first is harmless; the order only matters the other way round).
--
-- Share of AV1-capable devices among playbacks of the last 7 days (one start per playback):
--   SELECT countIf(av1_capable) / countIf(av1_capable IS NOT NULL) AS av1_capable_share
--   FROM winkey.playback_events FINAL
--   WHERE kind = 'start' AND received_at >= now() - INTERVAL 7 DAY
-- Share of watch time actually served as AV1 over the same window:
--   SELECT sumIf(watched_ms, codec = 'av1') / sumIf(watched_ms, codec IS NOT NULL) AS av1_watch_share
--   FROM winkey.playback_events FINAL
--   WHERE received_at >= now() - INTERVAL 7 DAY

ALTER TABLE winkey.playback_events
    ADD COLUMN IF NOT EXISTS codec       LowCardinality(Nullable(String)),
    ADD COLUMN IF NOT EXISTS av1_capable Nullable(Bool);
