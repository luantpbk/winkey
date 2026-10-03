import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoCard } from '../src/components/video/video-card';
import {
  RelatedVideoCard,
  RelatedVideosColumn,
} from '../src/components/video/related-videos-column';
import PlaylistPage from '../src/app/[locale]/playlist/[id]/page';
import { DEFAULT_THUMBNAIL_URL, getThumbnailUrl } from '../src/lib/constants';
import { api } from '../src/lib/api-client';
import type { VideoSummary, Playlist, PlaylistItem } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

vi.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const isVi = activeLocale === 'vi';
      if (key === 'views' && values && typeof values.count !== 'undefined') {
        const count = Number(values.count);
        return isVi ? `${count} lượt xem` : count === 1 ? '1 view' : `${count} views`;
      }
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = isVi ? viMessages : enMessages;
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

// --- Routing & Navigation Mock ---
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '0192f5e4-1000-7000-8000-000000000001', locale: 'vi' }),
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/playlist/0192f5e4-1000-7000-8000-000000000001',
}));

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/playlist/0192f5e4-1000-7000-8000-000000000001',
  Link: ({
    children,
    href,
    className,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// --- Toast Mock ---
const mockShowToast = vi.fn();
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// --- Auth Context Mock ---
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: {
      id: '0192f5e4-1000-7000-8000-000000000001',
      email: 'test@example.com',
      roles: ['user'],
    },
    isAuthenticated: true,
    isLoading: false,
    clearSession: vi.fn(),
    logout: vi.fn(),
  }),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 5 * 60 * 1000,
      },
    },
  });
}

function renderWithClient(ui: React.ReactElement, client = createTestQueryClient()) {
  return {
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
    client,
  };
}

