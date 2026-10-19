# Antigravity 1 — SEO4: videos in Google video results (ADR-043)

Read `AGENTS.md`, ADR-036, ADR-040 and **ADR-043** first. Work only in `apps/web` (plus `e2e/` if needed). No contract or migration changes.

Branch: `agent/ag1/seo4-video-rich-results` from `origin/main`. One PR; the description is the Handoff Report.

## Problem (verified in code on main)
- `src/lib/seo/sitemap.ts`: `<video:player_loc>` is the watch URL, the same as `<loc>`. Google's video sitemap spec forbids that, so every `<video:video>` entry is ignored.
- `src/lib/seo/video-schema.ts`: `embedUrl` is the watch page and there is no `contentUrl`.
- `watch/[id]/page.tsx` metadata: `openGraph.videos` is the watch URL.
- There is no embeddable player page.

## Tasks
1. **`/embed/[id]` page.**
   - Minimal page: the existing `VideoPlayer` filling the viewport, a small "Winkey" link to `/watch/{id}` (target `_blank`), and nothing else (no header, footer, comments or related videos).
   - `PUBLIC` videos only. Not found, `UNLISTED` or `PRIVATE` → 404.
   - Metadata: `alternates.canonical` = `https://winkey.vn/watch/{id}`, title = video title. Do **not** add `noindex`.
   - Allow framing on this path only: `Content-Security-Policy: frame-ancestors *` (and no `X-Frame-Options`). Every other path keeps its current headers.
   - Check that middleware/i18n does not redirect `/embed/{id}` in a way that breaks iframes. If a locale prefix is added, the canonical player URL must still answer 200 without a redirect chain.
   - Not disallowed in `robots.ts`.
2. **`buildVideoObjectSchema`:**
   - `embedUrl` = `https://winkey.vn/embed/{id}`;
   - `contentUrl` = `video.playback.hls_url` (only when set and the video is `PUBLIC`);
   - `publisher` = `{ "@type": "Organization", "name": "Winkey", "logo": { "@type": "ImageObject", "url": "https://winkey.vn/logo.png" } }`.

   Keep everything else. Update the unit tests.
3. **Video sitemap:** `<video:player_loc>` = `https://winkey.vn/embed/{id}`. Test that it differs from `<loc>` for every entry.
4. **Watch page metadata:**
   - `openGraph.videos` = `[{ url: embedUrl, secureUrl: embedUrl, type: 'text/html', width: 1280, height: 720 }]`;
   - Twitter `card: 'player'` with `players: [{ playerUrl: embedUrl, streamUrl: hls_url, width: 1280, height: 720 }]`.
5. **Server-rendered HTML of `/watch/{id}`** must already contain:
   - a `<video>` element with `poster` = thumbnail;
   - the title in an `<h1>`;
   - the description as visible text (it may be collapsed with CSS, but it must be in the HTML).

   Verify with `curl` against `pnpm --filter web start` (or the e2e server), not in the browser.
6. **Tests:**
   - unit tests for the schema, sitemap and embed metadata;
   - one e2e or integration check that `/embed/{id}` of a public video returns 200 with the `frame-ancestors` header, and that a private one returns 404.

## Definition of Done
- Lint, typecheck and tests are green, locally and in CI.
- In the PR, paste:
  - the real `curl -sI` headers of `/embed/{id}`;
  - the `<video:video>` block of one sitemap entry;
  - the JSON-LD of one watch page (from `curl`).
- After deploy (Antigravity 2), run Rich Results Test (Video) on 2 watch pages and post the result to #47.

## Handoff note for the user (after deploy)
In Search Console:
1. Resubmit `https://winkey.vn/sitemap.xml`.
2. Use URL Inspection → "Request indexing" for the home page and 2–3 watch pages.
3. Watch the "Video indexing" report over the following days. Google decides when and whether videos appear; new sites usually take days to weeks.
