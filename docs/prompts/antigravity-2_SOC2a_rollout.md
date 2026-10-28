# Antigravity 2 — SOC-2a: grants, gateway routes and rollout (ADR-049)

Read **ADR-049** (the SOC-2 addendum 2026-10-28) and the `info` description plus the `posts` tag in `contracts/openapi/social.v1.yaml`. Work in `deploy/` and workflows. Apply to production only after merge.

## Task
1. **Grants** (`deploy/k8s/data/scripts/grants.sql` and the compose/systest equivalents), guarded like the SOC-1b ones (the objects exist only after migration 000031):
   - `social_svc`: `USAGE ON SCHEMA media` + `SELECT ON media.ready_images` only (never `media.images`);
   - `media_svc` (the transcoder worker role that `storage-gc` uses): `USAGE ON SCHEMA social` + `SELECT ON social.post_media` only.
   - `social_svc` already has CRUD on new `social.*` tables through default privileges; verify on `social.posts`.
   - Add negative checks to `verify.sh`: `social_svc` cannot read `media.images`; `media_svc` cannot read `social.posts`.
2. **Gateway (Traefik, every environment):** route to social-svc: `PathPrefix(/v1/posts)`, `PathPrefix(/v1/post-comments)`, `PathPrefix(/v1/feed)`, `PathPrefix(/v1/hashtags)`, and `/v1/channels/{id}/posts` (add `posts` to the existing channels regex that already sends `followers|following|relationship|playlists` to social-svc). Make sure none of them is captured by a video-svc prefix.
3. **Rate limits / body size:** `createPost` bodies are small JSON; keep the default limits. No new public buckets.
4. **Rollout, in order:**
   1. migration `000031_posts_feeds`;
   2. grants (re-run the postgres setup job **after** the migration), then `verify.sh`;
   3. gateway routes;
   4. social-svc (AG3's release);
   5. web (AG1's release);
   6. the architect's transcoder release with the `storage-gc` POST-image rule (when it lands; `-apply` only with architect-chosen categories).
5. Report on #47: digests from CI logs, `readyz`, synthetic checks, `verify.sh` output (no secrets), and one post with an image created end to end on a test account.
