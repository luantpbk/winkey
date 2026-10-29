# Antigravity 2 — CSP1: env and rollout

Read the CSP1 addendum (2026-10-29) at the end of `docs/DECISIONS.md`. Work in `deploy/`. Apply to production only after the web PR is merged.

1. **Env for web** in every environment (k8s, compose, systest):
   - `CSP_MEDIA_ORIGIN`: the origin of the media URLs that the APIs return (production `https://media.winkey.vn`; local, the Garage web endpoint origin);
   - `CSP_UPLOAD_ORIGIN`: the origin of `S3_PUBLIC_ENDPOINT` of upload-svc, where the browser PUTs parts.
   - These must be origins only (scheme, host and port), with no path or trailing slash.
2. **Ingress:** make sure nothing in front of web overwrites or adds a `Content-Security-Policy` header. Check Traefik middlewares and any Cloudflare transform rules. `/api/csp-report` must reach web (it is not under `/v1`).
3. **Rollout (phase 1, Report-Only):**
   - deploy the web image by its CI digest (from the `containerimage.digest` log line);
   - check with `curl -sI https://winkey.vn/` that both headers are present: the old `Content-Security-Policy` and the new `Content-Security-Policy-Report-Only` with a nonce that changes per request;
   - after 24 h, post on #47 a summary of the `csp-report` log lines grouped by `effective_directive` and `blocked_uri` origin, with counts. Include no IPs and no full URLs.
4. **Phase 2** (enforce) is a separate web PR; deploy it the same way and re-run the synthetic and persona checks.
