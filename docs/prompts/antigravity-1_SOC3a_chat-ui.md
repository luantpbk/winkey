# Antigravity 1 — SOC-3a: E2EE chat in the web app

Read `AGENTS.md`, **ADR-049** section 5 and the SOC-3 addendum (2026-10-30), your spike report `docs/spikes/SOC3-e2ee.md`, `contracts/openapi/chat.v1.yaml` (the `info` description is the protocol), and `chatHint` in `contracts/realtime`. Regenerate `packages/api-client` (add `chat`).

Work in `apps/web`, `packages/api-client`, `e2e/`. Branch `agent/ag1/soc3a-chat-ui` from `origin/main`. Start with MSW mocks that follow the contract exactly; switch to the real chat-svc when AG3's PR lands. Do not merge your own PR. Split into 2–3 PRs if needed: (1) crypto worker + device lifecycle; (2) conversations UI; (3) polish + E2E.

## 1. Crypto package (in `apps/web`, e.g. `src/lib/e2ee/`)
- Move the spike wrapper into the repo as a build step:
  - source crate under `apps/web/e2ee-wasm/`, with a pinned toolchain and `Cargo.lock`;
  - CI builds it with `wasm-pack build --target web --release`, or commit the built `pkg/` with a CI check that the committed artefact matches a fresh build. Ask AG2 which they prefer for the image build;
  - the error type stays Rust-native inside, so `cargo test` runs in CI.
- Run all crypto in **one dedicated Web Worker** (a typed `postMessage` RPC). The main thread never holds pickles or keys.
- **Storage:** IndexedDB database `winkey-e2ee`.
  - A non-extractable AES-GCM `CryptoKey` wraps a random 32-byte pickle key.
  - Store the account, Olm sessions (per peer device curve key), outbound Megolm sessions (per conversation), inbound Megolm sessions (per `session_id` and sender key), and the device-trust records.
  - Never use `localStorage` for any of it.
- **CSP:** add `'wasm-unsafe-eval'` to `script-src` in `buildCsp` (with a unit test). Never add `'unsafe-eval'`.

## 2. Device lifecycle
- **First use** of chat on a browser:
  - create the account; sign the device keys (canonical JSON from the contract); `putMyDevice` with `display_name` such as "Chrome trên Windows";
  - upload 50 one-time keys and a fallback key;
  - top up when `countOneTimeKeys` < 20.
- **Logout:** `deleteMyDevice`, then wipe the IndexedDB database.
- **Settings › Bảo mật › Thiết bị nhắn tin:** list own devices (`listMyDevices`), remove a device.

## 3. Sending and receiving
- **Before sending in a conversation**, make sure the outbound Megolm session is shared:
  - `queryDevices` for all members (`ACTIVE` + `REQUESTED`), including the caller's own other devices;
  - for devices without an Olm session, `claimKeys` → create Olm sessions;
  - send the Megolm session key in Olm to-device messages, batching ≤ 200 per call.
  - Rotate (new outbound session plus a re-share) after 100 messages, after 7 days, or on a `SYSTEM` member change or a `chat.hint` `DEVICES`.
- **Message plaintext:** JSON `{"type":"text","body":"…"}`, body ≤ 4 000 characters. Unknown types render "Tin nhắn không hỗ trợ".
- **Receiving:**
  - on `chat.hint` `TO_DEVICE`, and after every (re)connect: `listToDevice`, decrypt, store the inbound Megolm keys, then `ackToDevice`;
  - on `chat.hint` `MESSAGE`: `listMessages` after the last known `seq`, then decrypt;
  - a message whose key has not arrived yet shows "Đang chờ khoá giải mã…" and retries when to-device messages arrive.
- **Trust:**
  - per contact device, trust on first use;
  - a contact's new device, or a changed key for a known device id (should never happen; treat it as an attack), shows a warning banner in the conversation;
  - "Mã an toàn" dialog: 60 digits derived from both users' sorted device identity keys (SHA-512 → groups of 5 digits). Document the derivation in the code.

## 4. UI
- `/tin-nhan`: conversation list with tabs "Hộp thư" and "Lời mời" (`state=REQUESTED`), unread badges, a new chat button (pick a user / create a group with a title and up to 49 people).
- Conversation view:
  - text rendered as **text** only (never `dangerouslySetInnerHTML`);
  - sending state and retries via the same `client_msg_id`;
  - "delete for everyone" for own messages;
  - read marker via `markRead` when the view is visible;
  - group settings: rename, add, remove, leave, promote (per role); mute.
- Requests: "Chấp nhận" / "Từ chối"; the composer is disabled while `REQUESTED` (show why).
- Errors: `INTERACTION_BLOCKED`, `REQUEST_PENDING`, `CONVERSATION_CLOSED`, `TOO_MANY_MEMBERS`, `429`, each mapped to clear Vietnamese.
- Header: a message icon with the unread total (sum of `unread_count` across the first page).
- Works at 360 px; keyboard accessible.

## 5. Tests
- Unit (worker functions run in Node):
  - signature canonicalisation;
  - Olm and Megolm round trips with three devices;
  - Megolm rotation triggers;
  - safety number stability;
  - pickle wrap/unwrap with a wrong-key failure.
- Component: requests flow, composer disabled states, XSS strings render as text.
- **E2E with two browser contexts and the real stack** (or MSW for the UI-only parts):
  - A and B each register a device; A sends to B (who does not follow A) → request; B accepts and replies;
  - B adds a second device → A's next message decrypts on both;
  - a group of 3 where one member leaves → new messages are not decryptable by the leaver.
- Provide AG3 the signed-key fixtures for their signature tests (§2 of their brief).

Push, open the PR(s) with the Handoff Report (screenshots desktop + 360 px), and report when CI is green.
