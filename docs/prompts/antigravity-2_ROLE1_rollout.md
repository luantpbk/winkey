# Antigravity 2 — ROLE1 rollout: migration 000027, open registration, admin account (ADR-046)

Read `AGENTS.md` and **ADR-046**. Do not touch service code.

## Order (production)
1. **After the ROLE1 design PR merges:** apply migration `000027_creator_requests` with the usual migration job. Post the version before and after.
2. **When the auth-svc ROLE1 PR (Antigravity 3) is merged:** pin the auth image (digest from the CI log only) and deploy it. Then:
   - check that a new test account registers with `roles: ["viewer"]`, and delete it with `deleteMe` afterwards;
   - check that `GET /v1/admin/creator-requests` answers `403` for a viewer.
3. **Only after step 2:** set `REGISTRATION_MODE=open` for auth-svc (a deploy PR in `deploy/`). Keep `INVITE_CODES` in the Secret so invite mode can be turned back on. Check that registering without a code works.
   - Do not open registration before step 2: the old auth-svc still gives `creator` to every new account.
4. **The user's admin account:** run one transaction on edge-1 against the host PostgreSQL.
   - Read the email with `read -r`; never write it into shell history, git, issues or logs.
   - Statement: `UPDATE auth.users SET roles = ARRAY['viewer','creator','admin']::auth.role[] WHERE lower(email) = lower($1) AND status = 'ACTIVE' RETURNING id, roles`.
   - First run a `SELECT id, roles` to show the before state. If it is already `admin`, change nothing.
   - In #47, report only the id and the roles before and after.
   - The user signs out and in again.
5. **When the video-svc ROLE1 PR and the web ROLE1 PR are merged:** deploy them (digests from CI logs).
6. **Smoke test after everything is deployed** (use a throwaway account and delete it afterwards):
   - register → no Upload in the UI;
   - `POST /v1/uploads` → `403`;
   - send a creator request → the user approves it in Admin;
   - refresh → Upload is visible and an upload starts.
   - Synthetic checks stay green.

Post each step in #47 with real output.
