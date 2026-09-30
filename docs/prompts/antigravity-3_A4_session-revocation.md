# Kickoff — Antigravity 3 · Task A4 (revoke access tokens immediately)

Starts after C4-a (#84, merged). ADR-019 and the updated `verify` description in auth.v1.yaml are on main.
No migration, no new endpoint.

````text
# ROLE
You are the Node product-services engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-a4 -b agent/ag3/a4-session-revocation origin/main
READ FIRST: docs/DECISIONS.md ADR-019 (and ADR-016), contracts/openapi/auth.v1.yaml (`verify` description),
services/auth (src/crypto/jwt.ts `sid` = refresh family id, `iat`; routes: verify, logout, refresh reuse
detection, me.ts changePassword/deleteMe, admin.ts setRoles/suspend; src/index.ts Valkey client).
You own: services/auth. Branch: agent/ag3/a4-session-revocation.

# TASK A4 — implement exactly
1. A small `revocation` module (one file + tests), using the existing Valkey client:
   - revokeSession(sid)      → SET auth:revoked:sid:{sid} 1 EX 960
   - revokeUser(userId, now) → SET auth:revoked:user:{userId} {unixSeconds(now)} EX 960
     (if a larger value is already there keep the larger one: a Lua script or SET … GET compare — never lower it)
   - isRevoked(sid, userId, iat) → ONE `MGET` of both keys with a 50 ms timeout;
     revoked when the sid key exists OR (user key exists AND iat <= its value).
     Valkey error/timeout/null client → return { revoked: false, checked: false } (fail-open).
2. Call sites — always AFTER the DB transaction committed; a Valkey write error is logged at warn
   (user id / sid only, never tokens) + metric auth_revocation_write_total{result="error"}, never fails the request:
   - logout → revokeSession(current sid);
   - refresh reuse detection (whole family revoked) → revokeSession(that sid);
   - changePassword (other devices signed out) → revokeSession(sid) for EVERY other revoked family;
   - adminSuspendUser, adminSetUserRoles (only when roles actually changed), deleteMe → revokeUser(user id).
     Unsuspend needs nothing.
3. verify: after the signature/claims check, isRevoked(sid, sub, iat): revoked → 401 (same problem body as an
   invalid token); not checked → allow + auth_verify_revocation_check_total{result="error"}; otherwise
   {result="ok"|"revoked"}. Anonymous requests (no Authorization) never touch Valkey.
4. README: the keys, TTLs, fail-open behaviour, metrics. .env.example unchanged unless you add a setting.

# DEFINITION OF DONE
- Unit: isRevoked matrix (no keys, sid key, user key with iat < = > cutoff, both), fail-open on error and on
  timeout (fake client that never answers → returns within ~50 ms), revokeUser never lowers the cutoff.
- Integration on real PostgreSQL 17 + Valkey (WINKEY_REQUIRE_DOCKER=1, 0 skipped):
  - login → verify 204 → logout → verify with the SAME access token 401;
  - admin suspends user → the user's still-valid access token gets 401 on verify immediately;
  - admin changes roles → old token 401 → refresh → new token 204 with the NEW X-User-Roles;
  - changePassword → the other device's access token 401, the current device's token still 204;
  - deleteMe → token 401; refresh reuse → the family's access token 401;
  - Valkey stopped (or client pointed at a closed port) → verify still 204 for a valid token and the error
    metric increments.
- `pnpm run lint && pnpm run typecheck && pnpm run test` green, CI green; Handoff Report with the real
  postgres-real output (N tests, 0 skipped).

# OUT OF SCOPE
realtime-gw open WebSockets (ADR-019 consequence), gateway changes, contracts, migrations.
````
