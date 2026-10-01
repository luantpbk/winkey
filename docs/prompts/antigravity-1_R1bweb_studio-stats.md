# Kickoff — Antigravity 1 · Task R1-b-web (creator statistics in the studio)

Backend is merged (#151): `getChannelStats` (`GET /v1/studio/stats`) and `getVideoStats`
(`GET /v1/studio/videos/{video_id}/stats`) in contracts/openapi/video.v1.yaml (tag `studio`, ADR-022 addendum R1-b).
Starts only after PL1-web (#145) is merged.

````text
# ROLE
You are Antigravity 1, the frontend engineer on "Winkey" (repo luantpbk/winkey). You own apps/web, e2e/,
packages/api-client. Read AGENTS.md first. Never edit contracts/, services/, deploy/.

# REPO
Worktree: git worktree add ../winkey-ag1-r1bweb -b agent/ag1/r1b-web-studio-stats origin/main
READ FIRST: the two operations and the StatsTotals / VideoStats / VideoStatsDay / ChannelStats / ChannelStatsDay /
ChannelStatsTopVideo schemas (every description: timezone, day filling, null rules, refreshed_at, 404, 60/min).

# TASK
1. `/[locale]/studio/analytics` (link "Thống kê" in the studio nav). The page calls `getChannelStats`.
   - Range picker: 7 / 28 / 90 days. Send `from`/`to` as dates in Asia/Ho_Chi_Minh (the server's timezone), never
     the browser's local date.
   - Totals cards: lượt phát (`starts`), thời gian xem (`watch_time_ms` as h:mm), thời gian xem trung bình
     (`avg_watch_ms`, "—" when null), tỉ lệ giật hình (`rebuffer_ratio` as %, "—" when null).
   - A daily line/bar chart of starts and watch time. Inline SVG or the chart lib the app already has; do not add a
     heavy dependency without saying why in the PR.
   - Top-10 table linking to the per-video page.
   - Footer: "Cập nhật lúc {refreshed_at}", or "Chưa có dữ liệu" when null. Add a note that numbers can lag while
     the analytics server is offline.
2. `/[locale]/studio/videos/[id]/analytics` (tab next to the existing edit page) calls `getVideoStats` with the same
   picker and cards, plus `view_count` ("lượt xem đã tính", explain in a tooltip that it differs from lượt phát),
   per-day viewers and startup p50/p95.
3. States: loading skeleton, empty (all zeros), 404 → "Không tìm thấy video", 429 → retry message. Never show a
   NaN/Infinity: rely on the nulls the contract gives.
4. MSW handlers for both operations (realistic 28-day data, a range with nulls, 404, 429).
5. i18n vi/en for every string.

# DEFINITION OF DONE
- Vitest:
  - range → `from`/`to` in Asia/Ho_Chi_Minh, including a browser in UTC−8 near midnight;
  - formatting of null ratios and averages;
  - the chart renders every day in `days`;
  - top-10 links;
  - 404 and 429 states;
  - the page never calls the API without auth.
- Playwright (MSW): open studio → Thống kê → switch to 7 days → open a top video → its stats page shows the right
  title and totals.
- web lint/typecheck/test/build, root lint + format:check, CI green, new tests 10× in a row. Open the PR yourself with
  the Handoff Report (real outputs).

# OUT OF SCOPE
Export/CSV, per-country breakdowns, realtime numbers, any API change.
````
