import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TagSummary, Video, VideoSummary, TagList } from '@winkey/api-client';
import TagPage, {
  generateMetadata as generateTagMetadata,
} from '../src/app/[locale]/tag/[slug]/page';
import { WatchClientSection } from '../src/app/[locale]/watch/[id]/watch-client';
import { buildTagCollectionPageSchema, buildTagBreadcrumbSchema } from '../src/lib/seo/tag-schema';
import { buildVideoObjectSchema } from '../src/lib/seo/video-schema';
import {
  fetchTagsForSitemap,
  generateSitemapXml,
  getCachedSitemapXml,
  resetSitemapCacheForTesting,
} from '../src/lib/seo/sitemap';
import { jsonLd } from '../src/lib/seo/json-ld';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

// --- Mocks ---
let activeLocale: 'vi' | 'en' = 'vi';

const mockPermanentRedirect = vi.fn();
const mockNotFound = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/watch/test-video',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    mockNotFound();
    throw new Error('NEXT_NOT_FOUND');
  },
  permanentRedirect: (url: string) => {
    mockPermanentRedirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const messages = activeLocale === 'vi' ? viMessages : enMessages;
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = messages;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return key;
        }
      }
      if (typeof cur === 'string') {
        let res = cur;
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return res;
      }
      return key;
    };
  },
}));

vi.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const messages = activeLocale === 'vi' ? viMessages : enMessages;
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = messages;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return key;
        }
      }
      if (typeof cur === 'string') {
        let res = cur;
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return res;
      }
      return key;
    };
  },
}));

vi.mock('../src/i18n/routing', () => ({
  Link: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/watch/test-video',
}));

// --- Test Fixtures ---
const mockTagPhimNgan: TagSummary = {
  slug: 'phim-ngan',
  name: 'Phim ngắn',
  video_count: 5,
  latest_published_at: '2026-10-10T12:00:00Z',
};

const mockTagSingleVideo: TagSummary = {
  slug: 'hiem-gap',
  name: 'Hiếm gặp',
  video_count: 1,
  latest_published_at: '2026-10-09T08:00:00Z',
};

const mockVideo1: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  title: 'Chuyến tàu hoàng hôn – Phim ngắn xúc động',
  duration_ms: 600000,
  view_count: 12000,
  published_at: '2026-10-10T12:00:00Z',
  thumbnail_url: 'https://images.unsplash.com/photo-1518770660439?w=800',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c00',
    handle: 'filmmaker_vn',
    display_name: 'Nhà làm phim trẻ',
    avatar_url: null,
  },
};

const mockVideo2: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
  title: 'Ký ức Sài Gòn xưa – Phim ngắn đoạt giải',
  duration_ms: 720000,
  view_count: 34000,
  published_at: '2026-10-09T10:00:00Z',
  thumbnail_url: 'https://images.unsplash.com/photo-1534528741775?w=800',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c00',
    handle: 'filmmaker_vn',
    display_name: 'Nhà làm phim trẻ',
    avatar_url: null,
  },
};

const mockFullVideo: Video = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  title: 'Chuyến tàu hoàng hôn',
  description: 'Một bộ phim ngắn cảm động về gia đình.',
  visibility: 'PUBLIC',
  status: 'READY',
  width: 1920,
  height: 1080,
  duration_ms: 600000,
  view_count: 12000,
  like_count: 1500,
  published_at: '2026-10-10T12:00:00Z',
  created_at: '2026-10-10T11:00:00Z',
  tags: ['Phim ngắn', 'Công nghệ', 'Tag Không Link'],
  tag_slugs: ['phim-ngan', 'cong-nghe', ''],
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c00',
    handle: 'filmmaker_vn',
    display_name: 'Nhà làm phim trẻ',
    avatar_url: null,
  },
  playback: {
    hls_url: 'https://media.winkey.vn/hls/master.m3u8',
    thumbnail_url: 'https://images.unsplash.com/photo-1518770660439?w=800',
    renditions: [],
  },
};

