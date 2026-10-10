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
 */
export async function fetchPublicVideosForSitemap(
  apiBaseUrl: string,
  maxItems = 50000,
): Promise<VideoSummary[]> {
  const publicVideos: VideoSummary[] = [];
  let cursor: string | null = null;
  const pageSize = 100;

  try {
    while (publicVideos.length < maxItems) {
      const url = new URL(`${apiBaseUrl}/v1/videos`);
      url.searchParams.set('sort', 'newest');
      url.searchParams.set('limit', String(pageSize));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 3600 },
      });

      if (!res.ok) {
        break;
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
  } catch {
    // Return whatever was collected before error
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
    const desc = xmlEscape(video.title); // VideoSummary has title; fallback cleanly
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
