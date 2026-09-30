# Kickoff — Antigravity 3 · Task A5 (realtime-gw closes sockets of revoked users)

Starts after FIX1 (#98, merged). ADR-019 (addendum A5) is on main. Close code `4401` is already reserved in
contracts/realtime/README.md. No contract or migration change.

````text
# ROLE
You are the Node product-services engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree: git worktree add ../winkey-ag3-a5 -b agent/ag3/a5-realtime-revocation origin/main
READ FIRST: docs/DECISIONS.md ADR-019 incl. the A5 addendum; contracts/realtime/README.md (close codes, 4401);
services/auth/src/revocation/revocation.ts (key format); services/realtime (ticket store, connection registry).
You own: services/realtime (and packages/* if you extract a shared helper). Branch: agent/ag3/a5-realtime-revocation.

# TASK A5
1. Record on each AUTHENTICATED connection: userId and authenticatedAt (Unix seconds when the ticket was consumed).
   Anonymous connections are never checked.
2. A sweeper every REVOCATION_SWEEP_MS (default 30000): collect the distinct user ids of this instance's
   authenticated connections; ONE MGET of auth:revoked:user:{id} per sweep, chunked by 500 ids; for each
   connection with a cutoff and authenticatedAt <= cutoff → close(4401, 'session revoked'). Metric
   realtime_revoked_closes_total; Valkey error → skip this sweep, metric realtime_revocation_sweep_errors_total,
   warn at most once per minute. Never log ticket values.
3. A new ticket issued AFTER the cutoff connects normally (a user whose roles changed reconnects with new roles).
4. README: the behaviour, the setting, the metrics, and that logout of a single session does not close sockets
   (tickets carry no sid, ADR-019 addendum).

# DEFINITION OF DONE
- Unit: sweeper decisions (no key, cutoff before/after authenticatedAt, anonymous ignored, chunking), fail-open.
- Integration with real Valkey + the gateway (WINKEY_REQUIRE_DOCKER=1, 0 skipped): user connects → auth-svc style
  cutoff key written → socket closed with 4401 within one sweep; a second user's socket stays open; a fresh ticket
  after the cutoff connects and stays open; Valkey stopped → sockets stay open and the error metric increments.
- lint, typecheck, test green, CI green; Handoff Report with real output.
OUT OF SCOPE: auth-svc changes, per-session (sid) closing, contract changes.
````
