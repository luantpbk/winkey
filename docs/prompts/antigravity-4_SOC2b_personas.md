# Antigravity 4 — SOC-2b: video-post system tests

Read **ADR-049** (the SOC-2b addendum 2026-10-28) and the SOC-2b parts of `upload.v1.yaml`, `video.v1.yaml`, `social.v1.yaml`. Work in `systest/` and `loadtest/`. Branch `agent/ag4/soc2b-personas`. Start once the architect's upload/transcoder/video-svc PRs and AG3/AG1's PRs are merged (or run on their branches locally).

## Tasks
1. **S12 social video (API):**
   - a viewer (no `creator` role) uploads a 20 s clip with `purpose: SOCIAL` → READY with exactly the 720p and 360p renditions (or fewer for small sources), `UNLISTED`, raw object gone;
   - it never appears in `listVideos`, search, tag pages, trending, `listStudioVideos`;
   - a 200 s clip → `video.failed` code `TOO_LONG`; `size_bytes` > 300 MiB → `400 VIDEO_TOO_LARGE`;
   - post with it → `video_attached` reaches video-svc (`attached_at` set); a second post with the same video → `409 VIDEO_IN_USE`; another user's social video → `404`;
   - delete the post → the video becomes `DELETED` and its media is removed; hiding a post keeps the video;
   - `updateVideo` visibility on a social video → `409 SOCIAL_VIDEO_UNLISTED`.
   (The 48-hour "never attached" cleanup: test it with the janitor's age configured short in the systest stack.)
2. **Persona "social user":** add a video post on desktop and 360 px: upload progress, processing, inline playback muted, unmute on tap.
3. Report output sizes per minute of video (target about 10 MB/min) in the PR.

Report results in the PR's Handoff Report; report when CI is green.
