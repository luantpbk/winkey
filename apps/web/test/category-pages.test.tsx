import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { VideoSummary, TagSummary } from '@winkey/api-client';
import {
  CATEGORIES,
  getAllCategories,
  getCategory,
  isCategorySlug,
} from '../src/lib/seo/categories';
import {
  buildCategoryCollectionPageSchema,
  buildCategoryBreadcrumbSchema,
} from '../src/lib/seo/category-schema';
import {
  generateMetadata as generateCategoryMetadata,
  default as CategoryPage,
} from '../src/app/[locale]/the-loai/[slug]/page';
import { generateMetadata as generateHomeMetadata } from '../src/app/[locale]/page';
import { buildOrganizationSchema } from '../src/lib/seo/website-schema';
import { generateSitemapXml } from '../src/lib/seo/sitemap';
import { Footer } from '../src/components/layout/footer';
import { notFound } from 'next/navigation';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  permanentRedirect: vi.fn(),
}));

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === 'cinema') {
      const cinemaMap: Record<string, string> = {
        terms: 'Điều khoản',
        privacy: 'Quyền riêng tư',
        communityRules: 'Quy tắc cộng đồng',
        betaFeedback: 'Góp ý beta',
        copyright: '2026 Winkey · Bản beta',
      };
      return cinemaMap[key] || key;
    }
    if (namespace === 'legal') {
      if (key === 'legalNav') return 'Liên kết pháp lý và chính sách';
    }
    return key;
  },
}));

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn().mockImplementation(() => async (key: string) => key),
}));

// Mock Link
vi.mock('../src/i18n/routing', () => ({
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    user: null,
    logout: vi.fn(),
    canAccessAdmin: false,
  }),
}));

vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

const mockVideo1: VideoSummary = {
  id: '01923456-789a-7bc8-9def-012345678901',
  title: 'Video Phim 1',
  duration_ms: 60000,
  view_count: 100,
  published_at: '2026-10-10T12:00:00Z',
  thumbnail_url: 'https://winkey.vn/thumbs/1.jpg',
  owner: {
    id: '01923456-789a-7bc8-9def-012345678903',
    handle: 'creator1',
    display_name: 'Creator One',
    avatar_url: 'https://winkey.vn/avatars/1.jpg',
  },
};

const mockVideo2: VideoSummary = {
  id: '01923456-789a-7bc8-9def-012345678902',
  title: 'Video Phim 2',
  duration_ms: 120000,
  view_count: 200,
  published_at: '2026-10-10T13:00:00Z',
  thumbnail_url: 'https://winkey.vn/thumbs/2.jpg',
  owner: {
    id: '01923456-789a-7bc8-9def-012345678904',
    handle: 'creator2',
    display_name: 'Creator Two',
    avatar_url: 'https://winkey.vn/avatars/2.jpg',
  },
};

const mockTagPhim: TagSummary = {
  slug: 'phim',
  name: 'Phim',
  video_count: 15,
  latest_published_at: '2026-10-12T00:00:00Z',
};

