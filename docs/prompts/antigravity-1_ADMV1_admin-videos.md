# Antigravity 1 — ADMV1: admin Video tab and watch-page moderation actions (ADR-047)

Read `AGENTS.md` and **ADR-047**, then `contracts/openapi/video.v1.yaml`:
- `adminListVideos` (`GET /v1/studio/admin/videos`, schemas `AdminVideo` and `AdminVideoPage`);
- `moderateVideo` (`PUT /v1/videos/{id}/moderation`);
- `deleteVideo`.

Types are generated in `packages/api-client`. Work in `apps/web`, adding MSW mocks for `adminListVideos`.

Branch: `agent/ag1/admv1-admin-videos` from `origin/main`. One PR; the description is the Handoff Report.

## Task
1. **Admin tab "Video"** (moderator and admin; use the `can.moderate` permission):
   - search box (`q`, debounced, at least 2 characters);
   - filters: status, visibility, moderation state (Đang hiện / Đã ẩn);
   - "Tải thêm" button with `next_cursor`.
   - Each row shows:
     - thumbnail;
     - title, linked to `/watch/{id}`;
     - owner (`@handle`, or "Tài khoản đã khoá/xoá" when `owner_active` is false);
     - Vietnamese status, visibility and moderation badges;
     - created date.
   - Actions:
     - **Ẩn**: dialog with a required reason (1–500 chars) → `moderateVideo {state: HIDDEN, reason}`;
     - **Hiện lại**: → `{state: VISIBLE}`;
     - **Xoá**: dialog that warns the deletion is permanent and requires typing `XOÁ` → `deleteVideo`; remove the row on success.
   - Update the row optimistically. On error, roll back and show a toast with the problem `detail`.
2. **Watch page "⋯ Quản trị" menu**, shown only to moderators and admins:
   - Ẩn / Hiện lại, with the same reason dialog;
   - Xoá, with the same confirmation; on success, redirect to `/` with a toast.
   - A hidden video shows a "Video đang bị ẩn: <lý do>" banner to staff and to the owner.
3. Keep the existing touch-target, contrast and no-CLS rules (placeholders while loading).

## Tests
- Unit tests:
  - tab visibility for viewer, creator, moderator and admin;
  - search and filter query building;
  - cursor paging;
  - hide requires a reason;
  - delete requires typing `XOÁ`;
  - optimistic rollback on 403/404;
  - the watch-page menu appears only for staff.
- e2e (mock mode): admin finds a video by title → hides it → it shows as hidden → restores it → deletes another one.

## Definition of Done
- Run `pnpm lint && pnpm format:check && pnpm --filter @winkey/web exec tsc --noEmit && pnpm --filter @winkey/web test` before every push.
- `next build` passes.
