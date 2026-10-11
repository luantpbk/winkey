import type { VideoSummary, VideoPage } from '@winkey/api-client';

export function xmlEscape(str?: string | null): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pages through /v1/videos?sort=newest via API_INTERNAL_URL, collecting PUBLIC videos up to maxItems (default 50,000).
 * Throws on any non-OK HTTP status or network failure instead of returning a partial list.
 */
export async function fetchPublicVideosForSitemap(
  apiBaseUrl: string,
  maxItems = 50000,
): Promise<VideoSummary[]> {
  const publicVideos: VideoSummary[] = [];
  let cursor: string | null = null;
  const pageSize = 100;

  while (publicVideos.length < maxItems) {
    const url = new URL(`${apiBaseUrl}/v1/videos`);
    url.searchParams.set('sort', 'newest');
    url.searchParams.set('limit', String(pageSize));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch public videos for sitemap: HTTP ${res.status}`);
    }

    const data: VideoPage = await res.json();
    const items = data.items || [];
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      // Defensive check: only collect PUBLIC items if visibility field is present
      const itemVisibility = (item as unknown as { visibility?: string }).visibility;
      if (!itemVisibility || itemVisibility === 'PUBLIC') {
        publicVideos.push(item);
        if (publicVideos.length >= maxItems) break;
      }
    }

    if (!data.next_cursor || data.next_cursor === cursor) {
      break;
    }
    cursor = data.next_cursor;
  }

  return publicVideos;
}

/**
 * Generates Google-compliant XML sitemap including static routes, creator channels,
 * and VideoObject-compatible <video:video> elements. Capped at 50,000 URLs.
 */
export function generateSitemapXml(
  videos: VideoSummary[],
  siteBaseUrl = 'https://winkey.vn',
  maxUrls = 50000,
): string {
  const urls: string[] = [];

  // 1. Static high-priority pages
  urls.push(`  <url>
    <loc>${siteBaseUrl}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`);

  urls.push(`  <url>
    <loc>${siteBaseUrl}/kham-pha</loc>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
  </url>`);

  urls.push(`  <url>
    <loc>${siteBaseUrl}/trending</loc>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
  </url>`);

  // 2. Creator channel pages of the public videos
  const seenHandles = new Set<string>();
  for (const video of videos) {
    if (urls.length >= maxUrls) break;
    const handle = video.owner?.handle;
    if (handle && !seenHandles.has(handle)) {
      seenHandles.add(handle);
      urls.push(`  <url>
    <loc>${siteBaseUrl}/c/${xmlEscape(handle)}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`);
    }
  }

  // 3. Video pages with <video:video> extension tags
  for (const video of videos) {
    if (urls.length >= maxUrls) break;
    const watchUrl = `${siteBaseUrl}/watch/${video.id}`;
    const pubDate =
      video.published_at || (video as unknown as { created_at?: string }).created_at || '';
    const thumb = video.thumbnail_url || `${siteBaseUrl}/og-default.jpg`;
    const title = xmlEscape(video.title);
    const rawDesc = (video as unknown as { description?: string }).description;
    const desc = xmlEscape(rawDesc && rawDesc.trim().length > 0 ? rawDesc : video.title);
    const durationSeconds = Math.max(1, Math.round((video.duration_ms || 0) / 1000));

    urls.push(`  <url>
    <loc>${watchUrl}</loc>
    <lastmod>${pubDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <video:video>
      <video:thumbnail_loc>${xmlEscape(thumb)}</video:thumbnail_loc>
      <video:title>${title}</video:title>
      <video:description>${desc}</video:description>
      <video:player_loc>${watchUrl}</video:player_loc>
      <video:duration>${durationSeconds}</video:duration>
      <video:publication_date>${pubDate}</video:publication_date>
    </video:video>
  </url>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${urls.join('\n')}
</urlset>`;
}

export const SITEMAP_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface SitemapCacheEntry {
  xml: string;
  expiresAt: number;
}

let sitemapCache: SitemapCacheEntry | null = null;
let inFlightSitemapPromise: Promise<string> | null = null;

export function resetSitemapCacheForTesting(): void {
  sitemapCache = null;
  inFlightSitemapPromise = null;
}

export function setSitemapCacheForTesting(xml: string, expiresAt: number): void {
  sitemapCache = { xml, expiresAt };
}

/**
 * Retrieves the sitemap XML using module-level in-memory cache with 15-minute TTL.
 * Implements single-flight request coalescing so concurrent requests share one fetch.
 * On failure: serves the last good cached XML if one exists; otherwise throws.
 */
export async function getCachedSitemapXml(
  apiBaseUrl: string,
  siteBaseUrl = 'https://winkey.vn',
): Promise<string> {
  const now = Date.now();

  // If cache is fresh, return immediately
  if (sitemapCache && now < sitemapCache.expiresAt) {
    return sitemapCache.xml;
  }

  // If a fetch is already in flight, wait for it
  if (inFlightSitemapPromise) {
    try {
      return await inFlightSitemapPromise;
    } catch (err) {
      if (sitemapCache) {
        return sitemapCache.xml;
      }
      throw err;
    }
  }

  // Start single-flight fetch
  inFlightSitemapPromise = (async () => {
    const videos = await fetchPublicVideosForSitemap(apiBaseUrl, 50000);
    const xml = generateSitemapXml(videos, siteBaseUrl);
    sitemapCache = {
      xml,
      expiresAt: Date.now() + SITEMAP_CACHE_TTL_MS,
    };
    return xml;
  })();

  try {
    return await inFlightSitemapPromise;
  } catch (err) {
    if (sitemapCache) {
      return sitemapCache.xml;
    }
    throw err;
  } finally {
    inFlightSitemapPromise = null;
  }
}
