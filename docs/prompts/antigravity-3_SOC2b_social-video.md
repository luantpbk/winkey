# Antigravity 3 — SOC-2b: short social videos in posts (social-svc)

Read `AGENTS.md`, **ADR-049** (the SOC-2b addendum 2026-10-28), then:
- `contracts/openapi/social.v1.yaml`, tag `posts` (the `video_id` bullet) and `CreatePostRequest.video_id`;
- `contracts/openapi/common.yaml` `VideoPurpose`;
- `contracts/events/video.ready.schema.json` (`purpose`), `social.post.video_attached.schema.json`, `social.post.video_released.schema.json`.

Migration `000032_social_video` is merged (do not write migrations): `social.videos.purpose`, `social.posts.video_social`, unique index `posts_one_per_social_video`.

Work in `services/social` only. Branch `agent/ag3/soc2b-social-video` from `origin/main`. Do not merge your own PR.

## Tasks
1. **Projection:** the `social-videos` consumer stores `purpose` from `video.ready` (absent → keep the current value, default `FILM`).
2. **`createPost` with `video_id`:**
   - load the `social.videos` row; if `purpose = 'SOCIAL'`: it must be owned by the caller (else `404`, do not leak it) and not attached to a live post (`409 VIDEO_IN_USE`; the unique index also guards races, map `23505` on `posts_one_per_social_video` to `409 VIDEO_IN_USE`); insert the post with `video_social = true`;
   - a `FILM` keeps today's rules (`video_social = false`).
   - In the **same transaction**, when `video_social`, write `social.post.video_attached` `{post_id, video_id, author_id}` to `social.outbox`.
3. **`deletePost`:** when the post had `video_social`, write `social.post.video_released` in the same transaction (idempotent: only on the transition to `DELETED`). `moderatePost` (HIDDEN) does **not** release.
4. **Reshares** of a post with a social video show it like any embedded video (hydrated by the client).
5. **Tests:** contract tests for the new rules; real-PG tests: social video of another user → `404`; second live post with the same social video → `409 VIDEO_IN_USE`; delete → exactly one `social.post.video_released` outbox row; hide → none; `video.ready` with `purpose: SOCIAL` updates the projection; event payloads validate against the schemas in `contracts/events`.

Push, open the PR with the Handoff Report, report when CI is green.
