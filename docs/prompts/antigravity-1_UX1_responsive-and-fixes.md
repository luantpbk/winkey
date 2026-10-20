# Antigravity 1 — UX1 phases 1–2: dead controls, responsive layout, TV mode, polish (ADR-044)

Read `AGENTS.md` and **ADR-044** first. Work only in `apps/web`, `e2e/` and `packages/api-client`. Your input is the `ux1` issues filed by Antigravity 4's audit. You can start step 1 before the audit lands.

Use **small PRs**, one theme each (branches `agent/ag1/ux1-<slug>`), so each one is reviewed and deployed quickly. Every PR lists the `ux1` issues it closes.

## 1. Known dead controls (start now)
- `components/cinema/cinema-detail-dialog.tsx`, "Thích" button: wire it to the existing like API (the same call and optimistic state as the watch page), with a pressed state and a login prompt for anonymous users.
- `/kham-pha` category chips: make them filter (selected state, `aria-pressed`, the URL `?cat=` kept on reload). Map each chip to an existing tag or category. Remove any chip that has no data behind it.
- Sidebar "Lịch sử" (`#history`): **hide it** until the architect ships HIST1 (`GET /v1/me/history`). Never leave a control that does nothing.
- Rule from now on: every button or link must do something visible, or be disabled with a reason in `title`/tooltip. Add an eslint rule or unit test that fails on `<button>` without `onClick`, `type="submit"` or `disabled`.

## 2. Responsive foundation
- Design tokens in Tailwind 4 `@theme`:
  - spacing scale;
  - fluid type (`clamp()`);
  - breakpoints adding `3xl: 1920px` and `4xl: 2560px`;
  - minimum touch target of 44 px.
- Layout per breakpoint:
  - **mobile:** bottom navigation, sidebar as a drawer, 1 column, player full width;
  - **tablet:** 2–3 columns, collapsible sidebar;
  - **desktop:** current layout, cleaned up;
  - **≥ 1920:** wider grids (5–6 columns), larger type, the content max-width raised so the page is not a narrow strip on big screens.
- No horizontal scroll on any page at 360 px. Images and thumbnails use `next/image` sizes per breakpoint.

## 3. TV mode (10-foot UI)
- Spatial navigation with the arrow keys: a small focus manager or a vetted library (pinned).
  - Rails and grids move focus with ←/→/↑/↓.
  - Enter activates.
  - Esc/Backspace goes back or closes dialogs.
- Always-visible focus ring (high contrast, 3 px or more) and focused cards scale up slightly.
- Nothing may require hover: hover-only menus and controls also open on focus or Enter.
- Player on TV:
  - large controls;
  - ←/→ seek 10 s, ↑/↓ volume, Enter play/pause;
  - the audio and subtitle menus usable with the keyboard.
- Detect TV by size plus `(hover: none)` / `(pointer: coarse)` or the user agent (Tizen, webOS, Android TV), and allow a manual toggle in settings.

## 4. Tests
- Add Playwright projects to `e2e/playwright.config.ts` for `mobile` (390×844), `tablet-p` (768×1024), `desktop` (1920×1080) and `tv-1080` (keyboard only).
- Each key flow (home → watch → play, search, login, studio edit) runs on all of them.
- Add unit tests for the focus manager and the new controls.

## 5. Polish (phase 2)
Work through the P1 and P2 issues by page. After each larger PR, ask Antigravity 4 to re-run `ui-audit` and link the new counts in the PR.

## Definition of Done (whole UX1)
- `ui-audit` on 8 viewports reports:
  - 0 dead controls;
  - 0 horizontal overflow;
  - 0 axe serious/critical;
  - touch targets ≥ 44 px;
  - TV reaches every main flow with the keyboard;
  - CLS < 0.1.
- The user checks on a real phone, tablet and TV.
