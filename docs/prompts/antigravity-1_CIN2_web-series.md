# Kickoff — Antigravity 1 · Task CIN2-web (series on the cinema home + episode playback)

Design: ADR-035. Contract: `social.v1.yaml` tag `cinema` and `Playlist.is_series` (api-client already regenerated).
You can build against MSW now; the real API comes from Antigravity 3 (CIN2-social).

````text
# ROLE
You are Antigravity 1 on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client. Never edit
contracts/, services/, deploy/.

# REPO
Worktree: git worktree add ../winkey-ag1-cin2 -b agent/ag1/cin2-web-series origin/main

# TASK
1. Cinema home (`/`): add three rows from `listCinemaCatalog`, placed after "Top 10 hôm nay":
   - "Phim bộ" (`kind=series`), "Phim lẻ" (`kind=video`), "Mới thêm" (`kind=all`).
   - Hydrate each page with ONE `batchGetVideos` call: video_id for VIDEO items, `series.first_video_id` for SERIES
     items. Drop items the batch omits.
   - Series card: the cover is the thumbnail of first_video_id, plus the series title, the badge "N tập"
     (episode_count) and the channel. Reuse the CIN1 card states and tokens (`docs/design/cinema-home/`).
   - Rows load lazily and are hidden when empty or on error, as in CIN1.
2. Series detail dialog (`?series=<playlist_id>`, back closes it):
   - Cover backdrop, title, description, channel, "N tập".
   - "Xem ngay" goes to episode 1. "Xem sau" adds episode 1 to watch-later.
   - Episode list from `listSeriesEpisodes`: number, thumbnail, title and duration via batch, paginated with "Tải
     thêm".
3. Watch page with `?playlist=<id>`:
   - Call `getSeriesEpisode`. On 200:
     - desktop shows an episode column on the right in place of "Xem tiếp", with the current episode highlighted and
       scrolled into view; mobile shows the episode list under the player;
     - "Tập trước" / "Tập sau" buttons, also the N / P keys when focus is not in an input;
     - episode links keep `?playlist=` (and `src=playlist` per ADR-030).
   - On 404, play normally without series UI and remove `playlist` from the URL with replaceState.
   - Switching episodes must end the old playback session (heartbeat end) before starting the new one: one player
     only, and no signed URL kept in state across episodes.
   - Never auto-play the next episode.
4. Playlist create/edit form: add a "Bộ phim" checkbox. On 409 SERIES_FOREIGN_ITEM, show "Bộ phim chỉ chứa video của
   chính kênh bạn." On the playlist page, a series shows the badge "Bộ phim".
5. i18n in vi.json and en.json.

# DEFINITION OF DONE
- Vitest:
  - row hydration: one batch per page, omitted ids dropped;
  - series card renders the episode count;
  - dialog `?series=` with back;
  - watch page: series context, previous/next, end-then-start heartbeat order, 404 fallback strips `playlist`;
  - checkbox and 409 message.
- Playwright (MSW), desktop and mobile:
  - home → series card → dialog → Xem ngay → watch page with episode list → Tập sau → URL and heartbeat are correct;
  - refresh keeps the series context.
- Screenshots (vi locale), web lint, typecheck, test and build, CI green, new tests 10× in a row. The PR is the
  Handoff Report.
````
