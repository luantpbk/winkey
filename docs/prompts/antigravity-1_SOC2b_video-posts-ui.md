# Antigravity 1 — SOC-2b: video posts (web)

Read `AGENTS.md`, **ADR-049** (the SOC-2b addendum 2026-10-28), `contracts/openapi/upload.v1.yaml` (`createUpload` description, `purpose`), `common.yaml` `VideoPurpose`, `video.v1.yaml` (`Video.purpose`, the `studio` tag) and the `posts` tag in `social.v1.yaml`. Regenerate `packages/api-client`.

Work in `apps/web`, `packages/api-client`, `e2e/`. Branch `agent/ag1/soc2b-video-posts` from `origin/main`.

## Tasks
1. **Composer:** a "Video" attachment (exclusive with images, embedded film and reshare):
   - read duration and size in the browser (`<video>` metadata) before uploading; refuse > 180 s or > 300 MiB with a clear message;
   - `createUpload` with `purpose: SOCIAL` (title: the first 100 characters of the body, or "Video bài đăng"), multipart upload with progress (reuse the existing uploader), then follow processing (`getUpload` / realtime progress) until `READY`;
   - show "Đang xử lý video…" while processing; enable "Đăng" only when READY; `video.failed` with `TOO_LONG` → explain.
   - Post with `video_id`; map `409 VIDEO_IN_USE` to a clear message.
2. **Post card:** hydrate `video_id` with `batchGetVideos` (already done for films). When `purpose === 'SOCIAL'`, play it **inline** with the existing HLS player: muted, `playsInline`, autoplay when ≥ 50 % visible (IntersectionObserver) and pause when it leaves, never autoplay with `prefers-reduced-motion`, tap to unmute; poster = thumbnail; keep the aspect ratio (vertical videos stay vertical, max height 80vh). `FILM` stays a card linking to the watch page.
3. **Studio:** do not show social videos (the API already leaves them out; check no client-side list mixes them in).
4. **Tests:** composer limits (duration, size), the processing → READY → post flow with MSW, inline player autoplay/pause logic and reduced motion, `FILM` vs `SOCIAL` rendering. E2E on the local stack: post a short video and see it play in the follower's feed.

Push, open the PR with the Handoff Report (screenshots desktop + 360 px), report when CI and sims are green.
