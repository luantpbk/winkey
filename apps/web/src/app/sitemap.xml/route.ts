import { fetchPublicVideosForSitemap, generateSitemapXml } from '../../lib/seo/sitemap';

export const revalidate = 3600;

export async function GET() {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  const videos = await fetchPublicVideosForSitemap(baseUrl, 50000);
  const xml = generateSitemapXml(videos, 'https://winkey.vn');

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
