# Winkey chat-svc (`@winkey/chat`)

End-to-end encrypted messaging service for the Winkey platform, managing public device keys, signed one-time keys, Olm to-device message routing, Megolm-encrypted conversations, message requests, and content-free realtime hints.

Part of **Task SOC-3a**, owned by **Antigravity 3**.

---

## Security Model & Privacy

- **Zero-Knowledge Server:** The server stores public device keys, one-time keys, ciphertext (Megolm messages ≤ 64 KiB, Olm to-device messages ≤ 16 KiB), and metadata (membership, titles, timestamps, sequence numbers).
- **No Decryption:** The server **never** sees plaintext or private keys.
- **Strict Privacy Logging:** Ciphertext, keys, and signatures are **never** logged. Pino loggers redact sensitive parameters and log only IDs, sizes, and operational counters.
- **Identity:** Trust comes exclusively from `X-User-Id` and `X-User-Roles` set by the API gateway (ADR-009). Every chat endpoint requires authentication (`401` otherwise).
- **Matrix-style vodozemac Cryptography:**
  - Every conversation (DIRECT or GROUP) encrypts each message once with the sender device's Megolm session.
  - Megolm session keys reach member devices via Olm-encrypted to-device messages using one-time keys claimed from `chat-svc`.
  - Ed25519 signatures over RFC 8785 canonical JSON are validated on device registration and one-time key upload (`400 INVALID_SIGNATURE` otherwise).

---

## Endpoints

### 1. Devices & Keys (`/v1/chat/devices`, `/v1/chat/keys`)

- `GET /v1/chat/devices`: The caller's active devices (newest first).
- `PUT /v1/chat/devices/:device_id`: Register a new device (`201`) or update display name / fallback key (`200`). Enforces advisory transaction lock per user, max 10 active devices, immutable keys (`409 DEVICE_KEYS_IMMUTABLE`), unique identity key (`409 IDENTITY_KEY_IN_USE`), and immutable device ID ownership (`409 DEVICE_ID_IN_USE`).
- `DELETE /v1/chat/devices/:device_id`: Remove own device (`204`). Deletes pending one-time keys and to-device messages; marks device as deleted.
- `POST /v1/chat/devices/:device_id/one-time-keys`: Upload signed one-time keys for own active device (max 100 stored keys).
- `POST /v1/chat/devices/query`: Query active device keys of up to 50 users (filters out deleted devices, blocked users, and non-active profiles).
- `POST /v1/chat/keys/claim`: Atomic claim of one one-time key per target device (`DELETE ... FOR UPDATE SKIP LOCKED`), fallback key when OTKs are exhausted. Excludes devices with block relations or deleted state.

### 2. To-Device Messaging (`/v1/chat/to-device`)

