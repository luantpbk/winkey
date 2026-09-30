# Kickoff — Antigravity 1 · Task PL1-web (save to playlist, watch later, playlist pages)

Starts after N2-web (#137, merged). Design: ADR-024. Contract on main: tag `playlists` in social.v1.yaml and
`batchGetVideos` in video.v1.yaml. Backends in progress (Antigravity 3 social-svc, Sonnet batchGetVideos): build
against MSW; the contract is final.

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree: git worktree add ../winkey-ag1-pl1web -b agent/ag1/pl1-web-playlists origin/main
READ FIRST: ADR-024, the `playlists` tag + `batchGetVideos`. You own: apps/web, e2e/, packages/api-client.
First: `pnpm --filter @winkey/api-client run generate`.

# TASK PL1-web
1. Watch page: "Lưu" button → dialog listing my playlists (`listChannelPlaylists` for me, watch-later first), each
   with a checkbox pre-checked from `getPlaylistMembership(video_id)`, plus a "Tạo danh sách mới" inline form
   (title, visibility). Toggling calls add/remove with optimistic update + rollback; 409 PLAYLIST_FULL /
   PLAYLIST_LIMIT → toast.
2. "Xem sau" quick action on video cards (hover menu) and on the watch page → `getWatchLater` (cache its id) +
   `addPlaylistItem`.
3. `/[locale]/playlist/[id]`: header (title, owner, visibility badge, item count), items via `listPlaylistItems`
   (infinite) + ONE `batchGetVideos` per page for titles/thumbnails (skip ids the batch omitted: show "Video không
   còn khả dụng" row only to the owner so they can remove it). Owner: rename/visibility/delete, remove item,
   drag-and-drop reorder (keyboard accessible: move up/down buttons) via `movePlaylistItem`.
4. Channel page tab "Danh sách phát" (`listChannelPlaylists`), sidebar entry "Xem sau" for signed-in users.
5. MSW handlers for every playlist endpoint + batchGetVideos (with a switch for 409s).

# DEFINITION OF DONE
- Vitest: save dialog add/remove/create + rollback on 500 + 409 toasts; watch-later id cached (one getWatchLater per
  session); playlist page merges items with batch results in order and handles omitted ids; reorder calls move with
  the right `before_video_id` (drag and keyboard); owner-only controls hidden for others; channel tab lists only
  what the API returns.
- Playwright (MSW): save a video to watch later → open Xem sau → see it → remove it.
- web lint/typecheck/test/build, root lint + format:check, CI green, new tests 10×. Open the PR yourself with the
  Handoff Report (real outputs).
````
