# Kickoff — Antigravity 1 · Task U7 (player: subtitles, storyboard previews, signed-URL refresh; studio subtitle upload)

Starts after U6 (#115, merged). Everything it needs is on main: `Playback.subtitles` + `putSubtitle` /
`deleteSubtitle` (V5b, ADR-018), `Playback.storyboard_url` (V5a), `Playback.expires_at` for signed URLs (SEC1,
ADR-017). No backend or contract change.

````text
# ROLE
You are the frontend engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag1-u7 -b agent/ag1/u7-player-subtitles origin/main
READ FIRST: docs/DECISIONS.md ADR-017 (signed URLs, 6 h TTL), ADR-018 (subtitles; the "Hệ quả" paragraph: cue text is
user content → render ONLY through the browser text track / hls.js, never innerHTML); contracts/openapi/video.v1.yaml
(Playback, SubtitleTrack, PutSubtitleRequest, putSubtitle/deleteSubtitle + their error codes);
apps/web/src/components/video/video-player.tsx (hls.js), quality-menu.tsx, the watch page and the studio video page.
You own: apps/web, e2e/, packages/api-client. Branch: agent/ag1/u7-player-subtitles.
First: `pnpm --filter @winkey/api-client run generate`.

# TASK U7 — build
1. Subtitles in the player: one `<track kind="subtitles" srclang={lang} label={label} src={url}>` per
   `playback.subtitles[]` (crossOrigin="anonymous" on the <video> — media is on media.winkey.vn). A CC menu next to
   the quality menu: Off + one entry per track; default Off; remember the last choice per browser
   (localStorage `winkey.subtitle_lang`, wrapped in try/catch) and pre-select it when a track with that lang exists.
   Keyboard: `c` toggles captions. Works with hls.js AND native HLS (Safari).
2. Storyboard seek previews: when `storyboard_url` is non-null, fetch the .vtt once (lazy: on first hover/seek-bar
   focus), parse cues (`start --> end` + `sprite.jpg#xywh=x,y,w,h`, sprite URL RELATIVE to the .vtt URL — resolve with
   `new URL(rel, storyboardUrl)` so signed prefixes are kept), and show the thumbnail + timestamp above the seek bar
   on hover/drag (and on touch drag). Parser = pure function with unit tests (hours optional, bad lines skipped).
   No storyboard → plain time tooltip, no request.
3. Signed-URL refresh: when `playback.expires_at` is present, refetch the video (`GET /v1/videos/{id}`) ~5 minutes
   before it expires (and on a 403/410 from a media request, once), then swap `hls_url` keeping the current time and
   play state (hls.loadSource + seek back; native: set src + currentTime), and replace the subtitle track URLs and the
   storyboard URL. Timer cleared on unmount (useSafeTimeout / effect cleanup). No refresh when expires_at is absent.
4. Studio: on the owner's video page a "Phụ đề" section — list tracks (lang, label, updated_at), upload a .vtt
   (FileReader → text; client-side checks: ≤ 512 KiB, starts with "WEBVTT" — the server remains the authority),
   lang select (common list vi, en, en-US, ja, ko, zh + free BCP-47 input matching the contract pattern), label;
   PUT → 201/200; delete with confirm → 204. Map SUBTITLE_TOO_LARGE, INVALID_WEBVTT (show `detail`, it has the line
   number), TOO_MANY_SUBTITLES, 409 FAILED video, 403/404. Invalidate the video query after changes.
5. i18n vi + en; MSW handlers (tracks, storyboard vtt + a sprite, signed playback with a short expires_at, every
   subtitle error code).

# DEFINITION OF DONE
- Vitest: storyboard parser table; CC menu renders tracks + persists choice; refresh timer fires before expires_at
  and swaps the source preserving currentTime (fake timers), cleared on unmount; studio upload happy path + each
  error code; no innerHTML anywhere in the new code (grep in the PR description).
- Playwright: watch page with subtitles on → a cue is visible; seek-bar hover shows a storyboard thumbnail.
- `pnpm --filter @winkey/web run lint && typecheck && test && build`, root `pnpm run lint && pnpm run format:check`,
  CI green; new test files run 10× in a row (paste the count). Handoff Report with real outputs + screenshots
  (player with CC menu, storyboard hover, studio subtitles section; vi, light + dark).

# OUT OF SCOPE
Auto-captions (V5c), backend/contract changes (→ `contract-change` issue), DASH, player analytics.
````