- `POST /v1/chat/to-device`: Send Olm-encrypted messages to target devices. Validates sender device ownership and recipient eligibility (caller's own active device OR shared active/requested conversation without block relations). Drops invalid recipients safely and lists them in `skipped_device_ids`.
- `GET /v1/chat/devices/:device_id/to-device`: Retrieve pending to-device messages for own device (`id > after`, limit + 1). Updates `last_seen_at` throttled to at most once per minute.
- `POST /v1/chat/devices/:device_id/to-device/ack`: Acknowledge and delete to-device messages (`id <= up_to`).

### 3. Conversations & Members (`/v1/chat/conversations`)

- `GET /v1/chat/conversations`: Keyset paginated conversations for caller (`state=ACTIVE` or `state=REQUESTED`), ordered by most recent activity (`coalesce(last_message_at, created_at) DESC, id DESC`). Includes unread message count capped at 99.
- `POST /v1/chat/conversations`: Create DIRECT or GROUP conversation.
  - DIRECT: Single peer. Deterministic `direct_key`. Re-activates conversation if caller previously LEFT.
  - GROUP: Requires title (1–80 chars), 1–49 member user IDs. Caller becomes OWNER.
  - State resolution: Member starts as `ACTIVE` if they follow the actor in `social.subscriptions`, otherwise `REQUESTED`.
  - Atomically writes `SYSTEM` message `conversation_created`.
- `GET /v1/chat/conversations/:conversation_id`: Get conversation details and active/requested members.
- `PATCH /v1/chat/conversations/:conversation_id`: Rename group (OWNER or ADMIN). Writes `SYSTEM` message `title_changed`.
- `POST /v1/chat/conversations/:conversation_id/members`: Add members to group. Validates 50-member limit, profile existence, and block relations. Writes `SYSTEM` message `member_added`.
- `DELETE /v1/chat/conversations/:conversation_id/members/:user_id`: Leave or remove member.
  - Self-leave: Sets `state = LEFT`, records `left_seq = last_seq`. When OWNER leaves a group, hands over ownership to the oldest ADMIN, else oldest ACTIVE member. Writes `member_left` and optionally `owner_changed`.
  - Remove member: OWNER or ADMIN removing a MEMBER. Sets `state = LEFT`, writes `member_removed`.
- `PATCH /v1/chat/conversations/:conversation_id/members/:user_id`: Update role (OWNER setting ADMIN/MEMBER on another user) or mute duration (caller setting `muted_until` on self).
- `POST /v1/chat/conversations/:conversation_id/accept`: Accept message request (`REQUESTED` → `ACTIVE`). Writes `SYSTEM` message `request_accepted`.
- `POST /v1/chat/conversations/:conversation_id/read`: Advance caller's read marker (`last_read_seq`). Clamped to `last_seq`.

### 4. Messages (`/v1/chat/conversations/:conversation_id/messages`)

- `POST /v1/chat/conversations/:conversation_id/messages`: Send Megolm-encrypted message.
  - Caller must be ACTIVE member and sender device must be caller's active device.
  - DIRECT conversation verifies peer is not LEFT and no block exists.
  - Idempotent via `(sender_id, client_msg_id)`.
  - Atomically locks conversation row, increments `last_seq`, records message, advances sender's `last_read_seq`.
  - Emits realtime hint `MESSAGE` to all ACTIVE and REQUESTED members.
- `GET /v1/chat/conversations/:conversation_id/messages`: Messages in `seq` order within caller's readable range `[joined_seq, left_seq ?? last_seq]`. Supports `after_seq`, `before_seq`, or newest mode.
- `DELETE /v1/chat/conversations/:conversation_id/messages/:seq`: Tombstone caller's own message (`ciphertext = NULL`, `deleted_at = now()`).

### 5. Attachments (`/v1/chat/conversations/:conversation_id/attachments`, SOC-3b)
- `POST …/attachments` reserves a `PENDING` attachment (caller `ACTIVE`, own device, 1 GiB live quota under a per-user
  advisory lock, 100/h) and returns a presigned `PUT` (15 min) signed for the exact `Content-Length` and
  `Content-Type: application/octet-stream`. Object key `c/{conversation_id}/{attachment_id}` in `winkey-chat`.
- `POST …/attachments/:id/complete` (uploader only) checks the object with `HEAD`: missing → `409 UPLOAD_INCOMPLETE`;
  wrong size → the object is deleted, then `409`. Idempotent.
- `sendMessage` with `attachment_ids` links them in the same transaction that assigns `seq`; any unavailable id
  rolls the send back (`409 ATTACHMENT_UNAVAILABLE`). Every message response carries `attachments` (one query per page).
- `POST …/attachments/:id/download` (uploader, or a member whose readable range includes the message; 600/min)
  returns a presigned `GET` (5 min); expired → `410 ATTACHMENT_EXPIRED`.
- Deleting a message expires its attachments, then deletes objects and rows after the commit; failures stay for the
  janitor, which also deletes expired attachments and attachments not sent within 24 h (hourly, Valkey lock,
  `DeleteObjects` ≤ 1 000 keys per call). The bucket lifecycle rule (30 days) is the backstop.

### 6. Key backup (`/v1/chat/key-backup`, SOC-3b)
- `PUT` creates version 1 (`201`); with `replace: true` bumps `version`, replaces `auth_data` and deletes every session
  (`200`); otherwise `409 BACKUP_EXISTS`. `auth_data` is opaque (an object ≤ 4 KiB). 10/day.
- `GET` returns the backup and `session_count` (30/h); `DELETE` removes it (sessions cascade).
- `PUT /sessions` (≤ 100 per call, 600 sessions/min, 50 000 max → `409 BACKUP_FULL`) keeps per session the key with the
  lowest `first_message_index` (a tie replaces); `GET /sessions` pages by `(conversation_id, session_id)`. Both need
  the current `version` (`409 BACKUP_VERSION_MISMATCH`).
- Never logged: presigned URLs, `auth_data`, session ciphertext (see `REDACT_PATHS`).

### 7. Realtime & Janitor
- **Realtime Hints:** Published on core NATS `rt.chat.user.<user_id>` with payload matching `chatHint` schema (`MESSAGE`, `TO_DEVICE`, `CONVERSATION`, `DEVICES`).
- **Purge Janitor:** Hourly background worker with distributed Valkey lock (`lock:chat:purge_to_device`) purging to-device rows older than 30 days in batches of 5,000.
- **Rate Limiting:** Valkey-backed sliding/fixed window rate limiters (60 msg/min, 2,000 to-device/min, 20 conv/hr, 20 req/day).

---

## Configuration

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Environment (`development`, `production`, `test`) | `development` |
| `HTTP_PORT` | HTTP server port | `8003` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://chat_svc:chat_svc@localhost:5432/winkey?sslmode=disable` |
| `NATS_URL` | NATS server URL | `nats://localhost:4222` |
| `VALKEY_URL` | Valkey / Redis URL | `redis://localhost:6379` |
| `MEDIA_BASE_URL` | Media CDN base URL | `https://media.winkey.vn` |
| `TRUST_PROXY_CIDRS` | Trusted CIDR ranges for proxy headers | `10.42.0.0/16,127.0.0.1` |
| `TO_DEVICE_PURGE_INTERVAL` | To-device purge job interval | `1h` |
| `CHAT_S3_ENDPOINT` | S3 endpoint chat-svc calls (HEAD, DELETE) for the attachment bucket. Unset → attachment endpoints answer `503` | — |
| `CHAT_S3_PUBLIC_ENDPOINT` | Origin browsers use; presigned PUT/GET URLs are signed for it | `CHAT_S3_ENDPOINT` |
| `CHAT_S3_REGION` | S3 region | `auto` |
| `CHAT_S3_BUCKET` | Private bucket for attachment ciphertext | `winkey-chat` |
| `CHAT_S3_ACCESS_KEY_ID` / `CHAT_S3_SECRET_ACCESS_KEY` | Bucket credentials (secret, never logged) | — |
| `CHAT_ATTACHMENT_TTL` | Attachment lifetime (`30d`, `12h`, …) | `30d` |
| `ATTACHMENT_JANITOR_INTERVAL` | How often expired and never-sent attachments are deleted | `1h` |
| `TURN_SECRET`              | coturn `static-auth-secret` (`use-auth-secret`) for `getTurnCredentials`; never logged. Unset → `503` | —                                                                    |
| `TURN_URLS`                | Comma-separated `turn:` / `turns:` / `stun:` URLs returned to clients                                 | —                                                                    |
| `TURN_TTL_SECONDS`         | Lifetime of TURN credentials (60–86400)                                                               | `600`                                                                |

---

## Development & Testing

```bash
# Typecheck
pnpm --dir services/chat run typecheck

# Unit, Contract, and Integration Tests
pnpm --dir services/chat test
```
