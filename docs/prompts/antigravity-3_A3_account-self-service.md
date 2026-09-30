# Kickoff — Antigravity 3 · Task A3 (account self-service in auth-svc)

Starts after A2 (#72, merged). The contract (`updateMe`, `changePassword`, `deleteMe`, `User.has_password` in
auth.v1.yaml) is on main. No migration: every column already exists in 000002/000006.

````text
# ROLE
You are the Node product-services engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-a3 -b agent/ag3/a3-account origin/main
READ FIRST: contracts/openapi/auth.v1.yaml (PATCH/DELETE /v1/auth/me, PUT /v1/auth/me/password, schemas
UpdateMeRequest, ChangePasswordRequest, DeleteMeRequest, User.has_password), db/migrations/000002_auth.up.sql
(users, oauth_identities, refresh_tokens, public_profiles), services/auth (register/login/refresh/logout routes,
passwords, rate limiter, registerArrayParsers, tests/integration/postgres-real.test.ts from A2).
You own: services/auth. Branch: agent/ag3/a3-account.

# TASK A3 — implement exactly the contract
1. `has_password` (= password_hash IS NOT NULL) on getMe and updateMe responses. Never expose the hash.
2. updateMe: validate with the schema (at least one field). Handle uniqueness is case-insensitive (citext):
   map the unique violation (23505 on users_handle_key) to 409 HANDLE_TAKEN, do not pre-check (race). Same
   value again → 200 without a write. Rate limit 10/hour per user id.
3. changePassword:
   - has password: verify current_password (argon2id, constant time) → 403 INVALID_CREDENTIALS on mismatch;
   - OAuth-only: current_password present → 400; absent → set the first password;
   - hash new_password with the same argon2id params as register;
   - in the SAME transaction revoke every refresh family of the user except the family of the request's
     `wk_rt` cookie (if any); rate limit like login (per user id and per IP).
4. deleteMe (one transaction, `SELECT … FOR UPDATE` on the user):
   - confirm_handle must match (case-insensitive) → else 400 CONFIRMATION_MISMATCH; password required and
     verified when has_password → else 403 INVALID_CREDENTIALS;
   - last admin: same advisory lock + count as adminSetUserRoles → 409 LAST_ADMIN;
   - scrub exactly as the contract says (email deleted+<id>@invalid.winkey.vn, handle d_<28 hex>,
     display_name "Deleted user", NULLs), status DELETED, DELETE oauth_identities, revoke all refresh tokens;
   - clear the `wk_rt` cookie with the same attributes used to set it; 204.
5. Logs: user id and operation only — never email, handle, passwords or tokens.

# DEFINITION OF DONE
- Unit tests (mock DB) for validation and every error code.
- Real PostgreSQL 17 tests in postgres-real.test.ts (WINKEY_REQUIRE_DOCKER=1 in CI):
  - handle change visible in auth.public_profiles; 409 HANDLE_TAKEN on a case-variant of another handle;
  - changePassword: old password fails and new one works on login; the other device's refresh → 401, this
    device's refresh → 200; OAuth-only user (insert an oauth_identities row, password_hash NULL) sets a first
    password;
  - deleteMe: row scrubbed exactly as specified, oauth_identities gone, refresh → 401, login with old
    email → 401, a NEW register with the old email and old handle → 201, last admin → 409;
  - contract validation of every new response (tests/contracts/openapi.test.ts).
- `pnpm run lint && pnpm run typecheck && pnpm run test` at the repo root green; CI green.
- README of services/auth updated. PR description = Handoff Report with the real postgres-real output
  (show the suite ran: N tests, 0 skipped).

# OUT OF SCOPE
- Email verification, password-reset email (needs an email provider decision), avatars (needs an upload flow),
  web settings page (Antigravity 1, later). Any contract or migration change → `contract-change` issue.
````
