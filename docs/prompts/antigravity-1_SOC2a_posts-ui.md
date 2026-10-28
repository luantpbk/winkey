# Antigravity 1 — SOC-2a: posts, feeds, reactions, post comments (web)

Read `AGENTS.md`, **ADR-049** (the SOC-2 addendum 2026-10-28), then in `contracts/openapi/social.v1.yaml` the `posts`, `post-comments` and `feeds` tag descriptions and their operations; `upload.v1.yaml` tag `images` (purpose `POST`). Regenerate `packages/api-client` from the contracts.

Work in `apps/web`, `packages/api-client`, `e2e/`. Branch `agent/ag1/soc2a-posts-ui` from `origin/main`. You can start with MSW mocks before social-svc lands; mocks must follow the contract exactly.

## Pages and components
1. **Composer** (on `/bang-tin` and on the user's own profile):
   - textarea with a live counter (2000), visibility select (Công khai / Người theo dõi; hidden for private accounts, which are always followers-only — show a note);
   - attach up to 10 images: compress in the browser first (long edge 1600 px, WebP or JPEG ~0.8 via canvas), then `createImageUpload` (purpose `POST`) → `PUT` → poll `getImage` until `READY`; show progress and per-image errors; allow reordering and removing before posting;
   - or attach a Winkey video by pasting a watch URL / picking from "Video của tôi";
   - `@` autocomplete from people the user follows (existing APIs), `#` free text;
   - disable "Đăng" until valid; map `IMAGE_INVALID`, `429` to clear Vietnamese messages.
2. **Post card** (reused in every feed, timeline and the post page):
   - author, time (relative), visibility icon, "đã chỉnh sửa";
   - body rendered as **text**: split it into tokens and link only the `@handle` / `#tag` tokens listed in `mentions` / `hashtags` (to `/@handle` and `/hashtag/<slug>`); never `dangerouslySetInnerHTML`;
   - image grid (1, 2, 3, 4, 5+ layouts) with `thumb_url`, lightbox with `url`, `width`/`height` to avoid layout shift, `loading="lazy"`;
   - embedded video: hydrate `video_id` with `batchGetVideos` (one call per page) and show a video card linking to the watch page; `null` → nothing;
   - reshare: nested card of `reshared_post`; `reshare_unavailable` → "Bài viết này không còn khả dụng";
   - reaction bar: hover/long-press picker with the six kinds, `top_reactions` icons + `reaction_count`, optimistic update with rollback on error; click the count → reactions dialog (`listPostReactions`, tabs per kind);
   - "Bình luận" (count) and "Chia sẻ" menu: plain reshare, reshare with text (opens composer), copy link; hide reshare when not allowed (not PUBLIC, private author, or own plain reshare exists → API `409`);
   - menu: edit (body + visibility), delete (confirm), report (`POST`), and for moderators hide/restore.
3. **Post page** `/bai-viet/[id]`: the card + post comments (reuse the video comment components, pointed at the post-comment endpoints; report target `POST_COMMENT`). SSR metadata (title from the first 60 characters, `og:image` = first image) for public posts only; `noindex` for `FOLLOWERS` posts.
4. **Feeds** `/bang-tin`: tabs "Đang theo dõi" (signed in) and "Khám phá"; infinite scroll with `next_cursor`; on `CURSOR_EXPIRED` reload from the top; empty states with suggestions to follow people / explore.
5. **Hashtag page** `/hashtag/[tag]` and a "Thịnh hành" box (`listTrendingHashtags`) on `/bang-tin`.
6. **Profile**: new "Bài viết" tab on `/@handle` (`listChannelPosts`); private account not followed → the existing private notice.
7. **Notifications**: render the five `POST_*` kinds (link to the post / comment); ignore unknown kinds.

## Quality
- All new pages work at 360 px width; keyboard-accessible reaction picker; images have `alt` ("Ảnh 1 của bài viết của …").
- CSP: no new inline scripts, no `eval`.
- Tests: token rendering (XSS strings stay text; only listed handles/tags become links), reaction optimistic update + rollback, composer validation and image upload states, feed paging and `CURSOR_EXPIRED`, reshare unavailable. E2E (MSW or the local stack): post with 3 images, react, comment, reshare, see it in the follower's feed.

Push, open the PR with the Handoff Report (screenshots of feed, composer and post page at desktop and 360 px), report when CI and sims are green.
