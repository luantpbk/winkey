# Antigravity 2 — SOC-2b: NATS permissions, consumer and rollout (ADR-049)

Read **ADR-049** (the SOC-2b addendum 2026-10-28) and `contracts/events/social.post.video_attached.schema.json` / `social.post.video_released.schema.json`. Work in `deploy/` and workflows. Apply to production only after merge.

## Task
1. **NATS permissions** (`deploy/k8s/data/secrets.sh`, both blocks, and the compose/systest equivalents if they use auth):
   - `social`: publish `social.post.video_attached`, `social.post.video_released`;
   - `video`: subscribe to both, plus `$JS.ACK.SOCIAL.video-social-posts.>` for its new durable `video-social-posts` on stream `SOCIAL` (the architect's video-svc creates the durable);
   - nothing else changes. Add `verify.sh` checks: `social` publishes `social.post.video_attached`; `video` cannot publish it.
2. **Stream:** `SOCIAL` already captures `social.>`; verify, no change expected.
3. **Rollout, in order:**
   1. migration `000032_social_video`;
   2. NATS permissions (update secret, SIGHUP reload, `verify.sh`);
   3. the architect's video-svc, upload-svc and transcoder releases (transcoder on gpu-01: ask the user to run `sudo systemctl restart winkey-transcoder`);
   4. social-svc (AG3);
   5. web (AG1).
4. Report: digests from CI logs, `readyz`, `verify.sh` output (no secrets), and one short video post created end to end on a test account (size in and out, never the video itself).
