# Antigravity 2 — SOC-3b: chat attachment bucket and rollout

Read the SOC-3b addendum (2026-10-31) at the end of `docs/DECISIONS.md` and AG3's brief (env list). Work in
`deploy/` and `.github/workflows/*`. Apply to production only after the chat-svc PR is merged.

1. **Bucket `winkey-chat`** (R2, private, no public access, no custom domain):
   - lifecycle: delete objects 30 days after creation, and abort incomplete multipart uploads after 1 day;
   - CORS: allow `PUT` and `GET` from `https://winkey.vn` (and the systest/dev origins), headers `Content-Type`
     and `Content-Length`, expose `ETag`; no wildcard origin.
2. **Credentials:** an R2 API token scoped to `winkey-chat` only, with object read/write.
   - Put it in `chat-secrets` (`CHAT_S3_ACCESS_KEY_ID`, `CHAT_S3_SECRET_ACCESS_KEY`), entered on the host with
     `read -rs`. Never paste it anywhere.
   - Set `CHAT_S3_ENDPOINT`, `CHAT_S3_PUBLIC_ENDPOINT`, `CHAT_S3_REGION` and `CHAT_S3_BUCKET` in the chat-svc
     deployment, compose and systest (systest: a Garage bucket with the same lifecycle).
3. **CSP:** `CSP_CHAT_ORIGIN` for web only where the chat bucket's public endpoint differs from
   `CSP_UPLOAD_ORIGIN` (local Garage, systest). In production both are the R2 S3 endpoint, so leave it unset.
4. **Body limits:** chat-svc requests stay small (files go straight to R2). Keep the gateway body limit for
   `/v1/chat` as it is.
5. **storage-gc:** `winkey-chat` is not part of storage-gc (chat-svc's janitor and the lifecycle rule own it). Add
   it to the storage-gc exclusion list if storage-gc scans every bucket.
6. **Rollout:**
   - apply migration `000034` (it ships with the next migrate job);
   - deploy chat-svc and then web by CI digest;
   - check `/readyz` of chat-svc;
   - with two beta accounts, send an image and confirm the other side can view it;
   - confirm that the object key in R2 has no file name, and that a direct unsigned `GET` returns `403`.
   - Report on the PR without IPs, URLs or keys.
