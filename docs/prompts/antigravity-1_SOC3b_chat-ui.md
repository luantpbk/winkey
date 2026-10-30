# Antigravity 1 — SOC-3b: encrypted attachments and key backup (web)

Read `AGENTS.md`, then the SOC-3b addendum (2026-10-31) at the end of `docs/DECISIONS.md`, and
`contracts/openapi/chat.v1.yaml` 1.1.0 (`attachments` and `key-backup` tags). Work in `apps/web`, `e2e/` and
`packages/api-client`. Branch `agent/ag1/soc3b-chat-ui`. You can build against mocks before chat-svc lands, but
merge after AG3's PR. Do not merge your own PR.

All crypto runs in the existing E2EE Web Worker or through WebCrypto. Never put keys, plaintext or passphrases in
`localStorage`, in logs or in error reports.

## 1. Attachments
- **Prepare**, before encrypting:
  - images: decode, scale so the long edge is at most 1600 px, encode WebP at about 0.8 quality, and strip
    metadata. Make a thumbnail of at most 8 KiB (WebP, long edge about 64 px);
  - other files: keep as they are. Refuse files over 25 MiB with a clear message (after compression for images).
- **Encrypt** with AES-256-GCM: a random 32-byte key and a 12-byte IV per file, then take the SHA-256 of the
  ciphertext.
- **Upload:**
  - `createAttachment` → `PUT` to `upload_url` with exactly `upload_headers` → `completeAttachment`;
  - show progress; let the user cancel (abort the `PUT`; the server cleans up the row after 24 h);
  - send with `attachment_ids`.
  - The Megolm plaintext event carries, for each file: `{id, key, iv, sha256, mime, name, size, width?, height?, thumb?}`.
    Define this shape in one place with a version field.
- **Display:**
  - thumbnail first (decrypted from the event);
  - on view or download: `downloadAttachment` → `fetch` → check SHA-256 (mismatch → error, never display) →
    decrypt → `URL.createObjectURL`; revoke it on unmount;
  - images and video inline, other files as a download chip with name and size;
  - expired (`410`) → "Tệp đã hết hạn".
- **CSP:** in `buildCsp`, add `CSP_CHAT_ORIGIN` to `connect-src` when set (same validation as the other origins),
  with a unit test.

## 2. Key backup
- **Settings → Bảo mật → Sao lưu tin nhắn:**
  - turn on: offer a generated 5-word passphrase (recommended; the EFF short wordlist bundled with the
    app), or let the user choose one (at least 12 characters and zxcvbn score ≥ 3). Make the user confirm they
    saved it;
  - derive with Argon2id (m = 64 MiB, t = 3, p = 1, 16-byte salt) in the Worker, using an audited WASM Argon2
    (record the package, version and size in the PR; it must load under the current CSP);
  - wrap a random 32-byte backup key with AES-256-GCM, add `key_check`, and send `putKeyBackup` in the
    `auth_data` shape from the contract.
- **Uploading keys:** after the backup is unlocked on a device, export and encrypt each new inbound Megolm session
  with the backup key and upload it (batches of up to 100, retry with backoff). On first enable, upload every
  session the device already has.
- **New device:** when a backup exists and this device has none of its keys, show "Khôi phục lịch sử".
  - Ask for the passphrase; a wrong passphrase is detected via `key_check` with a clear error.
  - Page through `listKeyBackupSessions`, decrypt, import, then re-decrypt messages that failed before.
  - Keep the unlocked backup key in the Worker, wrapped with the non-extractable WebCrypto key you already use
    for the vodozemac pickle.
- **Change passphrase or reset:** `replace: true`, then re-upload the local sessions. Warn clearly that a reset
  after a forgotten passphrase loses history that only lived in the old backup.
- **Turn off:** `deleteKeyBackup`.

## 3. Tests
- Unit tests:
  - attachment encrypt/decrypt round trip, and that a SHA-256 mismatch is refused;
  - image resize stays at or under 1600 px, and the thumbnail at or under 8 KiB;
  - the Argon2id parameters, wrap/unwrap, and a wrong passphrase;
  - backup upload batching, and the `first_message_index` handling in import.
- E2E (two browsers, against a real or mocked chat-svc), in enforce-mode CSP with zero violations:
  - send an image and a PDF; the other side views and downloads them;
  - enable backup, log in on a fresh browser profile, restore, and read the old messages.

The PR description is the Handoff Report, with screenshots of the attachment and backup screens.
