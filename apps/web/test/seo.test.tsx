import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Video, PublicProfile, VideoSummary } from '@winkey/api-client';
import {
  msToIsoDuration,
  formatMetaDescription,
  buildVideoObjectSchema,
  buildBreadcrumbListSchema,
} from '../src/lib/seo/video-schema';
import { buildPersonSchema } from '../src/lib/seo/channel-schema';
import { buildWebSiteSchema } from '../src/lib/seo/website-schema';
import { xmlEscape, fetchPublicVideosForSitemap, generateSitemapXml } from '../src/lib/seo/sitemap';
import { jsonLd } from '../src/lib/seo/json-ld';
import robots from '../src/app/robots';
import { generateMetadata as generateWatchMetadata } from '../src/app/[locale]/watch/[id]/page';
import { generateMetadata as generateChannelMetadata } from '../src/app/[locale]/c/[handle]/page';

const mockPublicVideo: Video = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
  title: 'Xây dựng hệ thống Video Streaming phân tán với Go & k3s',
  description:
    'Trong video này, chúng ta sẽ tìm hiểu kiến trúc microservices phân tán phục vụ hàng triệu người xem với Garage S3, NATS JetStream và HLS CMAF transcoding.',
  visibility: 'PUBLIC',
  status: 'READY',
  width: 1920,
  height: 1080,
  duration_ms: 724000, // 12 min 4 sec -> PT12M4S
  view_count: 142500,
  like_count: 8940,
  published_at: '2026-09-17T10:00:00Z',
  created_at: '2026-09-17T09:00:00Z',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
    handle: 'winkey_creator',
    display_name: 'Winkey Official Creator',
    avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200',
  },
  playback: {
    hls_url: 'https://media.winkey.vn/hls/test/master.m3u8',
    thumbnail_url: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800',
    renditions: [
      { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
      { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800 },
      { name: '480p', width: 854, height: 480, bitrate_kbps: 1400 },
    ],
  },
};

const mockUnlistedVideo: Video = {
  ...mockPublicVideo,
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
  visibility: 'UNLISTED',
};

const mockPrivateVideo: Video = {
  ...mockPublicVideo,
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12',
  visibility: 'PRIVATE',
};

const mockProfile: PublicProfile = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  handle: 'winkey_creator',
  display_name: 'Winkey Official Creator',
  avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200',
};

