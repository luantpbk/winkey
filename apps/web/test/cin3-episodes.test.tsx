import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '../src/components/ui/toast';
import { WatchLayout } from '../src/components/watch/watch-layout';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/lib/api-client';
import type {
  Video,
  SeriesEpisodeContext,
  SeriesEpisode,
  VideoSummary,
  SeriesSummary,
} from '@winkey/api-client';
import viMessages from '../messages/vi.json';

// --- Mock Hls.js ---
vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
  const HlsMock = vi.fn().mockImplementation(() => ({
    loadSource: vi.fn(),
    attachMedia: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    destroy: vi.fn(),
    startLoad: vi.fn(),
    currentLevel: -1,
    levels: [],
  }));
  (HlsMock as any).isSupported = isSupportedMock;
  (HlsMock as any).Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
  };
  (HlsMock as any).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };
  return { default: HlsMock, __esModule: true };
});

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
          for (const [k, v] of Object.entries(values)) {
            res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return res;
      }
      return key;
    };
  },
  useLocale: () => 'vi',
}));

// --- Router & SearchParams Mock ---
const mockPush = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/watch/ep-1',
}));

vi.mock('../src/i18n/routing', () => ({
  routing: { locales: ['vi', 'en'], defaultLocale: 'vi' },
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/watch/ep-1',
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

const mockVideo1: Video = {
  id: 'ep-1',
  title: 'Thiên Cơ Biến - Tập 1',
  description: 'Mô tả tập 1',
  status: 'READY',
  visibility: 'PUBLIC',
  duration_ms: 2700000,
  width: 1920,
  height: 1080,
  created_at: new Date().toISOString(),
  view_count: 50000,
  like_count: 2500,
  published_at: new Date().toISOString(),
  owner: {
    id: 'usr-ch-1',
    handle: 'thien-co',
    display_name: 'Thiên Cơ Official',
    avatar_url: null,
  },
  playback: {
    hls_url: 'https://cdn.winkey.vn/hls/ep-1/master.m3u8',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-1.jpg',
    renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
  },
};

const mockSeriesSummary: SeriesSummary = {
  playlist_id: 'pl-series-thien-co',
  title: 'Thiên Cơ Biến',
  description: 'Bộ phim bom tấn cổ trang',
  owner: mockVideo1.owner,
  episode_count: 3,
  first_video_id: 'ep-1',
  updated_at: new Date().toISOString(),
};

const mockContextEp1: SeriesEpisodeContext = {
  series: mockSeriesSummary,
  episode_number: 1,
  previous_video_id: null,
  next_video_id: 'ep-2',
  page_cursor: null,
};

const mockEpisodesList: SeriesEpisode[] = [
  { episode_number: 1, video_id: 'ep-1' },
  { episode_number: 2, video_id: 'ep-2' },
  { episode_number: 3, video_id: 'ep-3' },
];

const mockBatchVideos: VideoSummary[] = [
  {
    id: 'ep-1',
    title: 'Thiên Cơ Biến - Tập 1',
    duration_ms: 2700000,
    view_count: 50000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-1.jpg',
    owner: mockVideo1.owner,
  },
  {
    id: 'ep-2',
    title: 'Thiên Cơ Biến - Tập 2',
    duration_ms: 2750000,
    view_count: 35000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-2.jpg',
    owner: mockVideo1.owner,
  },
  {
    id: 'ep-3',
    title: 'Thiên Cơ Biến - Tập 3',
    duration_ms: 2800000,
    view_count: 30000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-3.jpg',
    owner: mockVideo1.owner,
  },
];

describe('CIN3: Automatic Series Context & Next-Episode Autoplay (ADR-045)', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    currentSearch = '';
    window.history.pushState(null, '', '/watch/ep-1');
    replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. No Series -> Keep Related Videos Column, No replaceState
  // =========================================================================
  it('falls back to related column when video belongs to no series (items is empty)', async () => {
    vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/series') {
        return { data: { items: [] }, response: new Response() } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/videos/{video_id}/related') {
        return { data: { items: [] }, response: new Response() } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    renderWithProviders(<WatchLayout video={mockVideo1} />);

    // Wait for resolution
    await waitFor(() => {
      expect(screen.queryByTestId('series-navigation-bar')).toBeNull();
    });

    // Related videos column should be rendered
    expect(screen.getByTestId('related-videos-column')).toBeDefined();
    // Series episodes column should NOT be rendered
    expect(screen.queryByTestId('series-episodes-column')).toBeNull();
    // replaceState should NOT be called to add ?playlist=
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 2. Automatic Series Resolution -> replaceState & Episode List
  // =========================================================================
  it('automatically resolves series from video_id, updates URL with replaceState, and renders episode list', async () => {
    vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/series') {
        return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
      }
      if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
        return { data: mockContextEp1, response: new Response() } as any;
      }
      if (path === '/v1/series/{playlist_id}/episodes') {
        return {
          data: { items: mockEpisodesList, next_cursor: null },
          response: new Response(),
        } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/videos/batch') {
        return { data: { items: mockBatchVideos }, response: new Response() } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    renderWithProviders(<WatchLayout video={mockVideo1} />);

    // Wait for series navigation bar and replaceState
    await waitFor(() => {
      expect(screen.getByTestId('series-navigation-bar')).toBeDefined();
    });

    // Verify replaceState was called with ?playlist=pl-series-thien-co
    expect(replaceStateSpy).toHaveBeenCalled();
    const lastCall = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
    expect(lastCall[2]).toContain('playlist=pl-series-thien-co');

    // Verify desktop episode column and navigation bar
    expect(screen.getByTestId('series-episodes-column')).toBeDefined();
    expect(screen.getAllByText('Thiên Cơ Biến').length).toBeGreaterThan(0);

    // Verify mobile episode list is present under action row
    const mobileList = screen.getByTestId('series-mobile-episodes-list');
    expect(mobileList).toBeDefined();

    // Verify active episode item is highlighted
    await waitFor(() => {
      const activeEpisodes = screen.getAllByTestId('active-series-episode');
      expect(activeEpisodes.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Mobile Collapsible Episode List Toggle
  // =========================================================================
  it('toggles mobile episode list open and closed via collapsible header', async () => {
    vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/series') {
        return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
      }
      if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
        return { data: mockContextEp1, response: new Response() } as any;
      }
      if (path === '/v1/series/{playlist_id}/episodes') {
        return {
          data: { items: mockEpisodesList, next_cursor: null },
          response: new Response(),
        } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
      if (path === '/v1/videos/batch') {
        return { data: { items: mockBatchVideos }, response: new Response() } as any;
      }
      return { data: null, response: new Response() } as any;
    });

    renderWithProviders(<WatchLayout video={mockVideo1} />);

    await waitFor(() => {
      expect(screen.getByTestId('series-mobile-episodes-toggle')).toBeDefined();
    });

    const toggleBtn = screen.getByTestId('series-mobile-episodes-toggle');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    // Click toggle to collapse
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

    // Click toggle to expand again
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
  });

  // =========================================================================
  // 4. Autoplay Next Episode Countdown Overlay & Cancellation
  // =========================================================================
  describe('Autoplay Next Episode', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows 5-second countdown on episode end, decrements, and cancels when clicking Huỷ', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series') {
          return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockContextEp1, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} />);

      // Advance promises for initial fetch
      await act(async () => {
        await Promise.resolve();
      });

      // Find the HTML5 video element and simulate "ended" event
      const videoEl = document.querySelector('video');
      expect(videoEl).toBeDefined();

      act(() => {
        fireEvent.ended(videoEl!);
      });

      // Countdown overlay should appear with "5s"
      expect(screen.getByTestId('autoplay-next-countdown-overlay')).toBeDefined();
      expect(screen.getByTestId('autoplay-countdown-seconds').textContent).toBe('5s');

      // Advance timer by 1 second -> "4s"
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('autoplay-countdown-seconds').textContent).toBe('4s');

      // Click "Huỷ" button
      const cancelBtn = screen.getByTestId('cancel-autoplay-btn');
      act(() => {
        fireEvent.click(cancelBtn);
      });

      // Overlay should be dismissed
      expect(screen.queryByTestId('autoplay-next-countdown-overlay')).toBeNull();

      // Advancing further should not trigger navigation
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('automatically navigates to next episode when countdown reaches 0', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series') {
          return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockContextEp1, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} />);

      await act(async () => {
        await Promise.resolve();
      });

      const videoEl = document.querySelector('video');
      act(() => {
        fireEvent.ended(videoEl!);
      });

      expect(screen.getByTestId('autoplay-next-countdown-overlay')).toBeDefined();

      // Step through 5 seconds (5 x 1000ms) to allow React re-renders between each timer tick
      for (let i = 0; i < 5; i++) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }

      // Navigation should be triggered to episode 2
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringMatching(/\/watch\/ep-2\?playlist=pl-series-thien-co&src=playlist/),
      );
    });

    it('navigates immediately when user clicks "Phát ngay"', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series') {
          return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockContextEp1, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} />);

      await act(async () => {
        await Promise.resolve();
      });

      const videoEl = document.querySelector('video');
      act(() => {
        fireEvent.ended(videoEl!);
      });

      const playNowBtn = screen.getByTestId('play-next-now-btn');
      act(() => {
        fireEvent.click(playNowBtn);
      });

      expect(mockPush).toHaveBeenCalledWith(
        expect.stringMatching(/\/watch\/ep-2\?playlist=pl-series-thien-co&src=playlist/),
      );
      expect(screen.queryByTestId('autoplay-next-countdown-overlay')).toBeNull();
    });

    it('respects localStorage opt-out (winkey.autoplay_next_episode = "false")', async () => {
      localStorage.setItem('winkey.autoplay_next_episode', 'false');

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series') {
          return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockContextEp1, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} />);

      await act(async () => {
        await Promise.resolve();
      });

      const videoEl = document.querySelector('video');
      act(() => {
        fireEvent.ended(videoEl!);
      });

      // No countdown overlay should be shown
      expect(screen.queryByTestId('autoplay-next-countdown-overlay')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('does not trigger autoplay when current episode has no next_video_id', async () => {
      const mockLastEpContext: SeriesEpisodeContext = {
        series: mockSeriesSummary,
        episode_number: 3,
        previous_video_id: 'ep-2',
        next_video_id: null,
        page_cursor: null,
      };

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series') {
          return { data: { items: [mockSeriesSummary] }, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockLastEpContext, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} />);

      await act(async () => {
        await Promise.resolve();
      });

      const videoEl = document.querySelector('video');
      act(() => {
        fireEvent.ended(videoEl!);
      });

      // No countdown overlay should be shown for the last episode
      expect(screen.queryByTestId('autoplay-next-countdown-overlay')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
