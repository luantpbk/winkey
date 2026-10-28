# Antigravity 3 — SOC-2a: posts, reactions, post comments, hashtags, mentions and feeds (social-svc)

Read `AGENTS.md`, **ADR-049** (the SOC-2 addendum 2026-10-28), then in `contracts/openapi/social.v1.yaml`:
- the `posts`, `post-comments` and `feeds` tag descriptions (they are the rules; this brief only adds how);
- every operation under those tags, and the schemas `Post`, `PostImage`, `PostMention`, `PostHashtag`, `ReactionCount`, `PostPage`, `CreatePostRequest`, `EditPostRequest`, `SetReactionRequest`, `ReactionState`, `ReactionPage`, `PostComment`, `PostCommentPage`, `TrendingHashtags`;
- the changes to `NotificationKind`, `Notification` (`post_id`, `post_comment_id`) and `ReportTargetType`.

Migration `000031_posts_feeds` is merged (do not write migrations). Read its comments: tables, triggers (all counters are maintained by triggers, never update them in code), `posts_one_plain_reshare`, `post_hashtags.slug` (generated), `notifications_dedup`.

Work in `services/social` only. Branch `agent/ag3/soc2a-posts-feeds` from `origin/main`. If the PR gets too large, split it: (1) posts + reactions + reshares + mentions/hashtags, (2) post comments + notifications + reports, (3) feeds + scoring job. Each PR must pass CI on its own.

