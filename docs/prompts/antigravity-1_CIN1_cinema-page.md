# Kickoff — Antigravity 1 · Task CIN1 (Trang phim `/phim`)

Design: ADR-033. No contract change: every endpoint below already exists and is already in `@winkey/api-client`.

````text
# ROLE
You are Antigravity 1, frontend engineer on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client.
Never edit contracts/, services/, deploy/. Read AGENTS.md and docs/DECISIONS.md ADR-030 and ADR-033 first.

# REPO
Worktree: git worktree add ../winkey-ag1-cin1 -b agent/ag1/cin1-cinema-page origin/main

# GOAL
A "web phim" page with the SAME videos as today, presented to pull viewers in: a large rotating hero, horizontal rows,
cards that grow on hover, and a detail dialog. Route `/phim` (both locales: `/phim`, `/en/phim`). Sidebar entry
"Phim" / "Movies" (lucide `Clapperboard`) directly under "Trang chủ".

# PAGE (top to bottom)
1. HERO, full-bleed, about 70vh on desktop and 56vw on mobile.
   - Source: `listVideos?sort=trending&limit=5`. If that returns no items, use `sort=newest&limit=5`.
   - Auto-advances every 8 s, pauses on hover/focus, has dots and keyboard arrows.
   - Backdrop: `thumbnail_url` with object-cover, plus a left and bottom dark gradient so text is readable.
     Thumbnails are at most 1280 px wide, so use a slight scale and no sharpening tricks.
   - Text: title (2 lines max) and meta line (channel · duration · views · relative date). The description comes from
     `getVideo` for the ACTIVE slide only (3 lines max), fetched lazily and cached.
   - Buttons: "▶ Xem ngay" goes to the watch page with `?src=trending` (or `latest` when the hero fell back to
     newest). "+ Xem sau" works only when signed in (use the existing watch-later logic) and otherwise opens login.
     "ⓘ Chi tiết" opens the detail dialog.
   - Muted preview: after the active slide has been idle 3 s, play the slide's HLS (`getVideo().playback.hls_url`)
     with hls.js, muted, inline, at the LOWEST rendition, and fade it in over the backdrop.
     - Stop it on slide change, when the hero leaves the viewport, when the tab is hidden, or after 30 s, and keep
       the poster.
     - Never play it on screens < 768 px, with `prefers-reduced-motion: reduce`, or with `navigator.connection.saveData`.
     - The preview MUST NOT send playback heartbeats, MUST NOT call recordView, and MUST NOT write resume positions.
       Reuse hls.js directly, not the full VideoPlayer component.
2. ROWS, each a horizontal scroller.
   - Scroll-snap; prev/next buttons on desktop that scroll one viewport; native swipe on touch.
   - Visible cards: 2.2 on mobile, 3.5 on tablet, 5.5 on desktop.
   - Each row loads only when it is near the viewport (IntersectionObserver, rootMargin 400px). Each row shows at most
     20 cards, with skeletons while loading.
   - An empty or failed row is hidden; it never breaks the page. Log the failure to console only.
   - Rows, in this order:
     a. "Xem tiếp", continue watching: from the local index below, with `batchGetVideos`. Each card shows a red progress
        bar and an "×" button that removes the entry. Surface `other`.
     b. "Top 10 hôm nay": `listVideos?sort=trending&limit=10`, with large outlined rank numerals beside the cards.
        Surface `trending`. Hide the row if it has fewer than 3 videos.
     c. "Dành cho bạn", signed in only: `getRecommendedFeed?limit=20`. Surface `for_you`.
     d. "Mới cập nhật": `listVideos?sort=newest&limit=20`. Surface `latest`.
     e. "Từ kênh bạn theo dõi", signed in only: `getSubscriptionFeed?limit=20`. Surface `subscriptions`.
     f. EDITORIAL rows. The curator handle comes from server env `CINEMA_CURATOR_HANDLE`: read it in the page's server
        component (`process.env`, at request time, not at build time) and pass it down as a prop.
        - When the handle is set: `getUserByHandle` → `listChannelPlaylists(owner id, limit=8)`. Each playlist becomes a
          row titled with the playlist title, in API order. Load the row with `listPlaylistItems(limit=20)` +
          `batchGetVideos`, keeping playlist order.
        - "Xem tất cả" goes to the existing playlist page. Surface `playlist`.
        - Handle empty, unknown (404), or no playlists → no editorial rows and no error.
