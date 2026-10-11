# Kickoff — Antigravity 1 · SEO1-fix (dynamic sitemap) then SEO2-web (tag pages for Google)

Design: **ADR-037**. Contract: `contracts/openapi/video.v1.yaml`, group `tag-pages`: `listVideos?tag=`, `listTags`,
`getTag`, `Video.tag_slugs`. api-client is already regenerated. Two separate PRs, **A first**. B can start once the
architect's video-svc PR (SEO2 Go) is merged; build it against MSW until then.

````text
# ROLE
You are Antigravity 1, frontend engineer on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client.
Never edit contracts/, services/, deploy/, docs/. Before every commit run `git branch --show-current`.

# PART A — SEO1-fix: sitemap rendered per request. Branch agent/ag1/seo1-sitemap-dynamic (small PR, urgent)
Root cause (the architect reproduced it): `apps/web/src/app/sitemap.xml/route.ts` has `export const revalidate = 3600`,
so `next build` PRERENDERS it inside the Docker build. CI has no API, so the image ships an empty sitemap (533 B).
Fix:
1. route.ts: `export const dynamic = 'force-dynamic'` and remove `revalidate`. `next build` must list
   `ƒ /sitemap.xml` (dynamic), not `○`. Paste that build line in the PR.
2. Cache the API result IN MEMORY (module-level), TTL 15 min, single-flight (concurrent requests share one fetch).
   Do not rely on the Next fetch cache for this.
3. If fetching fails or `fetchPublicVideosForSitemap` cannot finish:
   - serve the last good cached XML if there is one;
   - otherwise answer 503 with `Retry-After: 600`.
   Never answer 200 with a partial list. Change `fetchPublicVideosForSitemap` so it THROWS on a non-OK page instead of
   silently returning what it has so far.
4. Keep the headers (`application/xml; charset=utf-8`, `Cache-Control: public, max-age=3600, …`).
5. `video:description`: use the real description when the API gives one; keep the title as the fallback.
Tests (Vitest):
- XML is well-formed (parse it) and ends with `</urlset>`;
- every PUBLIC video from a 2-page mock appears;
- a failed page 2 → 503 when there is no cache, and the stale XML when there is one;
- the cache is reused within the TTL (one set of fetches for two calls).

# PART B — SEO2-web: tag pages. Branch agent/ag1/seo2-tag-pages
1. New page `src/app/[locale]/tag/[slug]/page.tsx` (server component):
   - `getTag(slug)` (via API_INTERNAL_URL, like the watch page): 404 → `notFound()`.
   - If `tag.slug !== params.slug` (for example `/tag/Phim%20ng%E1%BA%AFn` or `/tag/PHIM-NGAN`) → `permanentRedirect`
     to `/tag/<tag.slug>`.
   - First page: `listVideos?tag=<slug>&limit=24`. "Xem thêm" loads more client-side with `next_cursor`.
   - Content Google can read, all in the server HTML:
     - `<h1>#{name}</h1>`;
     - one intro line, for example "{count} video về {name} trên Winkey";
     - a grid of video cards whose TITLES are plain `<a href="/watch/<id>">` text links.
   - Metadata:
     - title `"{name} – Video về {name} | Winkey"`;
     - description: "Xem {count} video về {name}: {title1}, {title2}, {title3}…", cut to 155 chars;
     - canonical `https://winkey.vn/tag/<slug>`;
     - Open Graph with the first video's thumbnail;
     - robots: `index, follow` when `video_count >= 2`, `noindex, follow` when it is 1.
   - JSON-LD, through the existing `jsonLd()` helper (keeps the `<`/U+2028 escaping):
     - `CollectionPage` (name, url, description) with `mainEntity: ItemList`;
     - each `ListItem` has position and url `https://winkey.vn/watch/<id>`, for the first-page videos;
     - plus `BreadcrumbList`: Winkey › #{name}.
   - `/en/tag/...` works like the other localized routes; the canonical URL is always the vi URL.
2. Watch page:
   - Under the description, show each tag as a chip link `#{tag}` → `/tag/{tag_slugs[i]}` (next-intl `Link`).
   - When `tag_slugs[i]` is `""` or missing, render plain text with no link.
   - These must be in the server-rendered HTML, not client-only.
   - `VideoObject` JSON-LD: add `keywords: tags.join(', ')` when there are tags.
3. Sitemap (on top of Part A):
   - add `https://winkey.vn/tag/<slug>` for `listTags?min_videos=2&limit=1000`;
   - `lastmod` = `latest_published_at`; `changefreq` daily; priority 0.6.
4. Studio edit page (ST1): under the tag input, add one helper line: "Thẻ dùng cho ít nhất 2 video công khai sẽ có trang
   riêng trên Google."
5. robots.ts: do NOT disallow `/tag`.
6. i18n: every new string goes in vi.json and en.json.

# DEFINITION OF DONE
- Vitest:
  - tag page: renders h1, cards and canonical; redirects to the canonical slug; 404 for an unknown tag;
  - robots: index at count ≥ 2, noindex at 1;
  - the JSON-LD parses and escapes `</script>`;
  - watch chips link only for non-empty slugs; `keywords` is present;
  - the sitemap includes tag URLs only for min_videos=2 (check the request).
- Playwright (MSW): watch page tag chip → tag page → video card → watch page, desktop and mobile.
- web lint, typecheck, test and build pass; root lint + format:check pass; CI is green.
  Run `pnpm --filter @winkey/web run build` locally before every push.
- The PR body is the Handoff Report with real outputs:
  - the build route table, showing `ƒ /sitemap.xml` and `ƒ /[locale]/tag/[slug]`;
  - the test summary;
  - screenshots of a tag page.
````
