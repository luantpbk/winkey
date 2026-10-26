# Antigravity 3 — ROLE1: viewer-only sign-up and creator requests in auth-svc (ADR-046)

Read `AGENTS.md` and **ADR-046**, then the contract `contracts/openapi/auth.v1.yaml`:
- `register` (the ROLE1 roles paragraph);
- `getMyCreatorRequest`, `createCreatorRequest`;
- `adminListCreatorRequests`, `adminDecideCreatorRequest`;
- the schemas `CreatorRequest*`, `AdminCreatorRequest*`.

The table is `auth.creator_requests` (migration `000027`, already merged; do not write migrations). Work only in `services/auth`.

Branch: `agent/ag3/role1-creator-requests` from `origin/main`. One PR; the description is the Handoff Report.

## Task
1. **Default roles.** `register.ts` and the Google sign-up in `oauth.ts` create new accounts with the roles from config `SIGNUP_ROLES`:
   - only `viewer` (the default) or `viewer,creator` are accepted; any other value makes the service fail to start;
   - log the value once at boot;
   - document it in the README env table and in `.env.example`.
   Today's code always uses `['viewer','creator']`. Existing accounts are untouched. The architect already sets `SIGNUP_ROLES=viewer,creator` for the compose and systest stacks, so the seeds keep uploading.
2. **`GET /v1/auth/me/creator-request`.** The latest request of the caller (`created_at DESC, id DESC`); none → `404`.
3. **`POST /v1/auth/me/creator-request`.** `message` is trimmed, then 10–1000 chars (zod; `400 VALIDATION_ERROR`).
   - Return `409` in this order:
     - the caller already has `creator` → `ALREADY_CREATOR`;
     - a `PENDING` request exists → `REQUEST_PENDING`. Also map the `creator_requests_one_pending` unique violation to this code, so a race cannot produce a 500;
     - the latest request is `REJECTED` and `decided_at` is less than 24 h ago → `REQUEST_COOLDOWN`. The `detail` gives the time a new request is possible.
   - Rate limit: 5 per user per day with the existing Valkey limiter → `429`.
   - Return `201` with the request.
   - Log the request id and user id, **never `message`**.
4. **`GET /v1/admin/creator-requests`** (admin only; a moderator gets `403`).
   - `status` defaults to `PENDING`.
     - `PENDING` is ordered `created_at ASC, id ASC`.
     - `APPROVED` and `REJECTED` are ordered `decided_at DESC, id DESC`.
   - Use opaque cursors like the other admin lists.
   - Each item carries `user`, an `AdminUser` built exactly as `adminGetUser` builds it (reuse it), and `decided_by` as a `PublicProfile` or `null`.
   - `pending_count` is the total number of `PENDING` requests, whatever `status` was asked for.
5. **`POST /v1/admin/creator-requests/{id}/decision`** (admin only). Run it in one transaction, with `SELECT … FOR UPDATE` on the request.
   - An unknown id → `404`. The request is not `PENDING` → `409 REQUEST_ALREADY_DECIDED`. The request belongs to the caller → `403 CANNOT_MODERATE_TARGET`.
   - `REJECT`: `note` is required (`400`). Set `status`, `decision_note`, `decided_by` and `decided_at`. No audit row; roles are untouched.
   - `APPROVE`:
     - the user is not `ACTIVE` → `409 USER_NOT_ACTIVE` and nothing changes;
     - otherwise add `creator` to `roles` if it is missing, and mark the request `APPROVED`;
     - write one `USER_ROLES_CHANGED` audit row with `{from, to, creator_request_id}`, only if the roles changed.
     - **Do not revoke sessions** (unlike `adminSetUserRoles`); the next `refresh` reads the new roles.
6. README: document the new endpoints and the error codes.

## Tests (integration, real Postgres, contract-checked like the other admin routes)
- Register and the Google sign-up give `['viewer']`.
- Create, then `REQUEST_PENDING`. Already a creator → `ALREADY_CREATOR`. Rejected less than 24 h ago → `REQUEST_COOLDOWN`, and more than 24 h ago is allowed (control the clock). Rate limit → `429`.
- Admin list:
  - ordering for each status;
  - cursor paging;
  - `pending_count`;
  - a moderator → `403`, a viewer → `403`.
- Approve:
  - roles gain `creator`;
  - exactly one audit row with `creator_request_id`;
  - no revocation: the existing refresh token still works, and the refreshed access token carries `creator`.
- Approve when the user already has `creator`: the request becomes `APPROVED`, with no audit row.
- Approve a suspended user → `409 USER_NOT_ACTIVE` and nothing changes.
- Reject without a note → `400`. Reject with a note → stored. Deciding twice → `409`. Two concurrent decisions → exactly one wins.
- Deciding your own request → `403`.

## Definition of Done
- Lint, typecheck and tests are green, locally and in CI.
- Paste real `curl` output in the PR: register → `roles: ["viewer"]`, create a request, admin list, approve, then `refresh` → `roles` include `creator`.
