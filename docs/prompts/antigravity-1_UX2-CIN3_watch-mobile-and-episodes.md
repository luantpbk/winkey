# Antigravity 1 — UX2 + CIN3: mobile watch page and episode list (ADR-045)

Read **ADR-045** first (it has the user's screenshot findings). Work only in `apps/web` and `e2e/`. Run `pnpm lint && pnpm format:check` before every push.

Two PRs:
1. **UX2:** the mobile player controls and the action row. Start now.
2. **CIN3:** automatic series context. Start once Antigravity 3's `listSeriesForVideo` is merged; until then, use MSW mocks.

## PR 1: UX2 (`agent/ag1/ux2-watch-mobile`)
- **Player controls below 640 px:**
  - Keep only play/pause, the compact time (`0:09 / 6:04`), settings and fullscreen.
  - Volume becomes a mute toggle (no slider).
  - Subtitles, audio and quality move into the settings menu as rows (the same components, rendered as a sheet).
  - Visible buttons are 36 px, and their hit area stays 44 px.
  - Nothing may be clipped at 360 px.
  - The subtitles button never has a solid red background; show the active state with the icon colour or an underline.
- **Action row** (Like, Share, Watch later, Save, Report, and Edit for the owner):
  - one horizontally scrollable row;
  - every chip the same height (40 px), icon and label on one line (`whitespace-nowrap`);
  - hidden scrollbar and a fade at the right edge;
  - Report may become an icon-only chip with an `aria-label`.
- **Channel row:** the subscribe button uses the normal size; it must not grow.
- **Tests:**
  - unit tests;
  - Playwright screenshots of `/watch/{id}` at 360×800, 390×844 and 768×1024, attached to the PR;
  - the e2e check that `scrollWidth <= clientWidth` on those viewports.

## PR 2: CIN3 (`agent/ag1/cin3-episodes`)
- In `watch-layout.tsx`, when there is no `?playlist=`:
  - call `GET /v1/series?video_id=` (social);
  - if `items[0]` exists, use its `playlist_id` exactly like a `?playlist=` link: `getSeriesEpisode`, the episode list, previous and next episode;
  - add `?playlist=` with `history.replaceState`, never a new history entry;
  - if there are no items or an error happens, keep today's related column. Never guess.
- **Episode list:**
  - the current episode is highlighted and scrolled into view;
  - each episode shows its number, thumbnail, title and duration;
  - "load more" uses the cursor;
  - on mobile it shows under the player and the action row, collapsible, with "Tập X / N" in the header.
- **Autoplay the next episode at the end:** a 5-second countdown overlay with "Huỷ"; it respects a `localStorage` opt-out.
- **Tests:**
  - unit tests with MSW for: no series → related column; series → list plus `replaceState`; next-episode countdown;
  - an e2e test: open an episode without `?playlist=` and see the episode list.
