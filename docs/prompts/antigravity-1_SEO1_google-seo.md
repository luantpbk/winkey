# Kickoff — Antigravity 1 · Task SEO1-web (get videos onto Google)

Design: ADR-036. Web only; uses existing public APIs (getVideo, listVideos, getUserByHandle). After ST1-web.

````text
# ROLE
You are Antigravity 1 on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client.

# REPO
git worktree add ../winkey-ag1-seo1 -b agent/ag1/seo1-google origin/main

# TASK
1. Watch page (`/watch/{id}`) server metadata:
   - `<title>` = "<video title> – Winkey", and a meta description of about 155 characters from the description.
   - Canonical `https://winkey.vn/watch/{id}`, with hreflang vi/en alternates.
   - Open Graph `og:type=video.other`, `og:video` = the watch URL, `og:image` = the thumbnail; plus a Twitter card.
   - JSON-LD `VideoObject` in a `<script type="application/ld+json">`:
     - name, description, thumbnailUrl[], uploadDate (published_at);
     - duration as ISO 8601 (from duration_ms, e.g. PT12M4S);
     - embedUrl / url = the watch URL;
     - interactionStatistic WatchAction with userInteractionCount = view_count;
     - author Person (name, url = channel URL).
   - Also a `BreadcrumbList` (Trang chủ › channel › video).
   - Only PUBLIC videos are indexable. For UNLISTED / PRIVATE use robots `noindex, nofollow` and omit the JSON-LD.
2. Channel page `/c/{handle}`: title, description, canonical, OG profile, and JSON-LD `Person`.
3. `app/robots.ts`:
   - allow `/`;
   - disallow `/studio`, `/admin`, `/upload`, `/thu-vien`, `/settings`, `/notifications`, `/login`, `/register`;
   - point to the sitemap.
4. `app/sitemap.ts` (or route handlers for a sitemap index plus a video sitemap):
   - page through `listVideos?sort=newest` server-side via API_INTERNAL_URL (PUBLIC only), at most 50 000 URLs per
     file, revalidate every 1 h;
   - include `/`, `/kham-pha`, `/trending`, each watch URL (lastmod = published_at) and each channel of those videos;
   - the video sitemap entries carry `<video:video>` (thumbnail_loc, title, description, player_loc, duration,
     publication_date).
5. In the home page `<head>`: JSON-LD `WebSite` with a `SearchAction` pointing at `/kham-pha?q={search_term_string}`
   (or the existing search route).

# DEFINITION OF DONE
- Vitest:
  - JSON-LD shape for a PUBLIC video, including the ISO duration;
  - noindex and no JSON-LD for UNLISTED;
  - robots rules;
  - the sitemap pages through the API and caps at 50 000;
  - the channel metadata.
- Check the rendered HTML of a watch page against Google's Rich Results Test rules (paste the JSON-LD into the PR).
  web lint, typecheck, test and build, CI green.
- Handoff note for the user: verify winkey.vn in Google Search Console with a DNS TXT record in Cloudflare, then
  submit https://winkey.vn/sitemap.xml.
````
