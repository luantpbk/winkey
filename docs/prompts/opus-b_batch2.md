# Opus B — batch 2: people, friends, chat that feels complete, attachments, 1-1 calls

Read `docs/prompts/opus-b_onboarding.md` again for the rules. They still hold: own branch per task, separate
`contract-change` PRs, no merging your own PRs, Vietnamese UI, mobile, WCAG AA and zero CSP violations. Then read
the ADR-049 addenda **SOC-3b** and **SOC-4a** (2026-10-31) at the end of `docs/DECISIONS.md`, and
`contracts/openapi/chat.v1.yaml` 1.2.0.

Work through the list in order. Each item is **its own PR**; keep each PR reviewable (split big ones). You do not
need to wait for a PR to merge before starting the next item unless it depends on it; branch the next one from
`origin/main`, or from your previous branch when it truly depends on it, and say so in the PR.

Merged for you already: the SOC-6a contract and migration (#530, `searchPeople`, migration 000035), and the SOC-3b and SOC-4a
designs. Antigravity 2 adds the gateway route `/v1/people` → social-svc, the `winkey-chat` bucket and coturn. Ask
the user to forward those requests if they are not done when you need them; mock them in the meantime.

## B1 — SOC-6a: people search (implementation)
- social-svc `searchPeople` exactly as the contract says: folded matching, block exclusion, ranking, the
  100-result cap, the cursor and the rate limit. Add a real-PostgreSQL integration test with the ranking and
  diacritics cases.
- Web `<UserPicker>`: debounced (250 ms), avatars, handle + name, keyboard (↑↓ Enter Esc), multi-select chips,
  empty and error states.
  - Use it in the new-chat dialog (DIRECT: one person; GROUP: up to 49) and **delete every UUID text field**.
  - Add a "Nhắn tin" button on profiles that opens the existing DIRECT conversation or creates it.
  - Add @mention autocomplete in the post and comment composers.

## B2 — SOC-6b: friends (contract draft, then implementation)
As in the onboarding brief: relationship, friends, friend requests and dismiss, the "accepted your friend
request" notification, a "Bạn bè" page with tabs (friends, requests, find people), the profile button states, and
friends first in the new-chat dialog. Put the contract and migration (`social.friend_request_dismissals`) in a
`contract-change` PR first.

## B3 — Chat that feels complete (web, plus chat-svc where needed)
Fix what makes chat feel unfinished. Go through it yourself as two users first, and cover at least:
- **conversation list:** last message preview (decrypted locally), time, unread badge; search
  conversations by name; requests tab with counts;
- **conversation view:**
  - sender avatars and names in groups; day separators; "đã xem" from `last_read_seq`; delivery states
    (sending / sent / failed + retry);
  - infinite scroll up, and a jump to the newest message;
  - emoji picker; reply-to (quoted message inside the encrypted event); edit is out of scope;
- **group management:** rename, add or remove members with the user picker, leave, owner and admin actions;
- **trust UI:** a clear "new device" warning, a safety number screen reachable from the header, and a friendly
  explanation when a message cannot be decrypted yet (waiting for keys) instead of an error;
- **notifications:** a per-conversation mute, and the unread total in the top navigation bar.

The decrypted preview and reply data live only on the device. Never send plaintext to any server.

## B4 — SOC-3b: encrypted attachments and key backup
Implement `docs/prompts/antigravity-3_SOC3b_chat-svc.md` (chat-svc, first PR) and
`docs/prompts/antigravity-1_SOC3b_chat-ui.md` (web, second PR) exactly. Each brief is now yours.

## B5 — SOC-4a: 1-1 voice and video calls
- **chat-svc:** `getTurnCredentials`.
  - Env: `TURN_SECRET`, `TURN_URLS` (comma-separated), `TURN_TTL_SECONDS` (default 600).
  - Answer `503` without the env. Never log the credential. Rate limit 30/hour per user.
  - Unit test the HMAC against a known vector.
- **Web** (Web Worker crypto stays as it is; calls run on the page):
  - a call button (voice and video) in the DIRECT conversation header, enabled only when both members are
    `ACTIVE`;
  - signaling exactly as in the SOC-4a addendum:
    - `m.call.invite` / `m.call.answer` / `m.call.reject` / `m.call.hangup` as Megolm messages;
    - candidates and `m.call.select_answer` as to-device messages;
    - the 45 s ring timeout; `busy` when already in a call.
  - Put the event shapes in one module with `v: 1` and validate every incoming event (ignore unknown or malformed
    ones).
  - `RTCPeerConnection` with `iceServers` from `getTurnCredentials` (fetch fresh credentials per call). Use
    trickle ICE through to-device messages, and an ICE restart when the network changes.
  - UI:
    - an incoming-call overlay on every page while the tab is open (ringtone, accept/decline);
    - an in-call screen with mute, camera on/off, switch audio ↔ video, device pickers, a timer and hang up;
    - picture-in-picture of your own camera; a mobile layout; a "reconnecting…" state.
  - Ask for microphone and camera only when the user starts or accepts a call. Handle a denied permission
    gracefully.
  - Chat history shows "Cuộc gọi thoại · 3 phút", "Cuộc gọi video nhỡ" and similar, rendered from the call events.
- **Tests:**
  - unit tests for the event validation and the call state machine (ringing, connecting, connected, ended,
    missed, busy, rejected);
  - Playwright with two browser contexts and fake media
    (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`): a voice call connects, both sides see
    the connected state, hang up writes the history line, and a missed call after the timeout.
  - Zero CSP violations.

## Report
After each PR is green: the PR link, what changed (screenshots, and for B5 a short screen recording or a sequence
of screenshots), the real test output, and anything you need from the architect or Antigravity 2.
