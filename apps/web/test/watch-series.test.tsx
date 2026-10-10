import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '../src/components/ui/toast';
import { WatchLayout } from '../src/components/watch/watch-layout';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/lib/api-client';
import type { Video, SeriesEpisodeContext, SeriesEpisode, VideoSummary } from '@winkey/api-client';
import viMessages from '../messages/vi.json';

// --- Tracker Mock for Heartbeat Session Order Testing ---
let trackerEvents: Array<{ videoId: string; event: 'start' | 'end'; surface?: string }> = [];

vi.mock('../src/lib/video/playback-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/video/playback-tracker')>();
  return {
    ...actual,
    PlaybackTracker: class extends actual.PlaybackTracker {
      constructor(options: any) {
        super(options);
      }
      recordPlaying(pos: number) {
        trackerEvents.push({ videoId: this.videoId, event: 'start', surface: this.surface });
        super.recordPlaying(pos);
      }
      destroy() {
        trackerEvents.push({ videoId: this.videoId, event: 'end', surface: this.surface });
        super.destroy();
      }
    },
  };
});

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
let currentSearch = '?playlist=pl-series-1';

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
  title: 'Tập 1: Mở Đầu',
  description: 'Mô tả tập 1',
  status: 'READY',
  visibility: 'PUBLIC',
  duration_ms: 3600000,
  width: 1920,
  height: 1080,
  created_at: new Date().toISOString(),
  view_count: 12000,
  like_count: 500,
  published_at: new Date().toISOString(),
  owner: {
    id: 'usr-ch-1',
    handle: 'channel1',
    display_name: 'Channel 1',
    avatar_url: null,
  },
  playback: {
    hls_url: 'https://cdn.winkey.vn/hls/ep-1/master.m3u8',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-1.jpg',
    renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
  },
};

const mockVideo2: Video = {
  id: 'ep-2',
  title: 'Tập 2: Diễn Biến',
  description: 'Mô tả tập 2',
  status: 'READY',
  visibility: 'PUBLIC',
  duration_ms: 3600000,
  width: 1920,
  height: 1080,
  created_at: new Date().toISOString(),
  view_count: 9000,
  like_count: 400,
  published_at: new Date().toISOString(),
  owner: mockVideo1.owner,
  playback: {
    hls_url: 'https://cdn.winkey.vn/hls/ep-2/master.m3u8',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-2.jpg',
    renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
  },
};

const mockContextEp1: SeriesEpisodeContext = {
  series: {
    playlist_id: 'pl-series-1',
    title: 'Phim Bộ Thử Nghiệm',
    description: 'Mô tả bộ phim',
    owner: mockVideo1.owner,
    episode_count: 3,
    first_video_id: 'ep-1',
    updated_at: new Date().toISOString(),
  },
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
    title: 'Tập 1: Mở Đầu',
    duration_ms: 3600000,
    view_count: 12000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-1.jpg',
    owner: mockVideo1.owner,
  },
  {
    id: 'ep-2',
    title: 'Tập 2: Diễn Biến',
    duration_ms: 3600000,
    view_count: 9000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-2.jpg',
    owner: mockVideo1.owner,
  },
  {
    id: 'ep-3',
    title: 'Tập 3: Kết Thúc',
    duration_ms: 3600000,
    view_count: 8000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/ep-3.jpg',
    owner: mockVideo1.owner,
  },
];