3. CARD (16:9).
   - Thumbnail, duration badge, title below (1 line).
   - Desktop hover or keyboard focus, after 300 ms: the card scales to about 1.25 and shows a panel with full title,
     channel, views and date, and the buttons ▶ (watch), + (watch later) and ⓘ (details). The first and last visible
     cards grow inward so they are never clipped.
   - NO video on card hover, and NO getVideo per card.
   - Every watch link uses the existing ADR-030 href helper with the row's surface.
4. DETAIL DIALOG.
   - Opened by ⓘ or by a card click on touch devices (on desktop a click plays). URL state is `?v=<id>`, so back
     closes it, and a link with `?v=` opens it directly.
   - Content: large backdrop, title, meta, full description (`getVideo`), channel link, and the buttons Xem ngay /
     Xem sau / Chia sẻ (copy link).
   - "Tương tự": `listRelatedVideos?limit=12`, shown as a grid. Surface `up_next`.
   - Accessible: focus trap, Esc closes, `aria-modal`, and focus returns to the opener.
5. LOOK.
   - This route is always a dark cinematic theme, whatever the site theme.
   - Near-black background (#0b0b0f range) and one red accent for progress, active dot and the primary button.
   - Large bold headings, generous spacing, smooth 200–300 ms transitions, and all motion disabled under
     prefers-reduced-motion.
   - Use the existing font and lucide icons; NO new UI library. Tailwind only.
   - Lighthouse on /phim (mobile, MSW data): Performance ≥ 85 and Accessibility ≥ 95. Above the fold, only the hero
     image is eager (priority); every other image is lazy.

# CONTINUE-WATCHING INDEX (player change, inside apps/web)
- The VideoPlayer already stores `winkey_playback_pos_<id>`. When it saves a position, also upsert into
  localStorage `winkey.continue_watching`, a JSON array, newest first, of at most 20 entries `{id, t, d, at}`:
  `t` = seconds, `d` = duration seconds, `at` = epoch ms.
- Remove the entry when the position is cleared (ended) or t/d ≥ 0.95. Invalid JSON → treat as empty.
- Every access is wrapped in try/catch.
- The row drops ids that `batchGetVideos` did not return, and rewrites the index without them.
- Signed-out users have the row too; it is per browser.

# I18N
Every string is in messages/vi.json and messages/en.json under a `cinema` namespace. Vietnamese is the primary copy.

# NOT IN SCOPE (CIN2, needs contracts first)
Genres, year, series/episodes, vertical posters, server-synced continue watching, a `cinema` surface value.

# DEFINITION OF DONE
- Vitest:
  - hero fallback to newest, and the 8 s rotation pauses on hover;
  - the preview never starts under reduced-motion, saveData or a small screen, and never sends heartbeats or views;
  - each row's API call and surface;
  - an empty or failed row is hidden;
  - editorial rows: unset handle, 404 handle, playlist order kept;
  - continue-watching index: upsert, cap 20, ≥ 95 % removal, bad JSON, and pruning of unreadable ids;
  - dialog `?v=` open/close with back.
- Playwright (MSW), desktop and mobile viewport: /phim renders hero + rows; a card → dialog → "Xem ngay" lands on
  /watch/<id> and the first heartbeat has the expected surface; a keyboard-only pass through hero, row and dialog.
- Add screenshots (desktop + mobile, light and dark site theme) to the PR.
- web lint/typecheck/test/build, root lint + format:check, CI green; new tests 10× in a row. The PR description is the
  Handoff Report with real command outputs.
````
