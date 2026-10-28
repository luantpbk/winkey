# Antigravity 4 — SOC-2a: system-test personas and feed load test

Read `AGENTS.md`, **ADR-049** (the SOC-2 addendum 2026-10-28) and the `posts`, `post-comments`, `feeds` tags in `contracts/openapi/social.v1.yaml`. Work in `systest/` and `loadtest/`. Branch `agent/ag4/soc2a-personas` from `origin/main`. Start once AG3's social-svc PR and AG1's web PR are merged (or run against their branches locally).

## System tests (TAP suite + Playwright personas)
1. **S11 posts (API):** two users A, B; B follows A.
   - A posts text + 2 images (real upload through upload-svc → transcoder → `READY`), B sees it first in "Đang theo dõi"; anonymous `getPost` works for a PUBLIC post.
   - A posts `FOLLOWERS`; C (not following) gets `404`, B sees it.
   - A makes the account private; C gets `404` for every A post and an empty `listChannelPosts`.
   - B reacts LIKE then LOVE → `reaction_count` 1, A has exactly one `POST_REACTION`.
   - B comments, A replies → counters and `POST_COMMENT` / `POST_COMMENT_REPLY`.
   - B reshares (plain) → `POST_RESHARE`; second plain reshare → `409 ALREADY_RESHARED`; reshare of the reshare points at the original.
   - `#HàNội` and `#hanoi` posts both appear in `listHashtagPosts(hanoi)`; `@B` creates `POST_MENTION`.
   - A blocks B → B gets `404` on A's posts, A's posts vanish from B's feed; A mutes C → C's posts vanish from A's feed.
   - A deletes the post → `404`; the reshare shows `reshare_unavailable: true`.
   - Moderator hides a reported post → gone for everyone except moderators; restore brings it back.
2. **Persona "social user"** (Playwright, desktop + 360 px): compose with 3 images, see upload progress, post, react via the picker, comment, reshare with text, open the hashtag page, open a notification and land on the post.
3. **Security checks:** XSS strings in body/comments render as text; a post body with `@` of a blocked user is not linked; image ids of another user → `IMAGE_INVALID`.

## Load test (`loadtest/`)
- Seed 2 000 users, each following 50–200 others, 100 000 posts over 30 days, 10 % with images (fake keys are fine for load).
- Scenario: 80 % `getFollowingFeed` (first page + 2 next pages), 15 % `getExploreFeed`, 5 % `createPost` / `setPostReaction`.
- Targets on the local stack sized like the edge: p95 `getFollowingFeed` < 150 ms, error rate < 0.5 %. Report p50/p95/p99 and the slowest queries (`pg_stat_statements`).
- Production load tests only in the 02:00–03:30 ICT window or with a dated user approval.

Report results in the PR's Handoff Report; report when CI is green.
