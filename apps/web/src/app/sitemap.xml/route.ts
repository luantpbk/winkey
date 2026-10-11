import { getCachedSitemapXml } from '../../lib/seo/sitemap';

export const dynamic = 'force-dynamic';

export async function GET() {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';

  try {
    const xml = await getCachedSitemapXml(baseUrl, 'https://winkey.vn');

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return new Response('Service Unavailable', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '600',
      },
    });
  }
}