describe('SEO1-web: Search Engine Optimization & Google Discoverability', () => {
  describe('1. Video Schema and Duration helpers', () => {
    it('formats duration in ISO 8601 duration format', () => {
      expect(msToIsoDuration(0)).toBe('PT0S');
      expect(msToIsoDuration(null)).toBe('PT0S');
      expect(msToIsoDuration(undefined)).toBe('PT0S');
      expect(msToIsoDuration(45000)).toBe('PT45S');
      expect(msToIsoDuration(120000)).toBe('PT2M0S');
      expect(msToIsoDuration(724000)).toBe('PT12M4S');
      expect(msToIsoDuration(3665000)).toBe('PT1H1M5S');
    });

    it('formats clean meta description around 155 characters', () => {
      const shortDesc = 'Ngắn gọn.';
      expect(formatMetaDescription(shortDesc)).toBe(shortDesc);

      const longDesc =
        'Trong video này, chúng ta sẽ tìm hiểu kiến trúc microservices phân tán phục vụ hàng triệu người xem với Garage S3, NATS JetStream và HLS CMAF transcoding chi tiết từ A đến Z.';
      const formatted = formatMetaDescription(longDesc);
      expect(formatted.length).toBeLessThanOrEqual(155);
      expect(formatted.endsWith('...')).toBe(true);
    });

    it('builds complete Schema.org VideoObject for PUBLIC video', () => {
      const schema = buildVideoObjectSchema(mockPublicVideo);
      expect(schema).not.toBeNull();
      expect(schema?.['@context']).toBe('https://schema.org');
      expect(schema?.['@type']).toBe('VideoObject');
      expect(schema?.name).toBe(mockPublicVideo.title);
      expect(schema?.description).toBe(mockPublicVideo.description);
      expect(schema?.thumbnailUrl).toEqual([mockPublicVideo.playback!.thumbnail_url]);
      expect(schema?.uploadDate).toBe(mockPublicVideo.published_at);
      expect(schema?.duration).toBe('PT12M4S');
      expect(schema?.embedUrl).toBe(`https://winkey.vn/watch/${mockPublicVideo.id}`);
      expect(schema?.url).toBe(`https://winkey.vn/watch/${mockPublicVideo.id}`);
      expect(schema?.interactionStatistic).toEqual({
        '@type': 'InteractionCounter',
        interactionType: {
          '@type': 'WatchAction',
        },
        userInteractionCount: mockPublicVideo.view_count,
      });
      expect(schema?.author).toEqual({
        '@type': 'Person',
        name: mockPublicVideo.owner.display_name,
        url: `https://winkey.vn/c/${mockPublicVideo.owner.handle}`,
      });
    });

    it('builds BreadcrumbList Schema (Trang chủ › channel › video) for PUBLIC video', () => {
      const breadcrumbs = buildBreadcrumbListSchema(mockPublicVideo);
      expect(breadcrumbs).not.toBeNull();
      expect(breadcrumbs?.['@context']).toBe('https://schema.org');
      expect(breadcrumbs?.['@type']).toBe('BreadcrumbList');
      expect(breadcrumbs?.itemListElement).toHaveLength(3);
      expect(breadcrumbs?.itemListElement[0]).toEqual({
        '@type': 'ListItem',
        position: 1,
        name: 'Trang chủ',
        item: 'https://winkey.vn',
      });
      expect(breadcrumbs?.itemListElement[1]).toEqual({
        '@type': 'ListItem',
        position: 2,
        name: mockPublicVideo.owner.display_name,
        item: `https://winkey.vn/c/${mockPublicVideo.owner.handle}`,
      });
      expect(breadcrumbs?.itemListElement[2]).toEqual({
        '@type': 'ListItem',
        position: 3,
        name: mockPublicVideo.title,
        item: `https://winkey.vn/watch/${mockPublicVideo.id}`,
      });
    });

    it('returns null for VideoObject and BreadcrumbList when video is UNLISTED or PRIVATE', () => {
      expect(buildVideoObjectSchema(mockUnlistedVideo)).toBeNull();
      expect(buildBreadcrumbListSchema(mockUnlistedVideo)).toBeNull();
      expect(buildVideoObjectSchema(mockPrivateVideo)).toBeNull();
      expect(buildBreadcrumbListSchema(mockPrivateVideo)).toBeNull();
    });
  });

  describe('2. Watch Page Metadata and Robots rules', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('generates indexable metadata with canonical and hreflang for PUBLIC video', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockPublicVideo,
      } as Response);

      const metadata = await generateWatchMetadata({
        params: Promise.resolve({ locale: 'vi', id: mockPublicVideo.id }),
      });

      expect(metadata.title).toBe(`${mockPublicVideo.title} – Winkey`);
      expect(metadata.alternates?.canonical).toBe(`https://winkey.vn/watch/${mockPublicVideo.id}`);
      expect(metadata.alternates?.languages).toEqual({
        vi: `https://winkey.vn/vi/watch/${mockPublicVideo.id}`,
        en: `https://winkey.vn/en/watch/${mockPublicVideo.id}`,
      });
      expect(metadata.robots).toEqual({ index: true, follow: true });
      expect((metadata.openGraph as Record<string, unknown>)?.type).toBe('video.other');
    });

    it('generates noindex, nofollow metadata for UNLISTED video', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockUnlistedVideo,
      } as Response);

      const metadata = await generateWatchMetadata({
        params: Promise.resolve({ locale: 'vi', id: mockUnlistedVideo.id }),
      });

      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('generates noindex, nofollow metadata for non-existent video', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const metadata = await generateWatchMetadata({
        params: Promise.resolve({ locale: 'vi', id: 'unknown-id' }),
      });

      expect(metadata.title).toContain('Video không tồn tại');
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });
  });

  describe('3. robots.txt rules', () => {
    it('allows / and disallows private studio/auth/admin routes, pointing to sitemap', () => {
      const config = robots();
      expect(config.rules).toBeDefined();

      const rules = Array.isArray(config.rules) ? config.rules[0] : config.rules;
      expect(rules.userAgent).toBe('*');
      expect(rules.allow).toBe('/');

      const disallows = Array.isArray(rules.disallow) ? rules.disallow : [rules.disallow];

      expect(disallows).toContain('/studio');
      expect(disallows).toContain('/admin');
      expect(disallows).toContain('/upload');
      expect(disallows).toContain('/thu-vien');
      expect(disallows).toContain('/settings');
      expect(disallows).toContain('/notifications');
      expect(disallows).toContain('/login');
      expect(disallows).toContain('/register');

      expect(config.sitemap).toBe('https://winkey.vn/sitemap.xml');
    });
  });

  describe('4. Sitemap generator and API pagination', () => {
    it('escapes XML characters in strings', () => {
      expect(xmlEscape('Hello & "World" <1> >0< \'test\'')).toBe(
        'Hello &amp; &quot;World&quot; &lt;1&gt; &gt;0&lt; &apos;test&apos;',
      );
    });

    it('pages through listVideos server-side, filters only PUBLIC, and caps at limit', async () => {
      const page1Videos = Array.from({ length: 100 }, (_, i) => ({
        id: `vid-p1-${i}`,
        title: `Video P1 ${i}`,
        visibility: i % 2 === 0 ? 'PUBLIC' : 'UNLISTED',
        duration_ms: 60000,
        view_count: 50,
        published_at: '2026-09-01T00:00:00Z',
        owner: {
          id: `user-${i}`,
          handle: `creator_${i}`,
          display_name: `Creator ${i}`,
          avatar_url: null,
        },
        thumbnail_url: 'https://images.unsplash.com/thumb.jpg',
      }));

      const page2Videos = Array.from({ length: 50 }, (_, i) => ({
        id: `vid-p2-${i}`,
        title: `Video P2 ${i}`,
        visibility: 'PUBLIC',
        duration_ms: 120000,
        view_count: 100,
        published_at: '2026-09-02T00:00:00Z',
        owner: {
          id: `user-p2-${i}`,
          handle: `creator_p2_${i}`,
          display_name: `Creator P2 ${i}`,
          avatar_url: null,
        },
        thumbnail_url: 'https://images.unsplash.com/thumb.jpg',
      }));

      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        if (url.includes('cursor=cursor-2')) {
          return {
            ok: true,
            json: async () => ({ items: page2Videos, next_cursor: null }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ items: page1Videos, next_cursor: 'cursor-2' }),
        } as Response;
      });

      const collected = await fetchPublicVideosForSitemap('http://localhost:8080', 50000);
      expect(fetchCallCount).toBe(2);
      // Page 1 has 50 public videos, Page 2 has 50 public videos = 100 total public videos
      expect(collected).toHaveLength(100);
    });

    it('enforces maximum 50,000 URLs cap in sitemap generation', () => {
      const dummyVideos: VideoSummary[] = Array.from({ length: 60000 }, (_, i) => ({
        id: `vid-${i}`,
        title: `Video ${i}`,
        duration_ms: 60000,
        view_count: 10,
        published_at: '2026-09-01T00:00:00Z',
        owner: {
          id: `u-${i}`,
          handle: `user_${i % 100}`,
          display_name: `User ${i % 100}`,
          avatar_url: null,
        },
        thumbnail_url: 'https://images.unsplash.com/thumb.jpg',
      }));

      const xml = generateSitemapXml(dummyVideos, 'https://winkey.vn', 50000);
      const urlCount = (xml.match(/<url>/g) || []).length;
      expect(urlCount).toBeLessThanOrEqual(50000);
    });

    it('generates valid Google video sitemap with <video:video> tags', () => {
      const sampleVideos: VideoSummary[] = [
        {
          id: mockPublicVideo.id,
          title: mockPublicVideo.title,
          duration_ms: mockPublicVideo.duration_ms || 724000,
          view_count: mockPublicVideo.view_count,
          published_at: mockPublicVideo.published_at!,
          owner: mockPublicVideo.owner,
          thumbnail_url: mockPublicVideo.playback!.thumbnail_url!,
        },
      ];

      const xml = generateSitemapXml(sampleVideos, 'https://winkey.vn');

      expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
      expect(xml).toContain('<loc>https://winkey.vn</loc>');
      expect(xml).toContain('<loc>https://winkey.vn/kham-pha</loc>');
      expect(xml).toContain('<loc>https://winkey.vn/trending</loc>');
      expect(xml).toContain('<loc>https://winkey.vn/c/winkey_creator</loc>');
      expect(xml).toContain(`<loc>https://winkey.vn/watch/${mockPublicVideo.id}</loc>`);
      expect(xml).toContain('<video:video>');
      expect(xml).toContain(`<video:title>${xmlEscape(mockPublicVideo.title)}</video:title>`);
      expect(xml).toContain('<video:duration>724</video:duration>');
      expect(xml).toContain(
        `<video:publication_date>${mockPublicVideo.published_at}</video:publication_date>`,
      );
      expect(xml).toContain(`https://winkey.vn/watch/${mockPublicVideo.id}`);
    });
  });

  describe('5. Channel Page Metadata & Person JSON-LD', () => {
    it('builds Schema.org Person JSON-LD for channel', () => {
      const personSchema = buildPersonSchema(mockProfile);
      expect(personSchema['@context']).toBe('https://schema.org');
      expect(personSchema['@type']).toBe('Person');
      expect(personSchema.name).toBe(mockProfile.display_name);
      expect(personSchema.alternateName).toBe(`@${mockProfile.handle}`);
      expect(personSchema.url).toBe(`https://winkey.vn/c/${mockProfile.handle}`);
      expect(personSchema.image).toBe(mockProfile.avatar_url);
    });

    it('generates channel metadata with canonical and OG profile', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockProfile,
      } as Response);

      const metadata = await generateChannelMetadata({
        params: Promise.resolve({ locale: 'vi', handle: mockProfile.handle }),
      });

      expect(metadata.title).toBe(`${mockProfile.display_name} – Winkey`);
      expect(metadata.alternates?.canonical).toBe(`https://winkey.vn/c/${mockProfile.handle}`);
      expect(metadata.alternates?.languages).toEqual({
        vi: `https://winkey.vn/vi/c/${mockProfile.handle}`,
        en: `https://winkey.vn/en/c/${mockProfile.handle}`,
      });
      expect((metadata.openGraph as Record<string, unknown>)?.type).toBe('profile');
      expect(metadata.openGraph?.url).toBe(`https://winkey.vn/c/${mockProfile.handle}`);
    });
  });

  describe('6. Home Page WebSite JSON-LD with SearchAction', () => {
    it('builds Schema.org WebSite with SearchAction pointing at /kham-pha?q={search_term_string}', () => {
      const siteSchema = buildWebSiteSchema();
      expect(siteSchema['@context']).toBe('https://schema.org');
      expect(siteSchema['@type']).toBe('WebSite');
      expect(siteSchema.name).toBe('Winkey');
      expect(siteSchema.url).toBe('https://winkey.vn');
      expect(siteSchema.potentialAction['@type']).toBe('SearchAction');
      expect(siteSchema.potentialAction.target.urlTemplate).toBe(
        'https://winkey.vn/kham-pha?q={search_term_string}',
      );
      expect(siteSchema.potentialAction['query-input']).toBe('required name=search_term_string');
    });
  });

  describe('7. jsonLd helper escaping and XSS safety', () => {
    it('escapes </script><script>x</script> in title so no raw </script> appears, and parses back to original', () => {
      const maliciousPayload = {
        title: '</script><script>x</script>',
      };

      const serialized = jsonLd(maliciousPayload);

      // Raw </script> must never appear in serialized output
      expect(serialized).not.toContain('</script>');
      expect(serialized).not.toContain('<script>');
      expect(serialized).toContain(
        '\\u003c/script\\u003e\\u003cscript\\u003ex\\u003c/script\\u003e',
      );

      // Standard JSON.parse must reconstruct the exact original string
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(maliciousPayload);
      expect(parsed.title).toBe('</script><script>x</script>');
    });

    it('escapes <, >, &, U+2028, and U+2029 while preserving exact object values upon parsing', () => {
      const complexPayload = {
        html: '<div class="test">&amp; "value" > 0</div>',
        lineBreak: 'Line 1\u2028Line 2\u2029Paragraph 2',
      };

      const serialized = jsonLd(complexPayload);

      // Verify dangerous HTML characters and JS line separators are escaped
      expect(serialized).not.toContain('<');
      expect(serialized).not.toContain('>');
      expect(serialized).not.toContain('&');
      expect(serialized).not.toContain('\u2028');
      expect(serialized).not.toContain('\u2029');

      expect(serialized).toContain('\\u003c');
      expect(serialized).toContain('\\u003e');
      expect(serialized).toContain('\\u0026');
      expect(serialized).toContain('\\u2028');
      expect(serialized).toContain('\\u2029');

      // Verify round-trip integrity
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(complexPayload);
    });
  });
});
