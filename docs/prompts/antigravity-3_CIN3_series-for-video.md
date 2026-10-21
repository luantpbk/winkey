# Antigravity 3 — CIN3: `GET /v1/series?video_id=` in social-svc (ADR-045)

Read `AGENTS.md`, ADR-035 and **ADR-045**, and the contract `contracts/openapi/social.v1.yaml` → `listSeriesForVideo` and the `SeriesForVideo` schema. Work only in `services/social`.

Branch: `agent/ag3/cin3-series-for-video` from `origin/main`. One PR; the description is the Handoff Report.

## Task
- Route `GET /v1/series` with the query `video_id` (a UUID, else `400 VALIDATION_ERROR`), optional auth, in `src/routes/cinema.ts` next to `listSeriesEpisodes`.
- Return `{ items: SeriesSummary[] }`: at most 5 `PUBLIC` `is_series` playlists whose items contain `video_id` **as a playable episode** (the same playable rule and SQL predicate as `listSeriesEpisodes`, with no copy that can drift; extract a shared helper if needed). Order by `updated_at DESC`, then `playlist_id`.
- Build `SeriesSummary` the same way the catalogue does (`episode_count` = playable episodes, `first_video_id`, owner `PublicProfile`).
- An unknown, non-playable or non-episode video returns `200 {items: []}`, never 404.
- `Cache-Control: public, max-age=60`.
- Make sure an index serves the lookup (playlist items by `video_id`). If a new index is needed, **do not write a migration**: open a `contract-change`/db issue for the architect with the exact `CREATE INDEX`.

## Tests
- Integration tests on real Postgres, contract-checked like the other cinema routes:
  - a video in one series;
  - a video in two series (order);
  - a video in a PRIVATE series or a non-series playlist (excluded);
  - a hidden/PRIVATE video (empty);
  - an unknown id (empty);
  - a malformed id (400).

## Definition of Done
- Lint, typecheck and tests are green, locally and in CI.
- Paste real `curl` output for the cases above in the PR.
