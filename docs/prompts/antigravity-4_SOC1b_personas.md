# Antigravity 4 — SOC-1b: system tests for profiles, privacy, blocks and images (ADR-049)

Read **ADR-049** (the SOC-1b addendum). Work in `systest/` only. Start when the auth, social, upload/transcoder and web SOC-1b PRs are merged. Systest stack only.

## Personas
1. **`profile-editor`:**
   - upload an avatar and a banner: use a fixture JPEG with EXIF GPS and orientation 6;
   - assert the served WebP:
     - is square, 400 px, for the avatar;
     - has no EXIF: fetch the bytes and check there is no `EXIF` chunk;
     - is rotated: dimensions match the rotated image;
   - set bio and links, then check `/@handle` shows them.
2. **`private-account`:**
   - A goes private;
   - B follows → "Đã yêu cầu"; A sees the request plus the notification and approves; B sees "Đang theo dõi" and the `FOLLOW_REQUEST_APPROVED` notification;
   - C (a stranger) gets the private message on A's follower list.
3. **`blocker`:**
   - A and B follow each other;
   - A blocks B: both follows gone;
   - B cannot follow A (the UI shows the account as unavailable);
   - B's comment on A's video → blocked message;
   - B's old comments are hidden from A;
   - unblock → no auto-refollow.
4. **`image-limits`:**
   - a 25 MiB file is rejected client-side;
   - an animated WebP → `FAILED` / `INVALID_INPUT`;
   - the 6th pending image → `429`.