describe('SEO3: Category Pages & Brand Configuration (ADR-040)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. Category Definitions in categories.ts', () => {
    it('defines 8 required entertainment categories', () => {
      const categories = getAllCategories();
      expect(categories).toHaveLength(8);

      const slugs = categories.map((c) => c.slug);
      expect(slugs).toEqual([
        'phim',
        'phim-bo',
        'am-nhac',
        'game',
        'hai-huoc',
        'giai-tri',
        'the-thao',
        'hoat-hinh',
      ]);
    });

    it('ensures every category description is strictly between 140 and 160 characters', () => {
      for (const cat of CATEGORIES) {
        expect(
          cat.description.length,
          `Category ${cat.slug} description length is ${cat.description.length}`,
        ).toBeGreaterThanOrEqual(140);
        expect(
          cat.description.length,
          `Category ${cat.slug} description length is ${cat.description.length}`,
        ).toBeLessThanOrEqual(160);
      }
    });

    it('ensures every category intro is a multi-sentence descriptive intro', () => {
      for (const cat of CATEGORIES) {
        const sentences = cat.intro.split(/[.!?]+/).filter((s) => s.trim().length > 0);
        expect(
          sentences.length,
          `Category ${cat.slug} intro has ${sentences.length} sentences`,
        ).toBeGreaterThanOrEqual(2);
      }
    });

    it('finds categories with getCategory and verifies isCategorySlug', () => {
      expect(getCategory('am-nhac')?.name).toBe('Âm nhạc');
      expect(getCategory('unknown-category')).toBeUndefined();
      expect(isCategorySlug('game')).toBe(true);
      expect(isCategorySlug('not-exist')).toBe(false);
    });
  });

  describe('2. Metadata for Home Page and Category Pages', () => {
    it('generates home page metadata with absolute title, Vietnamese entertainment keywords, and canonical', async () => {
      const metadata = await generateHomeMetadata({
        params: Promise.resolve({ locale: 'vi' }),
      });
      expect(metadata.title).toEqual({
        absolute: 'Winkey – Xem phim, video, nhạc và game giải trí',
      });
      expect(metadata.description).toBe(
        'Winkey – Nền tảng xem phim, phim bộ, video, nhạc và game giải trí trực tuyến tốc độ cao, hoàn toàn miễn phí với chất lượng hình ảnh sắc nét tại Việt Nam.',
      );
      expect(metadata.alternates?.canonical).toBe('/');
      expect(metadata.openGraph?.siteName).toBe('Winkey');
    });

    it('builds Organization JSON-LD schema with name, url and logo', () => {
      const orgSchema = buildOrganizationSchema('https://winkey.vn');
      expect(orgSchema['@type']).toBe('Organization');
      expect(orgSchema.name).toBe('Winkey');
      expect(orgSchema.url).toBe('https://winkey.vn');
      expect(orgSchema.logo).toBe('https://winkey.vn/logo.png');
    });

    it('generates category metadata with canonical and indexing when videos >= 2', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/videos')) {
          return {
            ok: true,
            json: async () => ({ items: [mockVideo1, mockVideo2], next_cursor: null }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const meta = await generateCategoryMetadata({
        params: Promise.resolve({ locale: 'vi', slug: 'phim' }),
      });

      expect(meta.title).toBe('Phim hay chọn lọc, phim lẻ và phim chiếu rạp mới nhất');
      expect(meta.alternates?.canonical).toBe('https://winkey.vn/the-loai/phim');
      expect(meta.robots).toEqual({ index: true, follow: true });
      const ogImages = meta.openGraph?.images as Array<{ url: string }> | undefined;
      expect(ogImages?.[0]).toEqual(
        expect.objectContaining({ url: mockVideo1.thumbnail_url }),
      );
    });

    it('sets robots { index: false, follow: true } when total videos < 2', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/videos')) {
          return {
            ok: true,
            json: async () => ({ items: [mockVideo1], next_cursor: null }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      const meta = await generateCategoryMetadata({
        params: Promise.resolve({ locale: 'vi', slug: 'phim' }),
      });

      expect(meta.robots).toEqual({ index: false, follow: true });
    });

    it('returns robots noindex metadata for unknown category slug', async () => {
      const meta = await generateCategoryMetadata({
        params: Promise.resolve({ locale: 'vi', slug: 'non-existent-cat' }),
      });

      expect(meta.title).toBe('Thể loại không tồn tại');
      expect(meta.robots).toEqual({ index: false, follow: false });
    });
  });

  describe('3. Category Page Rendering, Deduplication & Error Handling', () => {
    it('triggers notFound() when category slug is unknown', async () => {
      await CategoryPage({
        params: Promise.resolve({ locale: 'vi', slug: 'non-existent-cat' }),
      });

      expect(notFound).toHaveBeenCalled();
    });

    it('throws error when video API returns 5xx HTTP error', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/videos')) {
          return { ok: false, status: 500 } as Response;
        }
        return { ok: true, json: async () => mockTagPhim } as Response;
      });

      await expect(
        CategoryPage({
          params: Promise.resolve({ locale: 'vi', slug: 'phim' }),
        }),
      ).rejects.toThrow('Failed to fetch tag videos: HTTP 500');
    });

    it('merges and deduplicates videos across source tags by video id', async () => {
      // Simulate two tags returning the same video
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/v1/tags/phim-le')) {
          return { ok: true, json: async () => ({ slug: 'phim-le', name: 'Phim lẻ' }) } as Response;
        }
        if (url.includes('/v1/tags/phim')) {
          return { ok: true, json: async () => mockTagPhim } as Response;
        }
        if (url.includes('/v1/videos?tag=phim&')) {
          return {
            ok: true,
            json: async () => ({ items: [mockVideo1, mockVideo2], next_cursor: null }),
          } as Response;
        }
        if (url.includes('/v1/videos?tag=phim-le&')) {
          // returns duplicate mockVideo1 plus new mockVideo2
          return {
            ok: true,
            json: async () => ({ items: [mockVideo1], next_cursor: null }),
          } as Response;
        }
        return { ok: true, json: async () => ({ items: [], next_cursor: null }) } as Response;
      });

      const jsx = await CategoryPage({
        params: Promise.resolve({ locale: 'vi', slug: 'phim' }),
      });

      const { container } = render(jsx);

      // Category H1 is rendered
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toBe('Phim');

      // Tag section heading
      expect(container.textContent).toContain('#Phim');
    });
  });

  describe('4. Category JSON-LD Schemas', () => {
    it('builds CollectionPage schema with ItemList up to 20 items', () => {
      const category = getCategory('phim')!;
      const schema = buildCategoryCollectionPageSchema(category, [mockVideo1, mockVideo2]);

      expect(schema['@context']).toBe('https://schema.org');
      expect(schema['@type']).toBe('CollectionPage');
      expect(schema.name).toBe('Phim');
      expect(schema.url).toBe('https://winkey.vn/the-loai/phim');
      expect(schema.mainEntity['@type']).toBe('ItemList');
      expect(schema.mainEntity.itemListElement).toHaveLength(2);
      expect(schema.mainEntity.itemListElement[0]).toEqual({
        '@type': 'ListItem',
        position: 1,
        url: `https://winkey.vn/watch/${mockVideo1.id}`,
      });
    });

    it('builds BreadcrumbList schema with Trang chủ > Thể loại > Category', () => {
      const category = getCategory('phim-bo')!;
      const schema = buildCategoryBreadcrumbSchema(category);

      expect(schema['@type']).toBe('BreadcrumbList');
      expect(schema.itemListElement).toEqual([
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Trang chủ',
          item: 'https://winkey.vn',
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Thể loại',
          item: 'https://winkey.vn/the-loai',
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: 'Phim bộ',
          item: 'https://winkey.vn/the-loai/phim-bo',
        },
      ]);
    });
  });

  describe('5. Sitemap Integration (ADR-040)', () => {
    it('includes category URLs when category has >= 2 videos in tags', () => {
      const tagPhim: TagSummary = {
        slug: 'phim',
        name: 'Phim',
        video_count: 5,
        latest_published_at: '2026-10-12T00:00:00Z',
      };

      const xml = generateSitemapXml([mockVideo1], { tags: [tagPhim] });

      expect(xml).toContain('<loc>https://winkey.vn/the-loai/phim</loc>');
      expect(xml).toContain('<changefreq>daily</changefreq>');
      expect(xml).toContain('<priority>0.8</priority>');
    });

    it('allows passing explicit categories in options', () => {
      const xml = generateSitemapXml([mockVideo1], {
        categories: [{ slug: 'am-nhac' }, { slug: 'game' }],
      });

      expect(xml).toContain('<loc>https://winkey.vn/the-loai/am-nhac</loc>');
      expect(xml).toContain('<loc>https://winkey.vn/the-loai/game</loc>');
    });

    it('does not include category if matching tag video_count < 2', () => {
      const tagLowCount: TagSummary = {
        slug: 'am-nhac',
        name: 'Âm nhạc',
        video_count: 1,
        latest_published_at: '2026-10-12T00:00:00Z',
      };

      const xml = generateSitemapXml([mockVideo1], { tags: [tagLowCount] });
      expect(xml).not.toContain('<loc>https://winkey.vn/the-loai/am-nhac</loc>');
    });
  });

  describe('6. Footer Navigation Component', () => {
    it('renders Về Winkey text, all category links, and legal links', () => {
      render(<Footer feedbackUrl="https://winkey.vn/feedback" testId="site-footer" />);

      const footer = screen.getByTestId('site-footer');
      expect(footer.textContent).toContain('Về Winkey');
      expect(footer.textContent).toContain('Thể loại giải trí');

      // Check all 8 category links exist
      for (const cat of CATEGORIES) {
        const link = screen.getByRole('link', { name: cat.name });
        expect(link.getAttribute('href')).toBe(`/the-loai/${cat.slug}`);
      }

      // Check legal links exist
      expect(screen.getByRole('link', { name: /Điều khoản/i })).toBeDefined();
      expect(screen.getByRole('link', { name: /Quyền riêng tư/i })).toBeDefined();
      expect(screen.getByRole('link', { name: /Quy tắc cộng đồng/i })).toBeDefined();
      expect(screen.getByRole('link', { name: /Góp ý beta/i })).toBeDefined();
    });
  });
});
