# Kickoff — Antigravity 3 · Task A2 (RBAC administration + reports and moderation queue)

Starts after C2 (#57, merged). Contract, migration 000006 and ADR-016 are on main.

````text
# ROLE
You are the Backend engineer (Node.js/TypeScript) on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-a2 -b agent/ag3/a2-moderation origin/main
READ FIRST: docs/DECISIONS.md ADR-016 (and ADR-007/008/009), db/migrations/000006_moderation.up.sql,
contracts/openapi/auth.v1.yaml (tag `admin`, the new 403 on `login`, `adminSuspendUser` description),
contracts/openapi/social.v1.yaml (tag `moderation`, the A2 notes in info.description),
contracts/events/README.md (`video.moderated`, consumer `social-videos`), contracts/events/video.moderated.schema.json.
You own: services/auth, services/social (+ shared TS packages). Branch: agent/ag3/a2-moderation.
One PR is fine; if it grows past ~1500 lines, split into A2a (auth) and A2b (social) PRs.

# TASK A2a — auth-svc (implement exactly)
- adminListUsers / adminGetUser / adminSetUserRoles / adminSuspendUser / adminUnsuspendUser / adminListAuditLog.
- Authorization from X-User-Roles only; the matrix in the `admin` tag description:
  moderator|admin read + suspend/unsuspend viewer/creator; admin only for roles, for (un)suspending a moderator,
  and for the audit log; nobody touches an admin or themselves (403 CANNOT_MODERATE_TARGET).
- Every change + its auth.audit_log row in ONE transaction; no-op changes write no row.
- Suspension: status SUSPENDED + reason + until, revoke every refresh-token family of the user in the same
  transaction. login → 403 ACCOUNT_SUSPENDED only after the password verified; Google callback redirects to
  /login?error=ACCOUNT_SUSPENDED without a cookie; refresh naturally 401 (families revoked).
  Expired temporary suspensions (suspended_until in the past): treat as ACTIVE at login and flip the row back
  (clear reason/until) in the same transaction, with an audit row action USER_UNSUSPENDED,
  actor_id = the target user, details {"expired": true}. Document it in the README.
- adminListUsers: q matches email/handle prefix (citext, index-friendly) OR display_name via pg_trgm
  (`%` operator / similarity); filters role/status; cursor on (created_at DESC, id DESC).
- Never log emails, tokens or suspension reasons at info level (ADR/AGENTS logging rule).

# TASK A2b — social-svc (implement exactly)
- createReport: target must exist and be visible to the reporter —
  VIDEO: social.videos row exists and not hidden; COMMENT: VISIBLE comment on a non-hidden video;
  USER: present in auth.public_profiles. Own content/self → 400. Repeat while OPEN → 200 with the existing
  report (use the partial unique index, INSERT … ON CONFLICT DO NOTHING + SELECT). Rate limit 20/h per user
  (same limiter as comments).
- listReports: cases grouped by (target_type, target_id) with open_count, reasons histogram,
  first_reported_at, the 5 latest reports (reporter from auth.public_profiles, null if gone);
  default status=OPEN ordered by oldest open report; opaque cursor.
- resolveModerationCase: one UPDATE of all OPEN reports of the target; 404 when none.
- Projection: add `video.moderated` to the durable `social-videos` (update its filter_subjects in place,
  do not create a second durable) → UPDATE social.videos SET hidden; unknown video → ack and skip;
  unknown version → skip + warn (events README).
- Hidden video: comment and like endpoints answer 404 for everyone except moderator/admin
  (read AND write). Existing rows stay.

# DEFINITION OF DONE
- Tests with REAL PostgreSQL 17 (testcontainers, WINKEY_REQUIRE_DOCKER=1 must fail, not skip) running all
  migrations: role matrix (table-driven: actor role × target role × action → status), self/admin protection,
  audit row written/not written, suspension revokes refresh families and blocks login, expired suspension
  auto-lifts, report dedup + visibility rules, case grouping + resolution, video.moderated projection hides
  and unhides (real NATS JetStream), hidden video → 404 on comments/like.
- Contract tests (ajv against the specs) for every new response schema, as in C1.
- typecheck covers tests/ (tsconfig.test.json, like #57), and before pushing, at the repo root:
  pnpm run format:check && pnpm run lint:root && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
- READMEs updated (env, role matrix, suspension behaviour). PR description = Handoff Report with real output.

# OUT OF SCOPE
- video-svc moderateVideo (Sonnet, S4). Web UI (Antigravity 1, U4). Gateway routes for /v1/admin, /v1/reports,
  /v1/moderation (Antigravity 2, I2 — mention them in your Handoff Report). Any contract/migration change
  (open a `contract-change` issue).
````
