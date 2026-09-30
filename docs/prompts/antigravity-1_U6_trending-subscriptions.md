# Kickoff — Antigravity 1 · Task U6 (Trending page + subscription feed UI)

Starts after U5 (#99, merged) and the flaky-test fix (#106, merged). The contracts are on main: `listVideos`
`sort=trending` (R2-a, ADR-020, backend merged) and `getSubscriptionFeed` `GET /v1/feed/subscriptions`
(R2-b, ADR-021 — backend in progress by Sonnet; build against MSW, the contract is final).

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u6 -b agent/ag1/u6-trending-subscriptions origin/main
READ FIRST: docs/DECISIONS.md ADR-020 (trending) and ADR-021 (subscription feed), contracts/openapi/video.v1.yaml
(listVideos `sort`, INVALID_SORT, getSubscriptionFeed), apps/web/src/app/[locale]/page.tsx (the home feed:
useInfiniteQuery + IntersectionObserver), components/layout/sidebar.tsx (the `#trending` / `#subscriptions`
placeholders), components/video/video-card.tsx + video-skeleton.tsx, lib/hooks/use-safe-timeout.ts.
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u6-trending-subscriptions.
First: `pnpm --filter @winkey/api-client run generate` so the client has `sort` and `/v1/feed/subscriptions`.

# TASK U6 — build
0. Clean-up carried from #106 (small, first commit): drop the re-export apps/web/src/hooks/use-safe-timeout.ts
   and the `safeTimeout.safeTimeout` self-property (one import path, a plain function; update the destructuring
   test); add `expect(api.auth.GET).toHaveBeenCalledTimes(n)` (unchanged after unmount + advanceTimers) to the
   "unmounts cleanly right after successful action" test in admin.test.tsx.
1. Extract the home feed's infinite list into ONE reusable component (e.g. components/video/video-feed.tsx:
   props = queryKey + a page fetcher + empty-state slot). Home, Trending and Subscriptions all use it; no
   copy-pasted IntersectionObserver code.
2. /[locale]/trending — `GET /v1/videos?sort=trending&limit=12`, cursor paging (max 200 in total, so the list
   simply ends). The ranking may be EMPTY (no recent views): then show a short notice ("Chưa có video thịnh
   hành — xem video mới nhất") and render the newest feed below it (same component, `sort` omitted). Numbered
   rank badge (1, 2, 3…) on each card in the trending list only. React Query `staleTime: 60_000` (the response
   is cacheable 60 s).
3. /[locale]/feed/subscriptions — signed-in only (same redirect to `/login?return_to=…` as settings/account).
   `GET /v1/feed/subscriptions`. Empty page → empty state with a CTA to Trending ("Bạn chưa theo dõi kênh nào…").
   401 → treat like an expired session (existing auth flow). `staleTime: 0` (private, no-store). After the user
   subscribes/unsubscribes via SubscribeButton, invalidate the ['feed','subscriptions'] query (eventual
   consistency: do NOT optimistically insert videos).
4. Sidebar: replace the `#trending` and `#subscriptions` placeholders with real links (`/trending`,
   `/feed/subscriptions`; the subscriptions link only when signed in), labels via next-intl (vi + en) — no
   hard-coded "Thịnh hành". Active state works for both routes. Leave #music/#gaming/#library/#history as they are.
5. i18n vi + en for every new string; MSW handlers for both endpoints (trending non-empty, trending empty,
   subscriptions non-empty/empty/401, INVALID_SORT not needed in UI).

# DEFINITION OF DONE
- Vitest (RTL + MSW): trending renders ranks 1..n and pages with the cursor; empty trending shows the notice
  AND the newest feed; subscriptions redirects anonymous users; empty state + CTA; subscribe/unsubscribe
  invalidates the feed query; video-feed component unit test (sentinel → fetchNextPage, stops when next_cursor null).
- Playwright scenario: sidebar → Trending → a video; signed-in → Subscriptions (MSW/dev stack).
- `pnpm --filter @winkey/web run lint && typecheck && test && build`, root `pnpm run lint && pnpm run
  format:check`, CI green. Run the new test files 10× in a row and paste the count (no new flakes).
- PR against main; description = Handoff Report with the real outputs + screenshots of both pages (vi, light+dark).

# OUT OF SCOPE
Backend, contracts (→ `contract-change` issue), player subtitles/storyboard (next task), gateway routes
(`/v1/feed` on Traefik is Antigravity 2's).
````
