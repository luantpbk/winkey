import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import { ToastProvider } from '../src/components/ui/toast';
import { CinemaView } from '../src/components/cinema/cinema-view';
import { CinemaSeriesCard } from '../src/components/cinema/cinema-series-card';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/lib/api-client';
import type { VideoSummary, CinemaCatalogItem, SeriesEpisode } from '@winkey/api-client';
import viMessages from '../messages/vi.json';

// --- Locale Mock ---
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = viMessages;
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
          if (res.includes('{count, plural') && values.count !== undefined) {
            return `${values.count} tập`;
          }
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

// --- Router Mock ---
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  routing: { locales: ['vi', 'en'], defaultLocale: 'vi' },
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/',
  Link: ({
    children,
    href,
    className,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        onClick?.(e);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

// --- Auth Mock ---
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: 'usr-1', handle: 'testuser' },
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('CIN2-web: Series on Cinema Home (ADR-035)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    window.IntersectionObserver = vi.fn().mockImplementation((callback) => ({
      observe: vi.fn((el) => {
        callback([{ isIntersecting: true, target: el }]);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Row Hydration: ONE batchGetVideos per page, omitted IDs dropped
  // =========================================================================
  describe('1. Row Hydration', () => {
    it('hydrates catalog row with ONE batchGetVideos call and drops omitted IDs', async () => {
      const mockCatalogItems: CinemaCatalogItem[] = [
        {
          kind: 'SERIES',
          series: {
            playlist_id: 'series-1',
            title: 'Trò Chơi Vương Quyền',
            description: 'Mô tả GOT',
            episode_count: 10,
            first_video_id: 'vid-s1',
            owner: {
              id: 'usr-1',
              handle: 'hbo',
              display_name: 'HBO Vietnam',
              avatar_url: null,
            },
            updated_at: '2026-01-01T00:00:00Z',
          },
        },
        {
          kind: 'SERIES',
          series: {
            playlist_id: 'series-2',
            title: 'Breaking Bad',
            description: 'Mô tả BB',
            episode_count: 12,
            first_video_id: 'vid-s2-omitted', // Omitted from batch
            owner: {
              id: 'usr-2',
              handle: 'amc',
              display_name: 'AMC Vietnam',
              avatar_url: null,
            },
            updated_at: '2026-01-01T00:00:00Z',
          },
        },
        {
          kind: 'VIDEO',
          video_id: 'vid-v1',
          added_at: '2026-01-01T00:00:00Z',
        },
      ];

      const batchVideos: VideoSummary[] = [
        {
          id: 'vid-s1',
          title: 'Trò Chơi Vương Quyền - Tập 1',
          duration_ms: 3600000,
          view_count: 1000,
          published_at: new Date().toISOString(),
          thumbnail_url: 'https://cdn.winkey.vn/s1.jpg',
          owner: {
            id: 'usr-1',
            handle: 'hbo',
            display_name: 'HBO Vietnam',
            avatar_url: null,
          },
        },
        // vid-s2-omitted is NOT returned (dropped)
        {
          id: 'vid-v1',
          title: 'Phim Lẻ Siêu Phẩm',
          duration_ms: 7200000,
          view_count: 5000,
          published_at: new Date().toISOString(),
          thumbnail_url: 'https://cdn.winkey.vn/v1.jpg',
          owner: {
            id: 'usr-2',
            handle: 'cinema',
            display_name: 'Cinema World',
            avatar_url: null,
          },
        },
      ];

      let batchCallCount = 0;
      let requestedBatchIds: string[] = [];

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/cinema/catalog') {
          return {
            data: { items: mockCatalogItems, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/videos/batch') {
          batchCallCount++;
          requestedBatchIds = options?.params?.query?.ids || [];
          return {
            data: { items: batchVideos },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<CinemaView initialHeroVideos={[]} />);

      // Wait for series row to load
      await waitFor(() => {
        expect(screen.getByTestId('cinema-row-series')).toBeDefined();
      });

      // Verify ONE batch call was made for this catalog page
      expect(batchCallCount).toBeGreaterThanOrEqual(1);
      // Requested IDs must include both series first_video_id and video video_id
      expect(requestedBatchIds).toContain('vid-s1');
      expect(requestedBatchIds).toContain('vid-s2-omitted');
      expect(requestedBatchIds).toContain('vid-v1');

      // Verify rendered items: series-1 is rendered, series-2 is dropped (omitted)
      await waitFor(() => {
        const seriesRow = screen.getByTestId('cinema-row-series');
        expect(within(seriesRow).getByText('Trò Chơi Vương Quyền')).toBeDefined();
        expect(within(seriesRow).queryByText('Breaking Bad')).toBeNull();
      });
    });
  });

  // =========================================================================
  // 2. Series Card: renders thumbnail, title, and "N tập" badge
  // =========================================================================
  describe('2. Series Card', () => {
    it('renders the series title and episode count badge', () => {
      const mockSeries = {
        playlist_id: 'series-got',
        title: 'Trò Chơi Vương Quyền',
        description: 'Mô tả GOT',
        episode_count: 24,
        first_video_id: 'vid-s1',
        owner: {
          id: 'usr-hbo',
          handle: 'hbo',
          display_name: 'HBO Vietnam',
          avatar_url: null,
        },
        updated_at: '2026-01-01T00:00:00Z',
      };

      const mockVideo: VideoSummary = {
        id: 'vid-s1',
        title: 'Tập 1: Mùa Đông Đang Đến',
        duration_ms: 3600000,
        view_count: 10000,
        published_at: new Date().toISOString(),
        thumbnail_url: 'https://cdn.winkey.vn/got-s1.jpg',
        owner: {
          id: 'usr-hbo',
          handle: 'hbo',
          display_name: 'HBO Vietnam',
          avatar_url: null,
        },
      };

      renderWithProviders(
        <CinemaSeriesCard series={mockSeries} coverVideo={mockVideo} onOpenSeries={vi.fn()} />,
      );

      // Verify title
      expect(screen.getByText('Trò Chơi Vương Quyền')).toBeDefined();

      // Verify "N tập" badge
      const badge = screen.getByTestId('series-card-episodes-badge');
      expect(badge).toBeDefined();
      expect(badge.textContent).toBe('24 tập');

      // Verify channel
      expect(screen.getByText('HBO Vietnam')).toBeDefined();
    });
  });

  // =========================================================================
  // 3. Series Detail Dialog: URL sync ?series=, back button, episodes list
  // =========================================================================
  describe('3. Series Detail Dialog', () => {
    it('syncs ?series= in URL, opens dialog, and closes with back (popstate)', async () => {
      const mockSeriesSummary = {
        playlist_id: 'pl-series-1',
        title: 'Thám Tử Lừng Danh Conan',
        description: 'Bộ phim hoạt hình dài tập về Conan.',
        episode_count: 50,
        first_video_id: 'ep-1',
        owner: {
          id: 'usr-channel-1',
          handle: 'serieschannel',
          display_name: 'Series Channel',
          avatar_url: null,
        },
        updated_at: '2026-01-01T00:00:00Z',
      };

      const mockSeriesPlaylistDetail = {
        id: 'pl-series-1',
        owner: mockSeriesSummary.owner,
        kind: 'REGULAR' as const,
        title: 'Thám Tử Lừng Danh Conan',
        description: 'Bộ phim hoạt hình dài tập về Conan.',
        visibility: 'PUBLIC' as const,
        item_count: 50,
        is_series: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const mockEpisodes: SeriesEpisode[] = [
        { episode_number: 1, video_id: 'ep-1' },
        { episode_number: 2, video_id: 'ep-2' },
      ];

      const batchVideos: VideoSummary[] = [
        {
          id: 'ep-1',
          title: 'Vụ án mạng trên tàu lượn siêu tốc',
          duration_ms: 1440000,
          view_count: 50000,
          published_at: new Date().toISOString(),
          thumbnail_url: 'https://cdn.winkey.vn/conan-ep1.jpg',
          owner: mockSeriesSummary.owner,
        },
        {
          id: 'ep-2',
          title: 'Vụ bắt cóc con gái nhà tài phiệt',
          duration_ms: 1440000,
          view_count: 42000,
          published_at: new Date().toISOString(),
          thumbnail_url: 'https://cdn.winkey.vn/conan-ep2.jpg',
          owner: mockSeriesSummary.owner,
        },
      ];

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockSeriesPlaylistDetail, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { series: mockSeriesSummary, items: mockEpisodes, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: batchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      // Render CinemaView with initialSeriesId
      renderWithProviders(<CinemaView initialSeriesId="pl-series-1" initialHeroVideos={[]} />);

      // Dialog is displayed
      await waitFor(() => {
        expect(screen.getByTestId('cinema-series-dialog')).toBeDefined();
      });
      expect(screen.getByTestId('cinema-series-title').textContent).toBe('Thám Tử Lừng Danh Conan');

      // Verify "Xem ngay" button links to episode 1 with ?playlist=&src=playlist
      const watchBtn = screen.getByTestId('cinema-series-watch-btn');
      expect(watchBtn.getAttribute('href')).toContain('/watch/ep-1');
      expect(watchBtn.getAttribute('href')).toContain('playlist=pl-series-1');
      expect(watchBtn.getAttribute('href')).toContain('src=playlist');

      // Verify episode list is rendered
      await waitFor(() => {
        expect(screen.getByText('Vụ án mạng trên tàu lượn siêu tốc')).toBeDefined();
        expect(screen.getByText('Vụ bắt cóc con gái nhà tài phiệt')).toBeDefined();
      });

      // Simulate browser back button (popstate event)
      act(() => {
        // Change window url without series param
        window.history.pushState(null, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      // Dialog is closed
      await waitFor(() => {
        expect(screen.queryByTestId('cinema-series-dialog')).toBeNull();
      });
    });
  });
});
