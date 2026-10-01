# Kickoff — Antigravity 1 · Task R2-c-web ("Xem tiếp" column on the watch page)

Backend is merged (#158, ADR-025): `listRelatedVideos` (`GET /v1/videos/{video_id}/related?limit=`) in
contracts/openapi/video.v1.yaml, schema `RelatedVideos` (items are `VideoSummary`).

````text
# ROLE
You are Antigravity 1, the frontend engineer on "Winkey" (repo luantpbk/winkey). You own apps/web, e2e/,
packages/api-client. Read AGENTS.md first. Never edit contracts/, services/, deploy/.

# REPO
Worktree: git worktree add ../winkey-ag1-r2cweb -b agent/ag1/r2c-web-related origin/main
READ FIRST: listRelatedVideos (description: no auth needed, same answer for every caller, cached 300 s, 404 when the
source is not publicly watchable: a PRIVATE, hidden or unfinished video gives 404 even to its owner), ADR-025.
Do not touch `pnpm-lock.yaml` unless you add a dependency (you should not need one).

# TASK
1. On `/[locale]/watch/[id]`, a "Xem tiếp" column:
   - desktop (≥ 1024 px): right of the player, beside the description/comments;
   - mobile: under the player and the description, before the comments.
2. Data: call `listRelatedVideos` with `limit=12`, WITHOUT the Authorization header (the answer is public and
   shared; sending the token would only fragment caches). Use the existing react-query setup: `staleTime` 5 min,
   key `['related', videoId]`, no refetch on window focus.
3. Each item: thumbnail (16:9, lazy), title (2 lines max), channel name (link to the channel), view count and
   relative publish date, duration badge. Reuse the existing video card/summary components where they exist.
   Clicking an item navigates to its watch page; the column then reloads for the new video.
4. States:
   - loading: 6 skeleton rows;
   - empty `items: []`: hide the column (no empty box);
   - 404: hide the column silently (the source is PRIVATE/hidden/processing; the player page already handles
     what the viewer may see) and do not log an error;
   - other errors / network: hide the column, no toast, no retry loop.
5. Never render the current video in the list (the server excludes it; still filter by id defensively).
6. i18n vi/en for every string ("Xem tiếp" / "Up next"). MSW handlers: 12 items, empty, 404, 500.

# DEFINITION OF DONE
- Vitest:
  - the request has no Authorization header even when signed in;
  - 12 items render in server order with title, channel, views and duration;
  - empty and 404 hide the column; 500 hides it without a toast;
  - navigating to another video requests `related` for the new id (one request per video id);
  - the current video id is never rendered.
- Playwright (MSW): open a watch page → the column shows → click the 2nd item → URL changes and the column shows
  the new list.
- web lint/typecheck/test/build, root lint + format:check, CI green. New test file run 10× in a row. Open the PR
  yourself with the Handoff Report (real outputs).

# OUT OF SCOPE
Personalised recommendations (R2), autoplay of the next video, any backend change.
````