describe('SEO2-web: Tag Landing Pages & Discoverability (ADR-037)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeLocale = 'vi';
    resetSitemapCacheForTesting();
  });

  describe('1. Tag Page metadata & robots indexing threshold', () => {
    it('sets robots { index: true, follow: true } when video_count >= 2', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/phim-ngan')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan,
          } as Response;
        }
        if (url.includes('/v1/videos?tag=phim-ngan')) {
          return {
            ok: true,
            json: async () => ({
              items: [mockVideo1, mockVideo2],
              next_cursor: null,
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const meta = await generateTagMetadata({
        params: Promise.resolve({ locale: 'vi', slug: 'phim-ngan' }),
      });

      expect(meta.title).toBe('Phim ngắn – Video về Phim ngắn | Winkey');
      expect(meta.description).toContain('Xem 5 video về Phim ngắn trên Winkey');
      expect(meta.alternates?.canonical).toBe('https://winkey.vn/tag/phim-ngan');
      expect(meta.alternates?.languages).toBeUndefined();
      expect(meta.robots).toEqual({ index: true, follow: true });
      const ogImages = meta.openGraph?.images as Array<{ url: string }> | undefined;
      expect(ogImages?.[0]).toEqual(expect.objectContaining({ url: mockVideo1.thumbnail_url }));
    });

    it('sets robots { index: false, follow: true } when video_count is 1 to prevent thin content', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/hiem-gap')) {
          return {
            ok: true,
            json: async () => mockTagSingleVideo,
          } as Response;
        }
        if (url.includes('/v1/videos?tag=hiem-gap')) {
          return {
            ok: true,
            json: async () => ({
              items: [mockVideo1],
              next_cursor: null,
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const meta = await generateTagMetadata({
        params: Promise.resolve({ locale: 'vi', slug: 'hiem-gap' }),
      });

      expect(meta.robots).toEqual({ index: false, follow: true });
      expect(meta.alternates?.canonical).toBe('https://winkey.vn/tag/hiem-gap');
    });

    it('always preserves Vietnamese canonical URL on English route', async () => {
      activeLocale = 'en';
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/phim-ngan')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan,
          } as Response;
        }
        if (url.includes('/v1/videos?tag=phim-ngan')) {
          return {
            ok: true,
            json: async () => ({
              items: [mockVideo1, mockVideo2],
              next_cursor: null,
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const meta = await generateTagMetadata({
        params: Promise.resolve({ locale: 'en', slug: 'phim-ngan' }),
      });

      expect(meta.title).toBe('Phim ngắn – Videos about Phim ngắn | Winkey');
      expect(meta.alternates?.canonical).toBe('https://winkey.vn/tag/phim-ngan');
    });
  });

  describe('2. Tag Page rendering & navigation behavior', () => {
    it('renders SSR h1, intro line, and video card links for Google crawler', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/phim-ngan')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan,
          } as Response;
        }
        if (url.includes('/v1/videos?tag=phim-ngan')) {
          return {
            ok: true,
            json: async () => ({
              items: [mockVideo1, mockVideo2],
              next_cursor: null,
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const queryClient = new QueryClient();
      const pageJsx = await TagPage({
        params: Promise.resolve({ locale: 'vi', slug: 'phim-ngan' }),
      });

      render(<QueryClientProvider client={queryClient}>{pageJsx}</QueryClientProvider>);

      // Google crawler needs <h1>#{name}</h1>
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent).toBe('#Phim ngắn');

      // Intro text
      expect(screen.getByText('5 video về Phim ngắn trên Winkey')).toBeTruthy();

      // Video cards titles with text links
      const titleLink1 = screen.getByText('Chuyến tàu hoàng hôn – Phim ngắn xúc động');
      expect(titleLink1.closest('a')?.getAttribute('href')).toBe(`/watch/${mockVideo1.id}`);

      const titleLink2 = screen.getByText('Ký ức Sài Gòn xưa – Phim ngắn đoạt giải');
      expect(titleLink2.closest('a')?.getAttribute('href')).toBe(`/watch/${mockVideo2.id}`);
    });

    it('308 permanentRedirects when request slug does not match canonical tag.slug', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan, // canonical slug is 'phim-ngan'
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'PHIM-NGAN' }),
        }),
      ).rejects.toThrow('NEXT_REDIRECT:/tag/phim-ngan');

      expect(mockPermanentRedirect).toHaveBeenCalledWith('/tag/phim-ngan');
    });

    it('calls notFound() when tag does not exist', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'nonexistent-tag' }),
        }),
      ).rejects.toThrow('NEXT_NOT_FOUND');

      expect(mockNotFound).toHaveBeenCalled();
    });

    it('throws an error (500) when getTag encounters 503 instead of calling notFound', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      } as Response);

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'phim-ngan' }),
        }),
      ).rejects.toThrow('Failed to fetch tag: HTTP 503');

      expect(mockNotFound).not.toHaveBeenCalled();
    });

    it('throws an error (500) on network error in getTag instead of calling notFound', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'phim-ngan' }),
        }),
      ).rejects.toThrow('Network error');

      expect(mockNotFound).not.toHaveBeenCalled();
    });

    it('throws an error (500) when getTagVideos encounters 500 or 502', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/phim-ngan')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan,
          } as Response;
        }
        if (url.includes('/v1/videos?tag=phim-ngan')) {
          return {
            ok: false,
            status: 500,
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'phim-ngan' }),
        }),
      ).rejects.toThrow('Failed to fetch tag videos: HTTP 500');

      expect(mockNotFound).not.toHaveBeenCalled();
    });

    it('safely decodes percent-encoded slug param and 308 permanentRedirects to canonical slug without double-encoding', async () => {
      let fetchedTagUrl = '';
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        fetchedTagUrl = url;
        if (url.includes('/v1/tags/')) {
          return {
            ok: true,
            json: async () => mockTagPhimNgan, // canonical slug is 'phim-ngan'
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      await expect(
        TagPage({
          params: Promise.resolve({ locale: 'vi', slug: 'Phim%20ng%E1%BA%AFn' }),
        }),
      ).rejects.toThrow('NEXT_REDIRECT:/tag/phim-ngan');

      // The fetch URL must NOT be double-encoded as Phim%2520...
      expect(fetchedTagUrl).toContain('/v1/tags/Phim%20ng%E1%BA%AFn');
      expect(fetchedTagUrl).not.toContain('%25');
      expect(mockPermanentRedirect).toHaveBeenCalledWith('/tag/phim-ngan');
    });
  });

  describe('3. JSON-LD Schemas: CollectionPage, ItemList, BreadcrumbList & XSS Safety', () => {
    it('builds CollectionPage with ItemList and BreadcrumbList', () => {
      const collection = buildTagCollectionPageSchema(
        mockTagPhimNgan,
        [mockVideo1, mockVideo2],
        'Xem 5 video về Phim ngắn trên Winkey',
      );

      expect(collection['@context']).toBe('https://schema.org');
      expect(collection['@type']).toBe('CollectionPage');
      expect(collection.name).toBe('#Phim ngắn');
      expect(collection.url).toBe('https://winkey.vn/tag/phim-ngan');
      expect(collection.mainEntity['@type']).toBe('ItemList');
      expect(collection.mainEntity.itemListElement).toEqual([
        {
          '@type': 'ListItem',
          position: 1,
          url: `https://winkey.vn/watch/${mockVideo1.id}`,
        },
        {
          '@type': 'ListItem',
          position: 2,
          url: `https://winkey.vn/watch/${mockVideo2.id}`,
        },
      ]);

      const breadcrumbs = buildTagBreadcrumbSchema(mockTagPhimNgan);
      expect(breadcrumbs['@context']).toBe('https://schema.org');
      expect(breadcrumbs['@type']).toBe('BreadcrumbList');
      expect(breadcrumbs.itemListElement).toEqual([
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Winkey',
          item: 'https://winkey.vn',
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: '#Phim ngắn',
          item: 'https://winkey.vn/tag/phim-ngan',
        },
      ]);
    });

    it('escapes </script> in tag schema through jsonLd() and reconstructs cleanly upon JSON.parse', () => {
      const maliciousTag: TagSummary = {
        slug: 'xss-tag',
        name: '</script><script>alert(1)</script>',
        video_count: 3,
        latest_published_at: '2026-10-10T12:00:00Z',
      };

      const schema = buildTagCollectionPageSchema(
        maliciousTag,
        [mockVideo1],
        'Malicious tag description',
      );

      const serialized = jsonLd(schema);
      expect(serialized).not.toContain('</script>');
      expect(serialized).not.toContain('<script>');
      expect(serialized).toContain('\\u003c/script\\u003e');

      const parsed = JSON.parse(serialized);
      expect(parsed.name).toBe('#</script><script>alert(1)</script>');
    });
  });

  describe('4. Watch Page Tag Chips & VideoObject keywords', () => {
    it('renders tag chip links for valid slugs and plain text for empty slugs', () => {
      render(<WatchClientSection video={mockFullVideo} />);

      const chipsContainer = screen.getByTestId('watch-tag-chips');
      expect(chipsContainer).toBeTruthy();

      // Tag 0: 'Phim ngắn' -> slug 'phim-ngan' (Link)
      const chip0 = screen.getByTestId('watch-tag-chip-0');
      expect(chip0.tagName).toBe('A');
      expect(chip0.getAttribute('href')).toBe('/tag/phim-ngan');
      expect(chip0.textContent).toBe('#Phim ngắn');

      // Tag 1: 'Công nghệ' -> slug 'cong-nghe' (Link)
      const chip1 = screen.getByTestId('watch-tag-chip-1');
      expect(chip1.tagName).toBe('A');
      expect(chip1.getAttribute('href')).toBe('/tag/cong-nghe');
      expect(chip1.textContent).toBe('#Công nghệ');

      // Tag 2: 'Tag Không Link' -> slug '' (Plain text, no link)
      const chip2 = screen.getByTestId('watch-tag-chip-2');
      expect(chip2.tagName).toBe('SPAN');
      expect(chip2.closest('a')).toBeNull();
      expect(chip2.textContent).toBe('#Tag Không Link');
    });

    it('adds keywords: tags.join(", ") to VideoObject schema when tags are present', () => {
      const schemaWithTags = buildVideoObjectSchema(mockFullVideo);
      expect(schemaWithTags?.keywords).toBe('Phim ngắn, Công nghệ, Tag Không Link');

      const videoWithoutTags: Video = {
        ...mockFullVideo,
        tags: [],
        tag_slugs: [],
      };
      const schemaWithoutTags = buildVideoObjectSchema(videoWithoutTags);
      expect(schemaWithoutTags?.keywords).toBeUndefined();
    });
  });

  describe('5. Sitemap Tag URLs & min_videos=2 filter', () => {
    it('requests /v1/tags with min_videos=2 and limit=1000', async () => {
      let requestedUrl = '';
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        const tagList: TagList = {
          items: [mockTagPhimNgan],
        };
        return {
          ok: true,
          json: async () => tagList,
        } as Response;
      });

      const tags = await fetchTagsForSitemap('http://localhost:8080');
      expect(tags).toHaveLength(1);
      expect(tags[0].slug).toBe('phim-ngan');

      const parsedUrl = new URL(requestedUrl);
      expect(parsedUrl.pathname).toBe('/v1/tags');
      expect(parsedUrl.searchParams.get('min_videos')).toBe('2');
      expect(parsedUrl.searchParams.get('limit')).toBe('1000');
    });

    it('generates sitemap with tag URLs containing lastmod, daily changefreq, and 0.6 priority', () => {
      const xml = generateSitemapXml([mockVideo1], { tags: [mockTagPhimNgan] });

      expect(xml).toContain('<loc>https://winkey.vn/tag/phim-ngan</loc>');
      expect(xml).toContain(`<lastmod>${mockTagPhimNgan.latest_published_at}</lastmod>`);
      expect(xml).toContain('<changefreq>daily</changefreq>');
      expect(xml).toContain('<priority>0.6</priority>');
    });

    it('getCachedSitemapXml fetches both videos and tags for sitemap generation', async () => {
      let tagFetched = false;
      let videoFetched = false;

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags')) {
          tagFetched = true;
          return {
            ok: true,
            json: async () => ({ items: [mockTagPhimNgan] }),
          } as Response;
        }
        if (url.includes('/v1/videos')) {
          videoFetched = true;
          return {
            ok: true,
            json: async () => ({ items: [mockVideo1], next_cursor: null }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const xml = await getCachedSitemapXml('http://localhost:8080');
      expect(tagFetched).toBe(true);
      expect(videoFetched).toBe(true);
      expect(xml).toContain('<loc>https://winkey.vn/tag/phim-ngan</loc>');
      expect(xml).toContain(`<loc>https://winkey.vn/watch/${mockVideo1.id}</loc>`);
    });
  });
});
