# Kickoff — Antigravity 1 · Task U3 (social UI: comments, like, subscribe)

Starts after PL1 (#59, merged). social-svc (C1, #48) and its contract are on main; the api-client already
exports `createSocialClient` and the generated `SocialPaths` (#59).

````text
# ROLE
You are the Frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u3 -b agent/ag1/u3-social-ui origin/main
READ FIRST: contracts/openapi/social.v1.yaml (every operation you call, its errors and pagination),
contracts/openapi/common.yaml (Problem, cursor/next_cursor), services/social/README.md (rules: 2 comment levels,
HIDDEN/DELETED tombstones, rate limits, who may edit/delete), apps/web (U1/PL1 patterns: next-intl vi/en,
MSW handlers in src/mocks, api-client wrapper in src/lib/api-client), packages/api-client.
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u3-social-ui.

# TASK U3 — social features on the watch and channel pages, implementing social.v1.yaml exactly
1. Comments on /watch/[id]:
   - list top-level comments (listComments, cursor pagination with "Xem thêm" / "Load more"), newest first
     unless the contract says otherwise; show author display name/avatar from the response, relative time,
     "(đã chỉnh sửa)" when edited;
   - replies: second level only (listReplies, lazy-loaded per comment, paginated). Replying to a reply attaches
     to its top-level parent, exactly as the contract/README defines — never render a third level;
   - create (createComment) with optimistic insert and rollback on error; body length limits from the schema,
     counter, disabled submit while empty/too long; Idempotency or duplicate-submit protection (disable while
     pending);
   - edit/delete own comments (editComment / deleteComment); render tombstones for DELETED/HIDDEN exactly as
     returned (never show a hidden body);
   - moderation (moderateComment) is OUT of scope (A2).
2. Like on /watch/[id]: getLike / likeVideo / unlikeVideo with optimistic toggle + like_count; anonymous users
   see the count and are sent to /login on click (return to the same page after login).
3. Subscribe on /watch/[id] (channel block) and /c/[handle]: getSubscription / subscribe / unsubscribe per the
   contract, optimistic, subscriber count if the contract returns it; hide the button on your own channel.
4. Errors: RFC 9457 problems → friendly localized messages (401 → login prompt, 403, 404, 409, 429 with
   Retry-After, 5xx). Never crash the page; the player keeps playing.
5. No realtime here (that is U2 after C2). Refetch the first comment page after you post; that is enough.
6. MSW handlers for every social operation so the pages work against mocks; api-client types only (no hand
   written request/response types).

# DEFINITION OF DONE
- Unit/component tests (vitest + testing-library): comment list + pagination, reply nesting capped at 2 levels,
  optimistic create rollback on 500, edit/delete own only, tombstone rendering, like toggle rollback on error,
  anonymous like → login redirect, subscribe toggle, 429 message.
- Playwright (e2e/, against MSW or the compose stack): open a video, post a comment, reply, like, subscribe;
  screenshots updated only where the UI really changed (no render-jitter churn).
- a11y: buttons have labels (aria-pressed for like/subscribe), keyboard usable, focus returns to the composer
  after posting. The PL1 player shortcuts must not fire while typing in the composer (add a test).
- Before pushing run at the repo root: pnpm run format:check && pnpm run lint:root && pnpm run lint &&
  pnpm run typecheck && pnpm run test && pnpm run build (CI runs lint:root; turbo lint alone is not enough).
- PR description = Handoff Report with the real test output pasted.

# OUT OF SCOPE
- Moderation UI (A2), Creator Studio realtime (U2), any change to contracts/ or services/.
  If the contract lacks something you need, open a `contract-change` issue instead.
````