describe('Issue #194: Local Thumbnail Placeholder fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('getThumbnailUrl helper', () => {
    it('returns the candidate if it is a valid non-empty string', () => {
      expect(getThumbnailUrl('https://cdn.winkey.vn/images/thumb.jpg')).toBe(
        'https://cdn.winkey.vn/images/thumb.jpg',
      );
    });

    it('falls back to DEFAULT_THUMBNAIL_URL if candidate is null or undefined', () => {
      expect(getThumbnailUrl(null)).toBe(DEFAULT_THUMBNAIL_URL);
      expect(getThumbnailUrl(undefined)).toBe(DEFAULT_THUMBNAIL_URL);
      expect(getThumbnailUrl()).toBe(DEFAULT_THUMBNAIL_URL);
    });

    it('falls back to DEFAULT_THUMBNAIL_URL if candidate is empty or whitespace', () => {
      expect(getThumbnailUrl('')).toBe(DEFAULT_THUMBNAIL_URL);
      expect(getThumbnailUrl('   ')).toBe(DEFAULT_THUMBNAIL_URL);
    });

    it('respects fallback priority among multiple candidates', () => {
      expect(getThumbnailUrl(null, 'https://cdn.winkey.vn/fallback.jpg')).toBe(
        'https://cdn.winkey.vn/fallback.jpg',
      );
      expect(getThumbnailUrl(null, undefined, '')).toBe(DEFAULT_THUMBNAIL_URL);
    });

    it('DEFAULT_THUMBNAIL_URL points to local asset and not an external host', () => {
      expect(DEFAULT_THUMBNAIL_URL).toBe('/placeholder-thumbnail.svg');
      expect(DEFAULT_THUMBNAIL_URL).not.toMatch(/^https?:\/\//);
      expect(DEFAULT_THUMBNAIL_URL).not.toContain('unsplash.com');
    });
  });

  describe('VideoCard thumbnail fallback', () => {
    const mockVideoSummary: VideoSummary = {
      id: '0192f5e4-7c1a-7b3e-9d2a-111111111111',
      title: 'Video with Null Thumbnail',
      owner: {
        id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
        display_name: 'Channel One',
        handle: 'channel1',
        avatar_url: 'https://example.com/avatar1.jpg',
      },
      duration_ms: 120000,
      view_count: 500,
      published_at: '2026-09-01T00:00:00Z',
      thumbnail_url: null as any,
    };

    it('when thumbnail_url is null, rendered <img src> points to local placeholder and no external host', () => {
      const { container } = renderWithClient(<VideoCard video={mockVideoSummary} />);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      const src = img?.getAttribute('src');

      expect(src).toBe(DEFAULT_THUMBNAIL_URL);
      expect(src).not.toMatch(/^https?:\/\//);
      expect(src).not.toContain('unsplash.com');
    });

    it('when thumbnail_url is empty string, rendered <img src> points to local placeholder', () => {
      const { container } = renderWithClient(
        <VideoCard video={{ ...mockVideoSummary, thumbnail_url: '' }} />,
      );
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      const src = img?.getAttribute('src');

      expect(src).toBe(DEFAULT_THUMBNAIL_URL);
      expect(src).not.toMatch(/^https?:\/\//);
    });

    it('when video provides a valid thumbnail_url, rendered <img src> uses that url', () => {
      const { container } = renderWithClient(
        <VideoCard
          video={{ ...mockVideoSummary, thumbnail_url: 'https://cdn.winkey.vn/valid-thumb.jpg' }}
        />,
      );
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://cdn.winkey.vn/valid-thumb.jpg');
    });
  });

  describe('RelatedVideoCard & RelatedVideosColumn thumbnail fallback', () => {
    const mockRelatedVideo: VideoSummary = {
      id: '0192f5e4-7c1a-7b3e-9d2a-222222222222',
      title: 'Related Video with Null Thumbnail',
      owner: {
        id: '0192f5e4-7c1a-7b3e-9d2a-c00000000002',
        display_name: 'Channel Two',
        handle: 'channel2',
        avatar_url: 'https://example.com/avatar2.jpg',
      },
      duration_ms: 180000,
      view_count: 1200,
      published_at: '2026-09-02T00:00:00Z',
      thumbnail_url: null as any,
    };

    it('when thumbnail_url is null on RelatedVideoCard, rendered <img src> points to local placeholder and no external host', () => {
      const { container } = renderWithClient(
        <RelatedVideoCard video={mockRelatedVideo} locale="vi" />,
      );
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      const src = img?.getAttribute('src');

      expect(src).toBe(DEFAULT_THUMBNAIL_URL);
      expect(src).not.toMatch(/^https?:\/\//);
      expect(src).not.toContain('unsplash.com');
    });

    it('when related videos list has null thumbnail_url, all rendered <img src> point to local placeholder', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: { items: [mockRelatedVideo] },
        response: new Response(null, { status: 200 }),
      } as any);

      const { container } = renderWithClient(
        <RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-555555555555" />,
      );

      await screen.findAllByTestId('related-video-card');
      const imgs = container.querySelectorAll('img');
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) {
        const src = img.getAttribute('src');
        expect(src).toBe(DEFAULT_THUMBNAIL_URL);
        expect(src).not.toMatch(/^https?:\/\//);
        expect(src).not.toContain('unsplash.com');
      }
    });
  });

  describe('PlaylistPage cover and item thumbnail fallback', () => {
    const mockPlaylist: Playlist = {
      id: '0192f5e4-1000-7000-8000-000000000001',
      title: 'Playlist with Null Thumbnail Videos',
      description: 'A test playlist',
      visibility: 'PUBLIC',
      owner: {
        id: '0192f5e4-1000-7000-8000-000000000001',
        handle: 'owner',
        display_name: 'Owner User',
        avatar_url: null,
      },
      kind: 'REGULAR',
      item_count: 1,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
    };

    const mockItem: PlaylistItem = {
      video_id: '0192f5e4-7c1a-7b3e-9d2a-333333333333',
      position: 1,
      added_at: '2026-09-01T00:00:00Z',
    };

    const mockVideoWithNullThumb: VideoSummary = {
      id: '0192f5e4-7c1a-7b3e-9d2a-333333333333',
      title: 'Playlist Item Video with Null Thumbnail',
      owner: {
        id: '0192f5e4-7c1a-7b3e-9d2a-c00000000003',
        display_name: 'Channel Three',
        handle: 'channel3',
        avatar_url: null,
      },
      duration_ms: 240000,
      view_count: 350,
      published_at: '2026-09-01T00:00:00Z',
      thumbnail_url: null as any,
    };

    it('when playlist videos have null thumbnail_url, cover and item images use local placeholder and no external host', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response(null, { status: 200 }) } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return {
            data: { items: [mockItem], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return {
            data: { items: [mockVideoWithNullThumb] },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      const { container } = renderWithClient(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByText('Playlist with Null Thumbnail Videos')).toBeDefined();
      });

      const imgs = container.querySelectorAll('img');
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) {
        const src = img.getAttribute('src');
        expect(src).toBe(DEFAULT_THUMBNAIL_URL);
        expect(src).not.toMatch(/^https?:\/\//);
        expect(src).not.toContain('unsplash.com');
      }
    });
  });
});
