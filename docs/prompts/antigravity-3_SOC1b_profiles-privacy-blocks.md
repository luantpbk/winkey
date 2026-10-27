# Antigravity 3 — SOC-1b: profile fields (auth-svc), private accounts, blocks and mutes (social-svc)

Read `AGENTS.md`, **ADR-049** (the SOC-1b addendum), then:
- `contracts/openapi/auth.v1.yaml`: `updateMe` (the SOC-1b paragraph), `UpdateMeRequest`, `User`, `getUserByHandle`, `UserProfile`, `ProfileLink`;
- `contracts/openapi/social.v1.yaml`:
  - the `subscriptions` and `relationships` tag descriptions;
  - `subscribe`, `unsubscribe`, `createComment` (the block rule);
  - `listFollowers`, `listFollowing`, `getRelationship`, `listFollowRequests`, `decideFollowRequest`;
  - blocks and mutes;
  - `NotificationKind`.

Migration `000029_profiles_privacy_images` is merged (do not write migrations): `auth.users` profile columns, `auth.public_profiles` (new columns), `social.follow_requests`, `social.blocks`, `social.mutes`, notification kinds and `notifications_refs`, `media.ready_images`.

Work in `services/auth` and `services/social`. Make **two PRs**: auth-svc first, then social-svc. Branches `agent/ag3/soc1b-...` from `origin/main`. Can run in parallel with your SOC-1a work, but keep the PRs separate.

## auth-svc
1. **`updateMe`:**
   - `bio`: trimmed; empty → NULL.
   - `links`: validate with the WHATWG URL parser:
     - `https:` only, no username or password, host required;
     - ≤ 200 chars; labels trimmed, 1–30 chars;
     - otherwise `400 LINK_INVALID`.
   - `is_private`.
   - `avatar_image_id` / `banner_image_id`:
     - `SELECT image_key FROM media.ready_images WHERE id = $1 AND owner_id = $caller AND purpose = 'AVATAR'|'BANNER'`; no row → `400 IMAGE_INVALID`;
     - store the key in `avatar_key` / `banner_key`; `null` clears it.
   - The existing 10 changes per hour rate limit covers every field.
2. **`User`** (getMe and updateMe) and **`getUserByHandle`** (`UserProfile`) return `bio`, `links`, `banner_url` (`MEDIA_BASE_URL` + key, like `avatar_url`), `is_private`, `created_at`.
3. `deleteMe` also clears `bio`, `links`, `banner_key` and `is_private`.
4. Tests:
   - each field;
   - `LINK_INVALID` cases: `http://`, `javascript:`, credentials, > 200 chars;
   - `IMAGE_INVALID`: another user's image, wrong purpose, not READY (insert `media.images` rows directly in the test DB);
   - clearing with `null`;
   - the profile appears in `getUserByHandle`.

## social-svc
1. **Block helper.** `isBlockedEitherWay(a, b)` and an SQL fragment that excludes users in a block relation with the caller. Use it everywhere the contract says.
2. **`subscribe`:**
   - block either way → `404`;
   - private target (`auth.public_profiles.is_private`) not followed yet → insert into `follow_requests` (idempotent) and create a `FOLLOW_REQUEST` notification (`ON CONFLICT DO NOTHING`, as today); return `requested: true`; no event;
   - 200 pending outgoing requests → `409 LIMIT_REACHED`.
   - `getSubscription`, `subscribe` and `unsubscribe` always return `requested`.
   - `unsubscribe` also deletes the caller's pending request.
3. **`decideFollowRequest`.** One transaction:
   - `APPROVE`: delete the request, insert the subscription (reuse the normal subscribe path: outbox event + `NEW_SUBSCRIBER`), plus `FOLLOW_REQUEST_APPROVED` to the requester;
   - `REJECT`: delete the request.
   - Not found → `404`.
4. **`listFollowRequests`:** `pending_count` = all pending requests to the caller (excluding blocked users).
5. **`listFollowers` / `listFollowing`:**
   - keyset on `(created_at, user id)`; use the new indexes;
   - private owner: allowed only for the owner and approved followers, else `403 PRIVATE_ACCOUNT`;
   - exclude inactive profiles and block relations with the caller.
6. **`getRelationship`:** never expose `blocked_by`.
7. **`blockUser`.** One transaction:
   - delete subscriptions both ways (each removed subscription writes `social.subscription.changed`, so video-svc's feed projection stays correct);
   - delete follow requests both ways;
   - insert the block;
   - limit 1000 → `409 LIMIT_REACHED`.
   - `unblockUser` deletes the block only.
8. **Mutes:** `muteUser`, `unmuteUser`, `listMyMutes`; limit 1000.
   - Rate limit block and mute changes: 60 per hour per user.
9. **Comments and notifications:**
   - `createComment` → `403 INTERACTION_BLOCKED` when the caller and the video owner, or the parent comment's author for a reply, are in a block relation;
   - `listComments` and the replies list hide comments whose author is in a block relation with the signed-in caller;
   - every notification insert skips block relations, and skips a muted actor for the muter (including `VIDEO_PUBLISHED` fan-out from `video.ready`).
10. README: endpoints, error codes, the block semantics.

Tests (integration, real Postgres, contract-checked):
- private follow request → approve → subscribed, with the event and both notifications;
- reject → can request again, no duplicate notification;
- unsubscribe cancels the request;
- follower lists: private → `403` for strangers, OK for the owner and followers, cursor paging;
- block:
  - removes both follows and emits events;
  - the blocked user's subscribe → `404`;
  - comment → `403`;
  - comments hidden both ways;
  - no notifications;
  - `getRelationship` does not leak `blocked_by`;
- mute stops notifications; limits; rate limit.
