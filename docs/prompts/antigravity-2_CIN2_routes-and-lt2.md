# Kickoff — Antigravity 2 · CIN2 routes, CIN2 rollout, LT2 v2 night

Design: ADR-034 (addendum of 2026-10-10) and ADR-035.

````text
# ROLE
You are Antigravity 2 (platform) on Winkey. You own deploy/, workflows and root tooling. The usual security rules
apply (no secrets in chat or git, digests from CI logs only, no sudo on gpu-01).

# PART A — routes now (branch agent/ag2/cin2-routes)
- Traefik IngressRoute: send `PathPrefix(/v1/cinema)` and `PathPrefix(/v1/series)` on winkey.vn / www to social-svc,
  with the same middlewares as `/v1/playlists`: strip user headers, optional forwardAuth, rate limit.
- Migration 000019 is already in deploy/k8s/data (architect PR). Apply it on production with the normal migration
  job. Check that `schema_migrations` = 19 and that `\d social.playlists` shows `is_series`.
- Verify: `curl https://winkey.vn/v1/cinema/catalog` returns 404 from social-svc (route reached; the endpoint arrives
  with CIN2-social), not 404 from the web app.

# PART B — CIN2 rollout (after the architect merges CIN2-social, then CIN2-web)
Pin each digest from the CI log of its merge commit and roll out social first, then web. Verify:
- catalog 200 with a valid JSON shape;
- a test PUBLIC playlist marked "Bộ phim" appears in "Phim bộ", then delete it;
- the 4 legacy sites return 200.

# PART C — LT2 v2 night (after the architect merges LT2 v2; window 02:00–03:30 ICT, from 2026-10-12)
- Keep loadgen-01 on standby as before. Give Antigravity 4 SSH over the tailnet. The watchdog env
  (EDGE_METRICS_URL, ERROR_RATE_SOURCE) points at VictoriaMetrics over the tailnet.
- The same night, after the run: `tailscale logout`, the user terminates the VM AND its boot volume, and you post the
  non-secret proof on #47.
````
