# Kickoff — Antigravity 1 · Task U4 (admin & moderation UI)

Starts after U2 (#77, merged). Backends are on main: A2 (#72: auth `/v1/admin/*`, social `/v1/reports`,
`/v1/moderation/*`), S4 (#71: `moderateVideo`), A3 (#80). ADR-016 explains who owns which action.

````text
# ROLE
You are the Frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u4 -b agent/ag1/u4-admin-ui origin/main
READ FIRST: docs/DECISIONS.md ADR-016; contracts/openapi/auth.v1.yaml (tag admin: adminListUsers, adminGetUser,
adminSetUserRoles, adminSuspendUser, adminUnsuspendUser, adminListAuditLog, error codes CANNOT_MODERATE_TARGET,
LAST_ADMIN, 409 DELETED), social.v1.yaml (createReport, listReports, resolveModerationCase, moderateComment,
ReportReason), video.v1.yaml (moderateVideo, `moderation` object); apps/web (auth context, api-client, U3 social
components, i18n messages vi/en).
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u4-admin-ui.

# TASK U4
1. Report button (every signed-in user) on videos and comments → dialog with ReportReason + optional note →
   createReport; handle 409 (already reported, open case) with a friendly message; hidden for own content.
2. /[locale]/admin — route guard on roles from the session (moderator or admin; others get 404 page, not a
   redirect loop). Never trust the UI guard for security: the backend enforces (ADR-009).
   a. Moderation queue (moderator+admin): listReports grouped by target (cursor paging), each case shows the
      target preview (video title/thumbnail or comment text), reasons with counts, reporters count; actions:
      hide/restore video (moderateVideo) or comment (moderateComment) with a required reason, THEN
      resolveModerationCase — two calls in that order (ADR-016: no saga); if the second fails, show a retry
      button for the resolution only.
   b. Users (moderator + admin, ADR-016): adminListUsers with search q (debounced 300 ms) and cursor paging;
      user detail: suspend (reason + optional until date/time, UTC shown in local time) / unsuspend — moderators
      only on viewer/creator accounts, admins also on moderators, nobody on admins or themselves; roles editor
      for admins only (viewer always on and disabled). Map CANNOT_MODERATE_TARGET, LAST_ADMIN and 409 to
      clear inline errors. Disable actions on yourself and on admins where the contract forbids them.
   c. Audit log (admin): adminListAuditLog with target_user_id filter, cursor paging.
3. Studio: show the `moderation` object on your own hidden videos ("Hidden by a moderator: <reason>").
4. i18n vi + en for every new string; accessible dialogs (focus trap, Esc, labels).

# DEFINITION OF DONE
- Unit/component tests (MSW handlers generated from the contract types): guard per role, every action happy path,
  each error code mapped, two-step moderate→resolve including the retry path, report 409.
- Playwright (MSW): a moderator hides a reported video and resolves the case; an admin changes roles and suspends.
- No new `any`; `pnpm run format:check && pnpm run lint:root && pnpm run lint && pnpm run typecheck &&
  pnpm run test && pnpm run build` at the root. Open the PR yourself; description = Handoff Report with output.

# OUT OF SCOPE
Backend changes; account settings page (next task, A3 endpoints); search page (later).
````