## 1. Visibility helper (do this first, use it everywhere)
One SQL fragment / function `canSeePost(viewer, post)`, matching the `posts` tag:
- `status = 'VISIBLE'` (moderators/admins also see `HIDDEN` on `getPost`, the moderation endpoint and moderation views only, never in feeds);
- no block either way (reuse the SOC-1b block helper);
- viewer is the author, **or** (`visibility = 'PUBLIC'` and the author's `auth.public_profiles.is_private = false`), **or** viewer has a row in `social.subscriptions` to the author;
- author has an active profile (`auth.public_profiles`), otherwise the post is not returned at all.
Not visible → `404` (never `403`, do not leak existence).

## 2. Posts
- `createPost`:
  - trim the body; reject empty body without attachment (`400 VALIDATION_ERROR`); `image_ids`, `video_id`, `reshare_of` are mutually exclusive (`400`).
  - **Images:** one query `SELECT id, image_key, thumb_key, width, height FROM media.ready_images WHERE id = ANY($1) AND owner_id = $caller AND purpose = 'POST'`; all must be found and none already in `social.post_media` (unique index `post_media_image` also guards races → map `23505` to `400 IMAGE_INVALID`). Insert `post_media` rows in the given order (`position` 0..9) and set `media_count`.
  - **Video:** must exist in `social.videos`, not hidden, and `PUBLIC`/`UNLISTED` or owned by the caller; else `404`.
  - **Reshare:** load the target; if it is itself a reshare, use its `reshare_of`. The original must be visible to the caller, `PUBLIC`, by a public account (`409 NOT_RESHAREABLE` otherwise; `404` if not visible). The reshare is always `PUBLIC` (a `FOLLOWERS` value → `400`). Plain reshare twice → unique violation on `posts_one_plain_reshare` → `409 ALREADY_RESHARED`. Notify the original author `POST_RESHARE` (post_id = the new reshare).
  - Parse mentions and hashtags (section 4) in the same transaction.
  - Rate limit 30 posts/hour/user (existing rate limiter, Valkey).
- `getPost`: build the full `Post` (section 6).
- `editPost`: author only (`403` otherwise), `VISIBLE` only (`409`). Body change sets `edited_at` and re-parses mentions/hashtags (replace rows; notify only users not mentioned before). `FOLLOWERS` on a reshare → `409 RESHARE_VISIBILITY`.
- `deletePost`: author, moderator or admin. Set `status = 'DELETED'`, `body = ''`; delete its `post_media`, `post_reactions`, `post_hashtags`, `post_mentions`, `post_scores` rows; keep comments. Idempotent `204`.
- `moderatePost`: moderator/admin; `HIDDEN` ↔ `VISIBLE`; `DELETED` → `409`.

## 3. Reactions
- `setPostReaction`: caller must see the post. `INSERT … ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction`. Notify the author `POST_REACTION` (`ON CONFLICT DO NOTHING`; never to self). Rate limit 300 changes/hour/user.
- `removePostReaction`: delete; idempotent.
- Both return `ReactionState` (`top_reactions`: `GROUP BY reaction ORDER BY count DESC, reaction LIMIT 3` on `post_reactions_post_kind`).
- `listPostReactions`: keyset on `(created_at, user_id)`; optional `reaction` filter uses `post_reactions_post_kind`; exclude block relations with the caller and inactive profiles.

## 4. Mentions and hashtags
- One parser module with unit tests, shared by create and edit. Token rules are in the `posts` tag. Use Unicode-aware regexes (`\p{L}\p{N}_` with the `u` flag); a token must start at the beginning of the body or after a character that is not a letter, digit, `_`, `@` or `#`.
- Mentions: resolve handles case-insensitively via `auth.public_profiles` in one query; drop unknown handles, the author, and users in a block relation with the author; keep the first 10 distinct. Notify `POST_MENTION` only if the mentioned user can see the post (e.g. not for a `FOLLOWERS` post they do not follow).
- Hashtags: keep the first spelling of each slug, at most 10; insert `(post_id, tag, created_at = post.created_at)`. Let the DB compute `slug`; for an input whose slug is empty, the CHECK fails, so filter those out first with `SELECT public.winkey_tag_slug($1)` (or compute all slugs in one query).
- `Post.mentions` returns the **current** handle from `auth.public_profiles` (handles can change).

## 5. Post comments
Mirror the existing video comment code path (two levels, tombstones, `HIDDEN`, edit, delete, replies, moderation), against `social.post_comments`:
- caller must see the post; block with the post author or (reply) the parent author → `403 INTERACTION_BLOCKED`;
- notifications: top-level → post author `POST_COMMENT`; reply → parent author `POST_COMMENT_REPLY` (and not twice to the same person, not to self);
- delete: comment author, **post** author, moderator or admin;
- rate limit 10/min/user (same limiter as video comments, separate key).

## 6. Building `Post` (avoid N+1)
For a page of posts, batch-load in a fixed number of queries: authors (`auth.public_profiles`), images (`post_media`), mentions, hashtags, top reactions (one `GROUP BY post_id, reaction` query, then take 3 per post in code), the caller's reactions, the visibility of embedded videos (`social.videos`), and the reshared originals (one level; apply `canSeePost` to each original). Image URLs = `MEDIA_BASE_URL` + key (same env as avatars). `can_edit` / `can_delete` per the schema.

## 7. Feeds
- `getFollowingFeed`: authors = caller ∪ `SELECT channel_id FROM social.subscriptions WHERE subscriber_id = $caller`, minus muted and block relations. Query: `WHERE author_id = ANY($authors) AND status = 'VISIBLE' AND (created_at, id) < ($c_at, $c_id) ORDER BY created_at DESC, id DESC LIMIT $n` (every author here is followed or self, so `FOLLOWERS` posts are allowed). Cache the first page per user in Valkey for 30 s (key includes `limit`); invalidate the author's own cache on their create/delete.
- `getExploreFeed`: read `social.post_scores` ordered by `(score DESC, post_id DESC)`, then apply `canSeePost` plus mute/block filters. The cursor encodes `(computed_at snapshot, score, post_id)`; if the current snapshot is newer → `400 CURSOR_EXPIRED`.
- **Scoring job** (in-process, every 10 min, guarded by a Valkey lock so only one replica runs it): for `VISIBLE`, `PUBLIC` posts of public accounts created in the last 7 days, score = `(reaction_count + 2*comment_count + 3*reshare_count + 1) / power(extract(epoch from now() - created_at)/3600 + 2, 1.5)`; replace `social.post_scores` in one transaction (delete rows not in the new set, upsert the rest, same `computed_at`).
- `listHashtagPosts`: slug from the path via `public.winkey_tag_slug`; join `post_hashtags` (index `post_hashtags_slug`) → posts, apply `canSeePost`. Empty slug → `400`.
- `listTrendingHashtags`: last 24 h, public posts of public accounts, `GROUP BY slug`, most used spelling as `tag`; cache 60 s; `Cache-Control: public, max-age=60`.
- `listChannelPosts`: `posts_author_timeline`; `404` if the channel has no active profile; empty page for a private account the caller does not follow.
- **EXPLAIN tests** (real PG, with a few thousand seeded posts, `ANALYZE` first): the following-feed, explore and hashtag queries must not contain `Seq Scan on posts`. Fail the test if they do.

## 8. Notifications and reports
- `listNotifications` returns `post_id` / `post_comment_id` and drops post notifications whose post/comment is not `VISIBLE` or no longer visible to the recipient.
- Reports accept `POST` and `POST_COMMENT` (`target_id` must exist, else `404`); the moderation queue lists them; `resolveModerationCase` works for them. Moderators act with `moderatePost` / `moderatePostComment`.

## 9. Tests (Definition of Done)
- Unit: parser (Vietnamese diacritics, `#HàNội` vs `#hanoi`, emails like `a@b.com` are not mentions, URLs with `#` fragments are not hashtags, 10-item caps), visibility helper truth table (public/private account × PUBLIC/FOLLOWERS × follower/not × blocked either way × author).
- Contract tests: every new response validated against `social.v1.yaml` (extend `tests/contracts/openapi.test.ts`).
- Real-PG integration: create with images (other user's image, wrong purpose, not READY, reused → `IMAGE_INVALID`), reshare rules (reshare of a reshare → original; plain twice → 409; FOLLOWERS original → 409), reactions + notification dedup, comments two levels + counters, feeds with follows/blocks/mutes/private accounts, explore cursor expiry, EXPLAIN checks.
- README: new endpoints, env (none new except what you add), the scoring job and its lock.

Push, open the PR with the Handoff Report, report when CI is green.
