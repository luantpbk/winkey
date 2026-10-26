# Antigravity 1 — ROLE1: role-based UI, creator upgrade page, admin requests tab (ADR-046)

Read `AGENTS.md` and **ADR-046** (the role/feature table is the spec), then the contract `contracts/openapi/auth.v1.yaml`:
- `getMyCreatorRequest`, `createCreatorRequest`;
- `adminListCreatorRequests`, `adminDecideCreatorRequest`;
- the schemas `CreatorRequest*`, `AdminCreatorRequest*`.

Types are already generated in `packages/api-client`. Work in `apps/web`, adding MSW mocks for the new endpoints.

Branch: `agent/ag1/role1-role-based-ui` from `origin/main`. One PR; the description is the Handoff Report.

## Task
1. **One permission helper.** In `lib/auth`, expose `can.upload`, `can.studio`, `can.requestCreator` (signed in, without `creator`), `can.moderate` (moderator or admin) and `can.adminOnly` (admin). Every gate uses it; no ad-hoc `roles.includes` in components.
2. **Hide what the role lacks**, following the ADR-046 table:
   - Upload and Studio in the top bar, the sidebar, the mobile bottom tab bar (replace "Tải lên" with "Thư viện" for non-creators) and the account menu;
   - Edit and Subtitles on the watch page;
   - empty-state upload CTAs.
   - Anonymous users and viewers never see Upload or Studio. Admin and moderator entries are unchanged.
3. **Route guards** for `/upload` and `/studio/**`:
   - anonymous → `/login?next=…`;
   - signed in without `creator` → render the upgrade page in place (no error page, no flash of the creator UI).
   - While the session is loading, keep the placeholder approach of #442 (no CLS).
4. **"Trở thành nhà sáng tạo" page** (`/nang-cap`, also linked from the account menu when `can.requestCreator`):
   - No request yet: a short explanation and a form with `message` (10–1000 chars, counter) → `createCreatorRequest`.
   - `PENDING`: show the status and the send date. Poll `getMyCreatorRequest` every 30 s while the tab is visible.
   - `APPROVED` while the token lacks `creator`: call the auth context `refresh()` once, show a success toast, and offer links to Upload and Studio.
   - `REJECTED`: show the admin note and when a new request is possible (`REQUEST_COOLDOWN` detail).
   - Map `ALREADY_CREATOR`, `REQUEST_PENDING`, `REQUEST_COOLDOWN` and `429` to Vietnamese messages.
5. **Admin tab "Yêu cầu sáng tạo"** (admin only; moderators do not see it):
   - Status filter (Chờ duyệt / Đã duyệt / Đã từ chối) and a badge with `pending_count`.
   - Each row shows the user's avatar, name, handle, email and created date, the message and the age.
   - Actions: Duyệt (optional note), and Từ chối (note required, in a dialog).
   - After an action, remove the row optimistically and update the badge. `409 REQUEST_ALREADY_DECIDED` → refetch and show a toast.
   - In the Users tab, keep the role editor and add quick "Cấp / Thu hồi quyền sáng tạo" actions that use `adminSetUserRoles`. Warn that revoking signs the user out.
6. **Registration:**
   - Show the invite field only when the URL has `?invite=`.
   - Remove the "beta kín" wording.
   - After sign-up, the home page shows a one-time hint: "Muốn đăng video? Gửi yêu cầu trở thành nhà sáng tạo."
7. Handle `403 CREATOR_ROLE_REQUIRED` from video-svc and upload-svc anywhere it can surface (the token is stale): call `refresh()`, then show the upgrade page.

## Tests
- Unit tests:
  - the permission helper (every role combination);
  - nav and menu rendering for anonymous, viewer, creator, moderator and admin;
  - the route guard;
  - every upgrade-page state;
  - admin tab approve/reject and the 409 path.
- e2e (mock mode), screenshots at 390 and 1280 px:
  - viewer: no Upload; `/upload` shows the upgrade page; send a request;
  - admin: approve it;
  - viewer after refresh: sees Upload.

## Definition of Done
- Run `pnpm lint && pnpm format:check && pnpm --filter @winkey/web exec tsc --noEmit && pnpm --filter @winkey/web test` before every push. Unused imports have made several PRs red.
- `next build` passes.
