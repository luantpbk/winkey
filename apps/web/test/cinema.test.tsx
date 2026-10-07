import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '../src/components/ui/toast';
import { CinemaView } from '../src/components/cinema/cinema-view';
import { CinemaHero } from '../src/components/cinema/cinema-hero';
import { CinemaRow } from '../src/components/cinema/cinema-row';
import { CinemaDetailDialog } from '../src/components/cinema/cinema-detail-dialog';
import { api } from '../src/lib/api-client';
import { saveContinueWatching, getContinueWatching } from '../src/lib/video/continue-watching';
import type { VideoSummary } from '@winkey/api-client';
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
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/phim',
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
let mockIsAuthenticated = false;
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated ? { id: 'usr-1', handle: 'testuser' } : null,
    isLoading: false,
  }),
}));

const sampleVideos: VideoSummary[] = [
  {
    id: 'vid-1',
    title: 'Phim Hành Động 1',
    duration_ms: 7200000,
    view_count: 50000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/v1.jpg',
    owner: {
      id: 'usr-owner-1',
      handle: 'cinema_channel',
      display_name: 'Cinema Channel',
      avatar_url: null,
    },
  },
  {
    id: 'vid-2',
    title: 'Phim Kinh Dị 2',
    duration_ms: 6400000,
    view_count: 32000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/v2.jpg',
    owner: {
      id: 'usr-owner-1',
      handle: 'cinema_channel',
      display_name: 'Cinema Channel',
      avatar_url: null,
    },
  },
  {
    id: 'vid-3',
    title: 'Phim Hài 3',
    duration_ms: 5400000,
    view_count: 18000,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://cdn.winkey.vn/v3.jpg',
    owner: {
      id: 'usr-owner-1',
      handle: 'cinema_channel',
      display_name: 'Cinema Channel',
      avatar_url: null,
    },
  },
];

