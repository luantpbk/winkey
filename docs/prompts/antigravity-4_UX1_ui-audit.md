# Antigravity 4 — UX1 phase 0: automated UI audit on every screen size (ADR-044)

Read `AGENTS.md`, `systest/README.md` and **ADR-044** first. Work only in `systest/` (new folder `systest/ui-audit/`). Do not change `apps/web`; report bugs as issues instead.

Branch: `agent/ag4/ux1-ui-audit` from `origin/main`. One PR; the description is the Handoff Report.

## Goal
A repeatable audit that tells Antigravity 1 exactly what is broken or ugly, on which page, at which screen size, with a screenshot.

## Rules
- Run **only against the local systest stack** (`./systest/run.sh --reset`, seeded data and personas). Never against production: clicking can like, subscribe, comment or delete.
- Keep a **denylist** of destructive or irreversible controls that are never clicked: delete, logout, report, block, suspend, upload submit, password change, and anything with `data-danger`. Match by accessible name and `data-testid`, and list them in the report as "skipped".
- Tools: Playwright (already in the repo) and `@axe-core/playwright`, pinned.

## Viewports (Playwright projects)

| Project | Size | Notes |
|---|---|---|
| `mobile-s` | 360×800 | `hasTouch`, `isMobile` |
| `mobile` | 390×844 | `hasTouch`, `isMobile` |
| `tablet-p` | 768×1024 | `hasTouch` |
| `tablet-l` | 1024×768 | `hasTouch` |
| `laptop` | 1366×768 | |
| `desktop` | 1920×1080 | |
| `tv-720` | 1280×720 | keyboard only, no mouse |
| `tv-1080` | 1920×1080, `deviceScaleFactor: 2` | keyboard only |

## Pages × personas
- **Anonymous:** `/`, `/kham-pha`, `/trending`, `/the-loai/<seed>`, `/tag/<seed>`, `/watch/<seed>`, `/embed/<seed>`, `/c/<seed>`, `/playlist/<seed>`, search results, `/login`, `/register`, `/forgot-password`, the cinema detail dialog, and the legal pages.
- **Member:** the above, plus `/thu-vien`, `/feed/subscriptions`, `/settings`, `/notifications`, the comment box and the like/subscribe controls (on seed data you can reset).
- **Creator:** `/studio` (list, edit, subtitles, audio tracks, series) and `/upload`, with the form open but not submitted.
- **Moderator/admin:** `/admin`.

## Checks per page × viewport
1. **Dead controls.**
   - For every visible, enabled interactive element (`button`, `a[href]`, `[role=button|tab|menuitem|option|switch|checkbox]`, `summary`, `select`, `input[type=checkbox|radio]`) not on the denylist, record the URL, a DOM signature, `aria-expanded`/`aria-pressed`/`aria-selected`/`checked`, the network request count, dialogs and downloads.
   - Click it (on TV projects, focus it and press Enter instead), wait for network idle or 1 s, and compare.
   - Report "dead" when nothing changed. Reload the page before the next element so state does not leak.
   - Cap 80 elements per page and report the cap if hit.
2. **Horizontal overflow:** `document.scrollingElement.scrollWidth > clientWidth`. Name the widest offending element.
3. **Touch targets < 44×44 CSS px** on touch projects (allow inline text links inside paragraphs).
4. **axe:** violations with impact `serious` or `critical`.
5. **Clipped or overlapping text:** elements whose `scrollWidth > clientWidth` without `text-overflow: ellipsis`, and fixed or sticky elements covering content. Attach a screenshot with boxes drawn.
6. **TV only:**
   - Starting from the page, Tab and the arrow keys must reach the header, the main rails or grid, the player controls and the dialogs.
   - Focus must always be visible (compare the outline/box-shadow of the focused element with the unfocused one).
   - Esc must close dialogs.
   - Record unreachable elements.
7. **Performance:** CLS and LCP per page, via `PerformanceObserver`.

## Output
- `systest/ui-audit/report/<date>/report.md`: a summary table (page × viewport, counts per check), then one section per finding with severity, viewport, persona, selector or accessible name, the expected behaviour, and a screenshot path. Keep the screenshots out of git (artifact folder in `.gitignore`); attach the important ones to the issues.
- Severity:
  - **P0:** feature does not work, dead control or unreachable on TV;
  - **P1:** overflow, overlap, axe serious, touch target too small on main actions;
  - **P2:** polish.
- Open **one GitHub issue per finding group** (same root cause, e.g. "cinema dialog Like button does nothing"), labelled `ux1` plus `P0`/`P1`/`P2`, assigned to Antigravity 1. Put backend gaps (no API exists) in issues labelled `ux1` + `backend`, for the architect.
- `./systest/run.sh --ui-audit` runs the suite and exits non-zero when P0 > 0, so that CI can run it later.

## Already known (confirm, then file)
- The cinema detail dialog "Thích" button has no handler.
- The `/kham-pha` category chips have no handler.
- The sidebar "Lịch sử" links to `#history`; there is no watch-history page or API (backend).

## Definition of Done
- The PR contains the suite, the `run.sh` flag and the README section.
- Post the first full report summary (counts per page × viewport) to #47, with links to the issues you opened.
