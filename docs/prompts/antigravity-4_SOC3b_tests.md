# Antigravity 4 — SOC-3b: system tests for attachments and key backup

Read the SOC-3b addendum (2026-10-31) at the end of `docs/DECISIONS.md` and `contracts/openapi/chat.v1.yaml`
1.1.0. Work in `systest/` and `loadtest/`. Branch `agent/ag4/soc3b-tests`, after AG3's and AG1's PRs are merged.

1. **S14 API suite** (extend `systest/suite/chat.mjs` or add `chat-attachments.mjs`):
   - create → PUT → complete → send with `attachment_ids` → the other member lists the message with
     `attachments` → download → the bytes equal what was uploaded;
   - `PUT` with a different size fails at R2 or at `completeAttachment` (`409 UPLOAD_INCOMPLETE`);
   - a member added after the message gets `404` on download; a non-member gets `404`;
   - reusing an attachment id in a second message → `409 ATTACHMENT_UNAVAILABLE`;
   - deleting the message makes the download `404`;
   - an unsigned `GET` on the bucket is refused;
   - key backup: create, `409` without `replace`, upload sessions, a lower `first_message_index` wins, replace
     drops sessions, and version mismatch.
2. **Persona** (`systest/personas/chatter.spec.ts`): send an image and a file, view and download them on the other
   side, enable backup, restore on a fresh context, and read old messages. Fail on any CSP violation.
3. **Load** (`loadtest/`): 20 virtual users sending 1 MiB attachments for 5 minutes. Record the p95 of
   `createAttachment` and `completeAttachment` (target under 100 ms server time) and the R2 PUT time separately.
   Run on production only in the 02:00–03:30 ICT window or with a dated approval from the user.
