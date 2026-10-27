# Antigravity 2 — SOC-1b: grants, stream subject, image routes and rollout (ADR-049)

Read **ADR-049** (the SOC-1b addendum) and tag `images` in `contracts/openapi/upload.v1.yaml`. Work in `deploy/` and workflows. Apply to production only after merge.

## Task
1. **Grants** (`deploy/k8s/data/scripts/grants.sql` and the compose/systest equivalents):
   - `auth_svc`: `USAGE ON SCHEMA media` + `SELECT ON media.ready_images` only;
   - `social_svc` keeps `SELECT ON auth.public_profiles`. Migration 000029 replaces the view with `CREATE OR REPLACE`, so grants survive. Verify after migrating.
2. **NATS:** add subject `media.>` to the `VIDEO` stream in every environment (compose, systest, k8s/gpu-01 bootstrap). The transcoder's image consumer is a new durable that the architect's code creates; check the stream config change is idempotent.
3. **Raw bucket CORS** for the single `PUT`: allow `PUT` from the site origins with headers `Content-Type` and `Content-Length`. The existing multipart CORS likely already covers it; verify on R2.
4. **Public image path:** `MEDIA_BASE_URL/i/{owner}/{id}/image.webp` and `thumb.webp` must be served like avatars today, publicly and cached on the edge (immutable keys: `Cache-Control: public, max-age=31536000, immutable`). Make sure the media gate does not require a signature for the `i/` prefix.
5. **Rollout, in order:**
   1. migration `000029`;
   2. grants;
   3. stream subject;
   4. the architect's upload-svc and transcoder releases;
   5. auth-svc, then social-svc;
   6. web.
6. Report on #47: digests from CI logs, `readyz`, synthetic 8/8, plus one image uploaded end to end on a test account. Post sizes in and out, never the user's photos.
