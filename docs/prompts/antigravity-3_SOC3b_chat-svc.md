# Antigravity 3 — SOC-3b: chat-svc attachments and key backup

Read `AGENTS.md`, then the SOC-3b addendum (2026-10-31) at the end of `docs/DECISIONS.md`. Then read
`contracts/openapi/chat.v1.yaml` 1.1.0: the `info` description and the `attachments` and `key-backup` tags, plus
`SendMessageRequest.attachment_ids` and `Message.attachments`. Then read migration
`000034_chat_attachments_backup`, which is merged; do not write migrations.

Branch `agent/ag3/soc3b-chat-svc` from `origin/main`, in `services/chat` only. If the PR gets large, split it in
two: (1) attachments, (2) key backup. Each part must pass CI on its own. Do not merge your own PR.

**Never log** presigned URLs, ciphertext, `auth_data` or object keys. Log ids and sizes only.

## 1. S3 client
- Use `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` with `forcePathStyle: true`.
- New env, documented in `.env.example` and the README env table:
  - `CHAT_S3_ENDPOINT`, `CHAT_S3_PUBLIC_ENDPOINT` (the origin browsers use; presign with it), `CHAT_S3_REGION`;
  - `CHAT_S3_BUCKET` (`winkey-chat`), `CHAT_S3_ACCESS_KEY_ID`, `CHAT_S3_SECRET_ACCESS_KEY`;
  - `CHAT_ATTACHMENT_TTL` (default `30d`).
- `/readyz` does not call S3. The service must start without the S3 env, and the attachment endpoints then answer
  `503`.

## 2. Attachments
- `createAttachment`:
  - check that the caller is `ACTIVE` and that `sender_device_id` is theirs;
  - check the quota with one `SUM(size_bytes)` over the caller's non-expired rows (index `attachments_uploader`),
    under a per-user advisory lock;
  - insert a `PENDING` row with `expires_at = now() + TTL`;
  - presign a `PUT` (15 min) with `ContentLength = size_bytes` and `ContentType = application/octet-stream`, and
    return those two headers in `upload_headers`.
  - Rate limit: 100 per hour per user.
- `completeAttachment`:
  - uploader only (`403` otherwise);
  - `HeadObject`: if the object is missing → `409 UPLOAD_INCOMPLETE`; if the size is wrong → delete the object,
    then `409 UPLOAD_INCOMPLETE`;
  - set `UPLOADED` and `uploaded_at`. If it is already `UPLOADED`, return it (idempotent).
- `sendMessage` with `attachment_ids`, in the same transaction that assigns `seq`:
  - `UPDATE chat.attachments SET message_seq = $seq WHERE id = ANY($ids) AND conversation_id = $c AND uploader_id = $me AND state = 'UPLOADED' AND message_seq IS NULL AND expires_at > now() RETURNING id`;
  - if fewer rows come back than ids were sent → roll back and answer `409 ATTACHMENT_UNAVAILABLE`;
  - an idempotent retry (same `client_msg_id`) returns the stored message and ignores `attachment_ids`.
- `Message.attachments` on every message response (list, send, retry): load them with one query per page, never
  one query per message. `SYSTEM` and deleted messages get `[]`.
- `deleteMessage` deletes that message's attachment rows and their objects. Delete objects after the commit; a
  failed object delete is logged and left to the janitor.
- `downloadAttachment`:
  - the uploader, or a member whose readable range includes `message_seq` (an unlinked attachment is visible to
    its uploader only);
  - expired → `410 ATTACHMENT_EXPIRED`; otherwise presign a `GET` for 5 minutes;
  - rate limit 600 per minute per user.
- **Janitor** (the same pattern as the to-device purge: hourly, with a Valkey lock):
  - in batches, delete expired rows and unlinked rows older than 24 h;
  - delete their objects with `DeleteObjects` (up to 1 000 per call).
  - The bucket lifecycle rule (AG2) is the backstop.

## 3. Key backup
- `putKeyBackup`:
  - in one transaction, insert version 1 (`201`), or with `replace: true` bump `version`, update `auth_data`
    and delete every `key_backup_sessions` row of the user (`200`). Without `replace` → `409 BACKUP_EXISTS`;
  - validate that `auth_data` is an object of at most 4 KiB serialized (`400` otherwise);
  - rate limit 10 per day.
- `getKeyBackup`: the backup plus `session_count` (`count(*)`). Rate limit 30 per hour.
- `putKeyBackupSessions`:
  - `version` must equal the current one (`409 BACKUP_VERSION_MISMATCH`);
  - write one `INSERT … SELECT FROM unnest(...) ON CONFLICT (user_id, conversation_id, session_id) DO UPDATE … WHERE EXCLUDED.first_message_index <= key_backup_sessions.first_message_index`;
    the returned row count gives `stored`, and the rest is `kept`;
  - enforce at most 50 000 sessions (`409 BACKUP_FULL`); rate limit 600 sessions per minute.
- `listKeyBackupSessions`: keyset on `(conversation_id, session_id)` with an opaque cursor, and an optional
  `conversation_id` filter.
- `deleteKeyBackup`: delete the row; the sessions cascade.

## 4. Tests (real PostgreSQL in CI, `WINKEY_REQUIRE_DOCKER=1`; S3 via a MinIO testcontainer or an S3 mock)
- Attachments:
  - the full flow create → PUT → complete → send → list → download, plus wrong-size complete;
  - the quota, an attachment linked to two messages (the second → `409`), an attachment from another
    conversation, and an expired attachment;
  - a member who joined after the message gets `404` on download; deleting the message deletes the object;
  - the janitor removes unlinked rows after 24 h.
- Key backup: create, `409` without `replace`, replace drops sessions, a lower `first_message_index` wins, an equal
  one is replaced, version mismatch, and pagination.
- Contract tests for every new endpoint against `chat.v1.yaml`.
- A log-privacy test: no presigned URL, `auth_data` or ciphertext in the logs.

The PR description is the Handoff Report, with the real test output.
