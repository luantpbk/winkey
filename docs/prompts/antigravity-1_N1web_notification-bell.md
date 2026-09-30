# Kickoff — Antigravity 1 · Task N1-web (notification bell + notifications page)

Starts after U8 (#128, merged). Design: ADR-023. Contract on main: tag `notifications` in
contracts/openapi/social.v1.yaml (`listNotifications`, `getUnreadNotificationCount`, `markNotificationsRead`). The
backend (Antigravity 3, N1 in social-svc) and the gateway route `/v1/notifications` (Antigravity 2) are in progress —
build against MSW; the contract is final.

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-n1web -b agent/ag1/n1-web-notifications origin/main
READ FIRST: docs/DECISIONS.md ADR-023 (kinds, filtering, polling, "no titles" limitation), contracts/openapi/
social.v1.yaml (tag `notifications`, schemas Notification / NotificationPage / UnreadCount /
MarkNotificationsReadRequest; getComment; video.v1.yaml getVideo), apps/web/src/components/layout/top-bar.tsx.
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/n1-web-notifications.
First: `pnpm --filter @winkey/api-client run generate`.

# TASK N1-web — build
1. Bell in the top bar (signed-in users only):
   - badge from `getUnreadNotificationCount`: hidden at 0, the number up to 99, "99+" when `capped` is true;
   - React Query, `refetchInterval` 60 s **only while the tab is visible** (`refetchIntervalInBackground: false`),
     refetch on window focus; stop entirely when signed out; on 401 do nothing extra (the auth layer handles it);
   - no polling on the server (SSR renders the bell without a count).
2. Dropdown on click (accessible: button with aria-expanded, focus trap/escape, keyboard navigation):
   - the latest 10 via `listNotifications?limit=10`, a "Xem tất cả" link to `/[locale]/notifications`;
   - opening the dropdown does NOT mark anything read; clicking an item marks THAT id read
     (`markNotificationsRead {ids:[id]}`) and navigates; a "Đánh dấu đã đọc tất cả" button sends
     `{up_to: <created_at of the newest notification shown>}` (never the client clock);
   - optimistic update of the item + badge, rolled back on error; invalidate the count after a mutation.
3. Rendering per kind (vi + en messages, plural-safe):
   - `VIDEO_PUBLISHED` "{actor} vừa đăng video mới" → /watch/{video_id};
   - `VIDEO_COMMENT` "{actor} đã bình luận về video của bạn" → /watch/{video_id}?comment={comment_id};
   - `COMMENT_REPLY` "{actor} đã trả lời bình luận của bạn" → same;
   - `NEW_SUBSCRIBER` "{actor} đã đăng ký kênh của bạn" → /c/{actor.handle};
   - avatar + relative time; unread items visually distinct (not by color only).
   - Titles/snippets (ADR-023 known limitation): fetch the video title with `getVideo` lazily for the visible items
     only, cached by React Query (staleTime 5 min, dedupe identical ids); if it 404s show the text without a title,
     never an error state. Do not fetch comment bodies in the dropdown.
4. Page `/[locale]/notifications`: infinite list with `next_cursor`, tabs "Tất cả" / "Chưa đọc" (`unread=true`),
   the same item component, empty and error states, `noindex`.
5. If `/watch/{id}?comment={comment_id}` does not already scroll to / highlight a comment, add it (top-level comment:
   scroll to it; reply: expand its parent thread first — you have `getComment` for parent_id).
6. MSW handlers for the 3 endpoints (with a switch for capped=true and for an empty list).

# DEFINITION OF DONE
- Vitest + Testing Library: badge 0 / 7 / 99+; polling only when visible (fake timers + visibilitychange); dropdown
  a11y (keyboard, escape); click marks one id; "mark all" sends up_to = newest created_at; optimistic rollback on
  500; each kind renders the right text + link; title lazy-load and 404 fallback; page pagination + unread tab.
- Playwright (MSW): sign in → badge shows 3 → open → click a VIDEO_COMMENT item → lands on the watch page with the
  comment highlighted → badge 2; "mark all" → badge hidden.
- `pnpm --filter @winkey/web run lint && typecheck && test && build`, root `pnpm run lint && pnpm run format:check`,
  CI green; new test files 10× in a row (paste the count; give the bash loop).
- PR against main; description = Handoff Report with the real outputs (paste them yourself).

# OUT OF SCOPE
Backend (Antigravity 3), gateway route (Antigravity 2), push/realtime, notification settings, grouping, any contract
change (→ `contract-change` issue).
````
