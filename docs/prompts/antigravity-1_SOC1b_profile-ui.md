# Antigravity 1 — SOC-1b: profile page, avatar/banner upload, privacy, follow requests, block/mute (ADR-049)

Read **ADR-049** (the SOC-1b addendum) and the contracts:
- auth: `updateMe`, `UserProfile`;
- social: `subscriptions` and `relationships` tags plus their operations;
- upload: tag `images` — `createImageUpload`, `completeImageUpload`, `getImage`.

The api-client is regenerated. Work in `apps/web` only. Branch `agent/ag1/soc1b-profile-ui` from `origin/main`. Merge after the AG3 PRs and the architect's image pipeline; build against MSW mocks until then.

## Task
1. **Image upload helper** (`lib/media/upload-image.ts`):
   - pick a file, then crop in the browser: square for the avatar, 3:1 for the banner, using a small crop UI without heavy dependencies;
   - resize so the long edge is ≤ 2048 px (avatar ≤ 800 px) and encode to WebP with `canvas.toBlob('image/webp', 0.85)`, or JPEG when WebP encoding is unsupported. This saves bandwidth; the server still re-encodes;
   - `createImageUpload` → `PUT upload_url` with `upload_headers` and the exact size → `completeImageUpload`;
   - poll `getImage` every 1.5 s for up to 60 s;
   - show `FAILED` with a Vietnamese message.
   - Reject files > 20 MiB and non-image types before uploading.
2. **Edit profile** (settings, "Hồ sơ"):
   - display name, handle (existing);
   - bio with a 300-character counter;
   - up to 5 links (label + https URL);
   - avatar and banner, using the helper and then `updateMe` with `avatar_image_id` / `banner_image_id`;
   - remove avatar / banner;
   - "Tài khoản riêng tư" toggle with an explanation.
   - Map `LINK_INVALID` and `IMAGE_INVALID` to field errors.
3. **Profile page `/@handle`:**
   - banner, avatar, display name, handle, bio (plain text, links auto-detected only from the `links` list, `rel="nofollow noopener ugc"`), the links;
   - follower / following counts that open lists (`listFollowers` / `listFollowing`, infinite scroll); a private account shows a lock and "Tài khoản này là riêng tư" when the lists return `403`;
   - follow button states: "Theo dõi", "Đã yêu cầu" (cancel = `unsubscribe`), "Đang theo dõi", from `getSubscription.requested` and `getRelationship`.
4. **Follow requests:**
   - a "Yêu cầu theo dõi" page or section (`listFollowRequests`, badge with `pending_count`) with Approve / Reject;
   - notifications `FOLLOW_REQUEST` and `FOLLOW_REQUEST_APPROVED` in the bell, with Vietnamese texts.
5. **Block / mute:**
   - "…" menu on profiles and comments: "Chặn", "Tắt tiếng", "Báo cáo" (existing);
   - confirm dialog for block explaining the effects;
   - settings page lists blocked and muted users with Unblock / Unmute;
   - `INTERACTION_BLOCKED` on comment → message "Bạn không thể bình luận ở đây".
6. Render every user-provided text as text (no `dangerouslySetInnerHTML`).

## Tests
- crop + resize + upload flow (mock `fetch` and canvas), polling to READY and to FAILED;
- profile edit validation;
- follow button state machine (public / private / requested / following);
- block dialog calls `blockUser` and hides the follow button;
- lists show the private message on `403`.
