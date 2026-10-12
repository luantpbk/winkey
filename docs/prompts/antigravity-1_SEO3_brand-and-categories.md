# Antigravity 1 — SEO3: brand on Google + entertainment category pages (ADR-040)

Read `AGENTS.md`, ADR-036, ADR-037 and **ADR-040** first. Work only in `apps/web` (plus `e2e/` and `packages/api-client` if needed). No contract or migration changes are needed.

Branch: `agent/ag1/seo3-brand-categories` from `origin/main`. One PR. The PR description is the Handoff Report.

## Problem (verified in code on main `1a97a21`)
- No favicon, `icon`, `apple-icon` or web manifest at all, so Google shows a generic globe.
- The only "logo" is the lucide `PlaySquare` icon. There is no logo file and no `Organization` JSON-LD.
- `app/layout.tsx` has an English default title and no `metadataBase`, title template, `siteName` or `locale`.
- The home page description is built from the first hero video title, so it changes all the time and has no entertainment keywords. The home page has no text H1.
- There are no landing pages for "phim / nhạc / game / giải trí" searches.

## Tasks

### 1. Brand assets
- Create `apps/web/src/assets/brand/logo.svg`: the existing play-square mark plus the word "Winkey", in the brand colour already used in the UI. Keep it simple and readable at 16 px. The user may replace it with an official logo later, so generate every raster from the SVG with a script (`apps/web/scripts/brand-assets.mjs`, using `sharp` or `resvg`) and commit the outputs:
  - `src/app/favicon.ico` (16, 32, 48)
  - `src/app/icon.png` 512×512
  - `src/app/apple-icon.png` 180×180
  - `public/logo.png` 512×512 (square, solid background, for `Organization.logo`)
  - `src/app/opengraph-image.png` 1200×630 (logo + "Xem phim, video, nhạc và game giải trí")
  - `src/app/manifest.ts` (name, short_name, icons, theme/background colour, `lang: 'vi'`)
- Use the SVG in the top bar instead of the bare `PlaySquare` (`aria-label="Winkey – Trang chủ"`).
- None of these paths may be disallowed in `robots.ts`.

### 2. Root metadata (`src/app/layout.tsx` and/or `[locale]/layout.tsx`)
- `metadataBase: new URL('https://winkey.vn')`.
- `title: { default: 'Winkey – Xem phim, video, nhạc và game giải trí', template: '%s | Winkey' }`.
- Fixed description, 140–160 characters, Vietnamese, mentioning phim, phim bộ, video, nhạc, game and giải trí. Make it read naturally; no keyword stuffing.
- `applicationName`, `openGraph` (`siteName: 'Winkey'`, `locale: 'vi_VN'`, `type: 'website'`, default image), `twitter: summary_large_image`, `alternates.canonical: '/'` on the home page, plus `icons` and `manifest`.
- Check that existing page titles do not end up as "… | Winkey | Winkey" (watch, tag and channel pages already add their own suffix; remove the duplicate).

### 3. Home page (`[locale]/page.tsx`)
- `generateMetadata` uses the fixed title and description. Never derive them from a video. Keep a video thumbnail only as an optional extra OG image after the default one.
- Add a visible H1 plus a 1–2 sentence intro. It can be compact, styled to the dark cinema UI, above or below the hero. Example: "Winkey – xem phim, phim bộ, video, nhạc và game miễn phí".
- JSON-LD: keep `WebSite` (add `alternateName: ['Winkey.vn', 'winkey']`) and add `Organization` `{ name: 'Winkey', url: 'https://winkey.vn', logo: 'https://winkey.vn/logo.png' }` (`sameAs` only if real social accounts exist; ask the user, don't invent them).

### 4. Category pages `/the-loai/[slug]`
- Define them in code, e.g. `src/lib/seo/categories.ts`: `slug`, `name`, `title`, `description` (140–160 characters), `intro` (2–3 sentences, unique per category), `tags` (source tag slugs). Start with:
  `phim` (phim, phim-le, phim-hay, co-trang, hanh-dong, kinh-di, tinh-cam), `phim-bo` (phim-bo, series), `am-nhac` (am-nhac, nhac, music, nhac-tre, bolero, rap), `game` (game, gaming, lien-quan, free-fire, minecraft), `hai-huoc` (hai-huoc, hai, funny), `giai-tri` (giai-tri, showbiz, talkshow), `the-thao` (the-thao, bong-da), `hoat-hinh` (hoat-hinh, anime). Keep the list easy to edit.
- Server-render the page: fetch `GET /v1/videos?tag=<t>&limit=12` for each source tag in parallel, merge, de-duplicate by id, and keep one row per tag that has videos (heading = the tag's display name from `GET /v1/tags/{tag}`).
- SEO, the same as `/tag/[slug]` (ADR-037):
  - canonical `/the-loai/<slug>`;
  - `index,follow` when there are ≥ 2 distinct videos in total, otherwise `noindex,follow`;
  - unknown slug → 404; a 5xx from the API throws (it is not a 404);
  - JSON-LD `CollectionPage` + `ItemList` (first 20 videos) + `BreadcrumbList` (Trang chủ › Thể loại › <name>).
- Add the indexable categories to `sitemap.xml`. Reuse the existing force-dynamic sitemap with its 15-minute cache; don't add another cache.
- Add a "Thể loại" section to the sidebar.

### 5. Footer
- Add a site footer, rendered on the server and present in the HTML: a short "Về Winkey" text, links to every category, Điều khoản, Quyền riêng tư and Quy tắc cộng đồng.
- Hide it or keep it compact on the full-screen watch/cinema views if it hurts the layout. It must still be in the DOM.

### 6. Tests and evidence
- Unit tests:
  - metadata of the home page and of one category page;
  - the category merge/de-duplication;
  - the index/noindex threshold;
  - the 404 for an unknown slug;
  - sitemap entries.
- Playwright (`e2e/` and/or a new `systest/personas/anon-viewer` case, coordinate with AG4): the home page has the H1, `link[rel=icon]` and the `Organization` JSON-LD; `/the-loai/am-nhac` renders with a canonical URL and JSON-LD.
- PR evidence:
  - `curl -s https://<preview or local>/ | grep -E '<title>|name="description"|rel="icon"|application/ld\+json'`;
  - screenshots of the home and category pages;
  - Rich Results Test output (paste the result text) for `/`, `/the-loai/phim` and one `/watch/<id>`.

## After deploy (to the user, not code)
In Search Console: resubmit `sitemap.xml`, then use URL Inspection → Request indexing for `https://winkey.vn/` and 2–3 `/the-loai/...` pages. Favicon, site name and description show up after Google recrawls, usually within days to a few weeks.

## Out of scope
- Changing the API or contracts (multi-tag queries, an admin-managed category list).
- Paid or off-site SEO.
