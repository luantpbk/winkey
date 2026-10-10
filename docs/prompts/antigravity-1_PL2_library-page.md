# Kickoff — Antigravity 1 · Task PL2-web (Thư viện: manage own playlists and series)

Gap found by the user on 2026-10-10: winkey.vn has no page to create or manage playlists. Today the only way is
"Lưu" on a watch page → "Tạo danh sách mới". The sidebar "Thư viện" is a dead `#library` link, and the cinema top bar
"Danh sách của tôi" goes to watch-later. Without this page, creators cannot practically build a "Bộ phim" (ADR-035).

No contract change: listChannelPlaylists (the owner sees all their own lists, watch-later first), createPlaylist,
updatePlaylist, deletePlaylist, listPlaylistItems, addPlaylistItem, removePlaylistItem, movePlaylistItem,
listStudioVideos and batchGetVideos already exist.

````text
# ROLE
You are Antigravity 1 on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client. Never edit
contracts/, services/, deploy/.

# REPO
Worktree: git worktree add ../winkey-ag1-pl2 -b agent/ag1/pl2-library origin/main

# TASK
1. New page `/thu-vien` ("Thư viện"; en "Library"). Signed in only; otherwise redirect to login with return_to.
   - A header with the button "+ Tạo danh sách".
   - A grid of the caller's playlists from `listChannelPlaylists(caller id)`, paginated, watch-later first.
   - Each card shows: cover (thumbnail of the first item via one batch per page), title, item_count, a visibility
     badge (Công khai / Không công khai / Riêng tư) and a "Bộ phim" badge when is_series. Clicking it opens
     /playlist/{id}.
   - Empty state: one sentence plus the create button.
2. "Tạo danh sách" dialog:
   - Fields: title (required, ≤ 150), description (≤ 5 000), visibility (default Riêng tư), and the checkbox
     "Bộ phim (gom các tập thành một bộ trên trang chủ)".
   - Hint under the checkbox: "Bộ phim chỉ chứa video của chính bạn và phải để Công khai mới hiện ở trang chủ."
   - On success, go to the new playlist page.
3. Playlist page (/playlist/{id}), owner view:
   - Add a button "+ Thêm video của tôi". It opens a picker that lists the caller's own READY videos from
     `listStudioVideos` (paginated, with search by title on the client side), with checkboxes.
   - "Thêm N video" calls addPlaylistItem for each selected video in order, at most 4 in parallel, and reports each
     failure (409 SERIES_FOREIGN_ITEM / PLAYLIST_FULL) in plain Vietnamese.
   - Keep the existing edit / series toggle / reorder / remove behaviour.
   - When is_series and visibility != PUBLIC, show a notice: "Bộ phim đang ở chế độ <x>, chưa hiện trên trang chủ."
4. Navigation:
   - Sidebar "Thư viện" goes to /thu-vien (replace `#library`).
   - Cinema top bar "Danh sách của tôi" goes to /thu-vien. Watch-later stays reachable as the first card.
   - Mobile tab "Tôi" gets a "Thư viện" entry, if the tab has a menu.
   - On the channel page, the playlists tab shows the "+ Tạo danh sách" button to the owner only.
5. i18n in vi.json and en.json.

# DEFINITION OF DONE
- Vitest:
  - the page redirects anonymous users;
  - the grid shows badges (series, visibility);
  - the create dialog validates input and navigates on success;
  - the picker adds the selected videos in order and shows per-item 409 messages;
  - the non-public series notice appears;
  - the nav links point to /thu-vien.
- Playwright (MSW), desktop and mobile: create a list marked "Bộ phim" → add 3 own videos → set Công khai → the home
  "Phim bộ" row (MSW) shows it.
- Screenshots (vi), web lint, typecheck, test and build, CI green, new tests 10× in a row. The PR is the Handoff
  Report.
````
