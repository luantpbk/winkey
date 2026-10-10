# Kickoff — Antigravity 3 · Task CIN2-social (series + cinema catalogue in social-svc)

Design: ADR-035. Contract: `contracts/openapi/social.v1.yaml`, tag `cinema` plus `Playlist.is_series` (api-client
already regenerated). Migration 000019 (`social.playlists.is_series` + trigger + indexes) is merged by the architect.

````text
# ROLE
You are Antigravity 3 on Winkey (repo luantpbk/winkey). You own services/auth, services/social, services/realtime and
shared TS packages. Never edit contracts/, db/, deploy/, apps/web.

# REPO
Worktree: git worktree add ../winkey-ag3-cin2 -b agent/ag3/cin2-social-series origin/main

# DEFINITIONS (ADR-035)
A video is PLAYABLE for series S when it has a social.videos row, visibility = 'PUBLIC', hidden = false, and
owner_id = S.owner_id. Episodes = S's playlist_items that are playable, ordered by (position, video_id).
episode_number = 1-based rank in that order.

# TASK (services/social only)
1. Playlists:
   - Return `is_series` on every Playlist.
   - Accept it in createPlaylist / updatePlaylist. It is rejected for WATCH_LATER (409 WATCH_LATER_IMMUTABLE as
     today).
   - Turning it on with foreign items → 409 SERIES_FOREIGN_ITEM. addPlaylistItem of a foreign video into a series →
     409 SERIES_FOREIGN_ITEM.
   - Map the DB trigger's check_violation with message SERIES_FOREIGN_ITEM to the same 409, so a race gives the same
     answer.
2. `GET /v1/cinema/catalog` (listCinemaCatalog), with `kind` = all | series | video:
   - SERIES item for each PUBLIC is_series playlist with ≥ 1 playable episode. `updated_at` = max(added_at) of its
     playable episodes. `first_video_id`, `episode_count` and `owner` come from auth.public_profiles, as the playlist
     routes already do.
   - VIDEO item for each social.videos row that is PUBLIC, not hidden, and NOT a playable episode of any PUBLIC
     series. `added_at` = social.videos.created_at.
   - Sort by timestamp desc, then id desc. Use an opaque keyset cursor (base64url JSON {t,id,k}); `kind=all`
     interleaves both kinds.
   - limit ≤ 48. `Cache-Control: public, max-age=60`. The answer is identical for anonymous and signed-in callers.
   - Use one SQL query per page, built on the new indexes (playlists_public_series, videos_catalog). No N+1. Check
     EXPLAIN on a seeded DB with 5 000 videos and 200 series.
3. `GET /v1/series/{id}/episodes` (listSeriesEpisodes):
   - SeriesSummary plus a page of {video_id, episode_number}, keyset on (position, video_id), limit ≤ 48,
     default 48.
   - 404 SERIES_NOT_FOUND unless the playlist is PUBLIC, is_series and has ≥ 1 playable episode.
4. `GET /v1/series/{id}/episodes/{video_id}` (getSeriesEpisode):
   - Return episode_number, previous/next playable episode ids (null at the ends), and `page_cursor` (the
     listSeriesEpisodes cursor, default limit, of the page containing it; null for page 1).
   - 404 SERIES_NOT_FOUND / EPISODE_NOT_FOUND as in the contract.
5. Gateway paths: `/v1/cinema` and `/v1/series` (Antigravity 2 adds the routes; you document them in the README).
   Errors are RFC 9457 with `code`.

# DEFINITION OF DONE
- Integration tests (testcontainers, real migrations up to 000019), covering:
  - foreign-item 409 on update and on add, plus the race path through the trigger;
  - catalogue: a PRIVATE / UNLISTED / hidden video is excluded; a video in a PUBLIC series is not a standalone VIDEO
    but is one in an UNLISTED series; a series with 0 playable episodes is excluded; owner mismatch is excluded;
  - `kind` filter; stable cursor when a new video arrives between pages;
  - episodes: numbering skips non-playable items without gaps; pagination across a page boundary;
  - episode context: first and last (null previous / next), page_cursor correct for an episode on page 2;
    EPISODE_NOT_FOUND for a hidden episode.
- Lint, typecheck and tests pass, CI green; new tests 10× in a row. The PR is the Handoff Report with real outputs.
  You do NOT deploy.
````