describe('CIN2-web: Watch Page with Series Context (ADR-035)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackerEvents = [];
    currentSearch = '?playlist=pl-series-1';
    window.history.pushState(null, '', '/watch/ep-1?playlist=pl-series-1');

    // Mock scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Series Context (200): Episode column, highlight, prev/next buttons
  // =========================================================================
  describe('1. Series Context on 200', () => {
    it('renders series navigation bar, desktop episode column, highlights active episode', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
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

      renderWithProviders(<WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />);

      // Verify series navigation bar is displayed
      await waitFor(() => {
        expect(screen.getByTestId('series-navigation-bar')).toBeDefined();
      });

      // Verify desktop episode column is displayed
      expect(screen.getByTestId('series-episodes-column')).toBeDefined();

      // Verify mobile episode list is rendered
      expect(screen.getByTestId('series-mobile-episodes-list')).toBeDefined();

      // Verify active episode highlight
      await waitFor(() => {
        const activeItems = screen.getAllByTestId('active-series-episode');
        expect(activeItems.length).toBeGreaterThan(0);
      });

      // Verify scrollIntoView was called for active item
      await waitFor(() => {
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      });

      // Verify Previous is disabled on episode 1, Next is enabled
      const prevBtn = screen.getByTestId('series-prev-episode-btn') as HTMLButtonElement;
      const nextBtn = screen.getByTestId('series-next-episode-btn') as HTMLButtonElement;
      expect(prevBtn.disabled).toBe(true);
      expect(nextBtn.disabled).toBe(false);

      // Clicking Next triggers router push to episode 2 with ?playlist= and src=playlist
      fireEvent.click(nextBtn);
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringMatching(/\/watch\/ep-2\?playlist=pl-series-1&src=playlist/),
      );
    });

    it('supports N and P keyboard shortcuts when focus is not in an input', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
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

      renderWithProviders(<WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />);

      await waitFor(() => {
        expect(screen.getByTestId('series-navigation-bar')).toBeDefined();
      });

      // Press 'N' -> navigates to next episode
      fireEvent.keyDown(window, { key: 'n' });
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringMatching(/\/watch\/ep-2\?playlist=pl-series-1&src=playlist/),
      );

      mockPush.mockClear();

      // If focus is in an input, pressing 'N' does NOT navigate
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      fireEvent.keyDown(input, { key: 'n' });
      expect(mockPush).not.toHaveBeenCalled();

      document.body.removeChild(input);
    });
  });

  // =========================================================================
  // 2. 404 vs 5xx / Network Error: 404 strips playlist, 5xx / network keeps it
  // =========================================================================
  describe('2. 404 Fallback vs 5xx / Network Errors', () => {
    it('strips playlist from address bar with replaceState on 404 and renders normal watch page', async () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return {
            error: { code: 'EPISODE_NOT_FOUND', title: 'Episode not found' },
            response: new Response(null, { status: 404 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/{video_id}/related') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />);

      // Verify replaceState was called to strip playlist
      await waitFor(() => {
        expect(replaceStateSpy).toHaveBeenCalled();
        const urlArg = replaceStateSpy.mock.lastCall?.[2];
        expect(urlArg).not.toContain('playlist=');
      });

      // Series navigation and series episode column are NOT shown
      expect(screen.queryByTestId('series-navigation-bar')).toBeNull();
      expect(screen.queryByTestId('series-episodes-column')).toBeNull();

      // Normal related videos column is shown instead
      await waitFor(() => {
        expect(screen.getByTestId('related-videos-column')).toBeDefined();
      });
    });

    it('keeps playlist in address bar on 503 (5xx) while hiding series UI and playing video', async () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return {
            error: { code: 'SERVICE_UNAVAILABLE', title: 'Service Unavailable' },
            response: new Response(null, { status: 503 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/{video_id}/related') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />);

      // Video title is rendered (video still plays)
      expect(screen.getByRole('heading', { level: 1, name: mockVideo1.title })).toBeDefined();

      // Series navigation and series episode column are hidden, related videos shown
      await waitFor(() => {
        expect(screen.getByTestId('related-videos-column')).toBeDefined();
      });
      expect(screen.queryByTestId('series-navigation-bar')).toBeNull();
      expect(screen.queryByTestId('series-episodes-column')).toBeNull();

      // replaceState was NOT called to remove playlist, address bar retains ?playlist=
      expect(replaceStateSpy).not.toHaveBeenCalled();
      expect(window.location.search).toContain('playlist=pl-series-1');
    });

    it('keeps playlist in address bar on network failure while hiding series UI and playing video', async () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          throw new Error('Network error: failed to fetch');
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/{video_id}/related') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />);

      await waitFor(() => {
        expect(screen.getByTestId('related-videos-column')).toBeDefined();
      });
      expect(screen.queryByTestId('series-navigation-bar')).toBeNull();
      expect(screen.queryByTestId('series-episodes-column')).toBeNull();

      // replaceState was NOT called to remove playlist
      expect(replaceStateSpy).not.toHaveBeenCalled();
      expect(window.location.search).toContain('playlist=pl-series-1');
    });
  });

  // =========================================================================
  // 3. Heartbeat Order: End-then-start session order on episode switch
  // =========================================================================
  describe('3. Heartbeat Order & Session Switch', () => {
    it('ends old session (heartbeat end) before starting new session and never auto-plays', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
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

      // Render episode 1
      const { rerender } = renderWithProviders(
        <WatchLayout video={mockVideo1} initialPlaylistId="pl-series-1" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('series-navigation-bar')).toBeDefined();
      });

      // Verify video element exists and does NOT auto-play
      const videoEl = document.querySelector('video');
      expect(videoEl).toBeDefined();
      expect(videoEl?.autoplay).toBe(false);

      // Simulate play started on episode 1
      if (videoEl) {
        act(() => {
          fireEvent.loadedData(videoEl);
          fireEvent.playing(videoEl);
        });
      }

      // Verify start event for ep-1
      expect(trackerEvents.some((c) => c.videoId === 'ep-1' && c.event === 'start')).toBe(true);

      // Now switch episode to ep-2 (new video prop rendered with new key)
      const mockContextEp2: SeriesEpisodeContext = {
        ...mockContextEp1,
        episode_number: 2,
        previous_video_id: 'ep-1',
        next_video_id: 'ep-3',
      };

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/series/{playlist_id}/episodes/{video_id}') {
          return { data: mockContextEp2, response: new Response() } as any;
        }
        if (path === '/v1/series/{playlist_id}/episodes') {
          return {
            data: { items: mockEpisodesList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      act(() => {
        rerender(
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
          >
            <ToastProvider>
              <WatchLayout video={mockVideo2} initialPlaylistId="pl-series-1" />
            </ToastProvider>
          </QueryClientProvider>,
        );
      });

      // The unmount of ep-1 player must flush 'end' event
      expect(trackerEvents.some((c) => c.videoId === 'ep-1' && c.event === 'end')).toBe(true);

      // ep-2 player should not start until user explicitly plays
      const newVideoEl = document.querySelector('video');
      expect(newVideoEl?.autoplay).toBe(false);
      expect(trackerEvents.some((c) => c.videoId === 'ep-2' && c.event === 'start')).toBe(false);

      // User now plays ep-2
      if (newVideoEl) {
        act(() => {
          fireEvent.loadedData(newVideoEl);
          fireEvent.playing(newVideoEl);
        });
      }

      // Verify ep-2 start event
      expect(trackerEvents.some((c) => c.videoId === 'ep-2' && c.event === 'start')).toBe(true);

      // Check the exact sequence: ep-1 start -> ep-1 end -> ep-2 start
      const ep1EndIndex = trackerEvents.findIndex((c) => c.videoId === 'ep-1' && c.event === 'end');
      const ep2StartIndex = trackerEvents.findIndex(
        (c) => c.videoId === 'ep-2' && c.event === 'start',
      );

      expect(ep1EndIndex).toBeGreaterThan(-1);
      expect(ep2StartIndex).toBeGreaterThan(ep1EndIndex);
    });
  });
});