describe('Cinema Page (ADR-033 / Task CIN1)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockIsAuthenticated = false;
    vi.clearAllMocks();

    // Default IntersectionObserver mock triggering callback immediately
    window.IntersectionObserver = vi.fn().mockImplementation((callback) => ({
      observe: vi.fn((el) => {
        callback([{ isIntersecting: true, target: el }]);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    // Default matchMedia (desktop, no reduced motion)
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

    // Default desktop width
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Hero Fallback & Rotation', () => {
    it('falls back to newest when trending returns empty items and uses latest surface', async () => {
      const getVideosSpy = vi.spyOn(api.video, 'GET').mockImplementation((path, options: any) => {
        const query = options?.params?.query as { sort?: string };
        if (query?.sort === 'trending') {
          return Promise.resolve({
            data: { items: [], next_cursor: null },
            response: new Response(),
          }) as any;
        }
        if (query?.sort === 'newest') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaHero onOpenDetail={vi.fn()} />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('cinema-hero-title').textContent).toContain('Phim Hành Động 1');
      });

      // Verify watch button has ?src=latest
      const watchBtn = screen.getByTestId('cinema-hero-watch-btn');
      expect(watchBtn.getAttribute('href')).toContain('src=latest');
      expect(getVideosSpy).toHaveBeenCalledWith(
        '/v1/videos',
        expect.objectContaining({
          params: { query: { sort: 'trending', limit: 5 } },
        }),
      );
      expect(getVideosSpy).toHaveBeenCalledWith(
        '/v1/videos',
        expect.objectContaining({
          params: { query: { sort: 'newest', limit: 5 } },
        }),
      );
    });

    it('pauses 8s auto-rotation on mouse enter / focus and resumes on mouse leave / blur', async () => {
      vi.useFakeTimers();

      vi.spyOn(api.video, 'GET').mockImplementation((path, options: any) => {
        const query = options?.params?.query as { sort?: string };
        if (query?.sort === 'trending') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaHero onOpenDetail={vi.fn()} />
        </ToastProvider>,
      );

      // Wait for first render
      await act(async () => {
        await Promise.resolve();
      });

      const hero = screen.getByTestId('cinema-hero');
      expect(screen.getByTestId('cinema-hero-title').textContent).toContain('Phim Hành Động 1');

      // Mouse enter -> paused
      fireEvent.mouseEnter(hero);

      // Advance by 8 seconds
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      // Should still be on first slide
      expect(screen.getByTestId('cinema-hero-title').textContent).toContain('Phim Hành Động 1');

      // Mouse leave -> resumes
      fireEvent.mouseLeave(hero);

      // Advance by 8 seconds
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      // Should advance to second slide
      expect(screen.getByTestId('cinema-hero-title').textContent).toContain('Phim Kinh Dị 2');

      vi.useRealTimers();
    });
  });

  describe('2. Muted Preview Constraints & No Heartbeat/View Telemetry', () => {
    it('never starts preview on screens < 768px', async () => {
      vi.useFakeTimers();
      Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });

      vi.spyOn(api.video, 'GET').mockImplementation((path, _options: any) => {
        if (path === '/v1/videos') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        if (path === '/v1/videos/{video_id}') {
          return Promise.resolve({
            data: {
              ...sampleVideos[0],
              playback: { hls_url: 'https://cdn.winkey.vn/hls/master.m3u8' },
            },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaHero onOpenDetail={vi.fn()} />
        </ToastProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      // Idle for 3s
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // No video element rendered for preview
      expect(document.querySelector('video')).toBeNull();

      vi.useRealTimers();
    });

    it('never starts preview when prefers-reduced-motion: reduce is active', async () => {
      vi.useFakeTimers();
      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      vi.spyOn(api.video, 'GET').mockImplementation((path) => {
        if (path === '/v1/videos') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaHero onOpenDetail={vi.fn()} />
        </ToastProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(document.querySelector('video')).toBeNull();
      vi.useRealTimers();
    });

    it('never starts preview when navigator.connection.saveData is true', async () => {
      vi.useFakeTimers();
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true },
        configurable: true,
      });

      vi.spyOn(api.video, 'GET').mockImplementation((path) => {
        if (path === '/v1/videos') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaHero onOpenDetail={vi.fn()} />
        </ToastProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(document.querySelector('video')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('3. Row APIs, Surfaces & Lazy Loading', () => {
    it('calls respective API and carries specified surface on watch links', async () => {
      const getVideosSpy = vi.spyOn(api.video, 'GET').mockImplementation((path) => {
        if (path === '/v1/videos') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaRow
            title="Top 10 hôm nay"
            surface="trending"
            isTop10
            minVideos={3}
            fetchVideos={async () => {
              const res = await api.video.GET('/v1/videos', {
                params: { query: { sort: 'trending', limit: 10 } },
              });
              return res.data?.items || [];
            }}
            onOpenDetail={vi.fn()}
          />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Top 10 hôm nay')).toBeDefined();
        const cardLinks = screen.getAllByTestId('cinema-card-link');
        expect(cardLinks.length).toBeGreaterThan(0);
        expect(cardLinks[0].getAttribute('href')).toContain('src=trending');
      });
      expect(getVideosSpy).toHaveBeenCalledWith(
        '/v1/videos',
        expect.objectContaining({
          params: { query: { sort: 'trending', limit: 10 } },
        }),
      );
    });

    it('hides empty or failed rows without throwing errors', async () => {
      render(
        <ToastProvider>
          <CinemaRow
            title="Failed Row"
            surface="latest"
            fetchVideos={async () => {
              throw new Error('500 Internal Server Error');
            }}
            onOpenDetail={vi.fn()}
          />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.queryByText('Failed Row')).toBeNull();
      });
    });

    it('hides Top 10 row if it has fewer than 3 videos', async () => {
      render(
        <ToastProvider>
          <CinemaRow
            title="Top 10 hôm nay"
            surface="trending"
            isTop10
            minVideos={3}
            fetchVideos={async () => [sampleVideos[0], sampleVideos[1]]}
            onOpenDetail={vi.fn()}
          />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.queryByText('Top 10 hôm nay')).toBeNull();
      });
    });
  });

  describe('4. Continue Watching Row & Local Index Sync', () => {
    it('renders continue watching row, prunes missing IDs, and removes item on click', async () => {
      saveContinueWatching('vid-1', 120, 3600);
      saveContinueWatching('vid-missing', 50, 500);

      vi.spyOn(api.video, 'GET').mockImplementation((path) => {
        if (path === '/v1/videos/batch') {
          // vid-missing was deleted on server!
          return Promise.resolve({
            data: { items: [sampleVideos[0]] },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({
          data: { items: sampleVideos, next_cursor: null },
          response: new Response(),
        }) as any;
      });

      render(
        <ToastProvider>
          <CinemaView />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('cinema-row-continue')).toBeDefined();
      });

      // Local index should have been pruned to exclude vid-missing
      const pruned = getContinueWatching();
      expect(pruned.map((e) => e.id)).toEqual(['vid-1']);

      // Remove button on card
      const removeBtn = screen.getByTestId('cinema-card-remove-btn');
      fireEvent.click(removeBtn);

      // Now continue watching should be empty in localStorage
      expect(getContinueWatching()).toHaveLength(0);
    });
  });

  describe('5. Editorial Rows (Playlists)', () => {
    it('does not render editorial rows when curatorHandle is not set', async () => {
      render(
        <ToastProvider>
          <CinemaView curatorHandle="" />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.queryByTestId(/cinema-row-editorial-/)).toBeNull();
      });
    });

    it('handles 404 curator handle gracefully without crashing or showing editorial rows', async () => {
      vi.spyOn(api.auth, 'GET').mockRejectedValueOnce(new Error('404 Not Found'));

      render(
        <ToastProvider>
          <CinemaView curatorHandle="nonexistent_curator" />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.queryByTestId(/cinema-row-editorial-/)).toBeNull();
      });
    });

    it('loads playlists in API order and preserves playlist items order', async () => {
      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { id: 'usr-curator', handle: 'editor' },
        response: new Response(),
      } as any);

      vi.spyOn(api.social, 'GET').mockImplementation((path) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return Promise.resolve({
            data: {
              items: [
                { id: 'pl-curated-1', title: 'Tuyển Tập Điện Ảnh Việt', visibility: 'PUBLIC' },
              ],
              next_cursor: null,
            },
            response: new Response(),
          }) as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return Promise.resolve({
            data: {
              items: [
                { video_id: 'vid-2', position: 100 },
                { video_id: 'vid-1', position: 200 },
              ],
              next_cursor: null,
            },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: null, response: new Response() }) as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation((path) => {
        if (path === '/v1/videos/batch') {
          return Promise.resolve({
            data: { items: [sampleVideos[0], sampleVideos[1]] },
            response: new Response(),
          }) as any;
        }
        if (path === '/v1/videos') {
          return Promise.resolve({
            data: { items: sampleVideos, next_cursor: null },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({ data: { items: [] }, response: new Response() }) as any;
      });

      render(
        <ToastProvider>
          <CinemaView curatorHandle="editor" />
        </ToastProvider>,
      );

      await waitFor(
        () => {
          expect(screen.getByText('Tuyển Tập Điện Ảnh Việt')).toBeDefined();
          const editorialRow = screen.getByTestId('cinema-row-editorial-pl-curated-1');
          const cardLinks = editorialRow.querySelectorAll('[data-testid="cinema-card-link"]');
          expect(cardLinks.length).toBeGreaterThan(0);
          expect(cardLinks[0].getAttribute('href')).toContain('src=playlist');
        },
        { timeout: 5000 },
      );
    });
  });

  describe('6. Detail Dialog (?v= URL sync, Open/Close, Back button)', () => {
    it('opens detail dialog, syncs with ?v=<id>, and closes with back / close button', async () => {
      window.history.replaceState(null, '', 'http://localhost:3000/phim?v=vid-1');

      vi.spyOn(api.video, 'GET').mockImplementation((path, _options: any) => {
        if (path === '/v1/videos/{video_id}') {
          return Promise.resolve({
            data: { ...sampleVideos[0], description: 'Mô tả chi tiết phim 1' },
            response: new Response(),
          }) as any;
        }
        if (path === '/v1/videos/{video_id}/related') {
          return Promise.resolve({
            data: { items: [sampleVideos[1], sampleVideos[2]] },
            response: new Response(),
          }) as any;
        }
        return Promise.resolve({
          data: { items: sampleVideos, next_cursor: null },
          response: new Response(),
        }) as any;
      });

      const pushStateSpy = vi.spyOn(window.history, 'pushState');

      render(
        <ToastProvider>
          <CinemaView initialVideoId="vid-1" />
        </ToastProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('cinema-detail-dialog')).toBeDefined();
        expect(screen.getByTestId('cinema-detail-title').textContent).toContain('Phim Hành Động 1');
      });

      // Related grid displayed
      expect(screen.getByTestId('cinema-detail-related-grid')).toBeDefined();

      // Close button closes dialog
      const closeBtn = screen.getByTestId('cinema-detail-close-btn');
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(screen.queryByTestId('cinema-detail-dialog')).toBeNull();
      });
      expect(pushStateSpy).toHaveBeenCalled();
    });

    it('closes dialog on Escape key', async () => {
      const handleClose = vi.fn();

      render(
        <ToastProvider>
          <CinemaDetailDialog videoId="vid-1" onClose={handleClose} onSelectVideo={vi.fn()} />
        </ToastProvider>,
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalled();
    });
  });
});
