import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { VideoFeed } from '../src/components/video/video-feed';
import TrendingPage from '../src/app/[locale]/trending/page';
import SubscriptionsFeedPage from '../src/app/[locale]/feed/subscriptions/page';
import { Sidebar } from '../src/components/layout/sidebar';
import { SubscribeButton } from '../src/components/social/subscribe-button';
import { api } from '../src/lib/api-client';
import type { VideoPage, VideoSummary, User } from '@winkey/api-client';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

type VideoGetReturn = Awaited<ReturnType<typeof api.video.GET>>;
type SocialGetReturn = Awaited<ReturnType<typeof api.social.GET>>;
type SocialPutReturn = Awaited<ReturnType<typeof api.social.PUT>>;
type SocialDeleteReturn = Awaited<ReturnType<typeof api.social.DELETE>>;

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

// Mock next-intl
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsKey = `${activeLocale}:${namespace ?? ''}`;
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
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
      translatorMap.set(nsKey, fn);
    }
    return fn;
  },
}));

// --- Routing Mock ---
const mockPush = vi.fn();
let currentPathname = '/';
export function setTestPathname(p: string) {
  currentPathname = p;
}

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => currentPathname,
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
    onClick?: () => void;
  }) => (
    <a href={href} className={className} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

// --- Auth Mock ---
let mockAuthUser: User | null = null;
let mockIsAuthenticated = false;
let mockIsAuthLoading = false;
const mockClearSession = vi.fn();
const mockLogout = vi.fn();

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockAuthUser,
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsAuthLoading,
    clearSession: mockClearSession,
    logout: mockLogout,
    canAccessAdmin:
      mockAuthUser?.roles?.includes('admin') || mockAuthUser?.roles?.includes('moderator'),
    isCreator: mockAuthUser?.roles?.includes('creator'),
  }),
}));

// --- Mock IntersectionObserver ---
let observerCallbacks: ((entries: IntersectionObserverEntry[]) => void)[] = [];
class MockIntersectionObserver {
  callback: (entries: IntersectionObserverEntry[]) => void;
  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    this.callback = cb;
    observerCallbacks.push(cb);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function triggerIntersection(isIntersecting: boolean) {
  for (const cb of observerCallbacks) {
    cb([{ isIntersecting } as IntersectionObserverEntry]);
  }
}

// Helper wrapper with QueryClient
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

function renderWithClient(ui: React.ReactElement, client = createTestQueryClient()) {
  return {
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>,
    ),
    client,
  };
}

// Sample Mock Videos
const sampleVideo1: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-v00000000001',
  title: 'Video Trending Top 1',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-u00000000001',
    handle: 'creator_one',
    display_name: 'Creator One',
    avatar_url: 'https://example.com/avatar1.jpg',
  },
  duration_ms: 125000,
  view_count: 50000,
  published_at: '2026-09-20T10:00:00Z',
  thumbnail_url: 'https://example.com/thumb1.jpg',
};

const sampleVideo2: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-v00000000002',
  title: 'Video Trending Top 2',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-u00000000002',
    handle: 'creator_two',
    display_name: 'Creator Two',
    avatar_url: null,
  },
  duration_ms: 360000,
  view_count: 32000,
  published_at: '2026-09-21T10:00:00Z',
  thumbnail_url: 'https://example.com/thumb2.jpg',
};

const sampleVideo3: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-v00000000003',
  title: 'Video Newest Feed Item',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-u00000000003',
    handle: 'creator_three',
    display_name: 'Creator Three',
    avatar_url: null,
  },
  duration_ms: 180000,
  view_count: 1200,
  published_at: '2026-09-22T10:00:00Z',
  thumbnail_url: 'https://example.com/thumb3.jpg',
};

describe('Feed, Trending & Subscriptions UI (Task U6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    mockClearSession.mockReset();
    mockLogout.mockReset();
    observerCallbacks = [];
    currentPathname = '/';
    setTestLocale('vi');

    // Setup Mock IntersectionObserver on window
    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    mockAuthUser = {
      id: '0192f5e4-7c1a-7b3e-9d2a-u00000000001',
      handle: 'alice_subscriber',
      display_name: 'Alice Subscriber',
      email: 'alice@winkey.vn',
      avatar_url: null,
      roles: ['viewer'],
      has_password: true,
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockIsAuthenticated = true;
    mockIsAuthLoading = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Reusable VideoFeed Component', () => {
    it('renders initial page items and fetches next page on sentinel intersection', async () => {
      let callCount = 0;
      const fetchPageMock = vi
        .fn()
        .mockImplementation(async (cursor: string | null): Promise<VideoPage> => {
          callCount++;
          if (cursor === null) {
            return {
              items: [sampleVideo1],
              next_cursor: 'cursor-page-2',
            };
          }
          return {
            items: [sampleVideo2],
            next_cursor: null,
          };
        });

      renderWithClient(<VideoFeed queryKey={['test-feed']} fetchPage={fetchPageMock} />);

      // Initially renders sampleVideo1
      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
      });
      expect(callCount).toBe(1);

      // Trigger sentinel intersection
      triggerIntersection(true);

      // Fetches second page and renders sampleVideo2
      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 2')).toBeDefined();
      });
      expect(callCount).toBe(2);
      expect(fetchPageMock).toHaveBeenLastCalledWith('cursor-page-2');

      // Now next_cursor is null: triggering intersection again must NOT call fetchPage
      triggerIntersection(true);
      expect(callCount).toBe(2);
    });

    it('stops when next_cursor is null and does not show fallback button', async () => {
      const fetchPageMock = vi.fn().mockResolvedValue({
        items: [sampleVideo1],
        next_cursor: null,
      } satisfies VideoPage);

      renderWithClient(<VideoFeed queryKey={['test-feed-single']} fetchPage={fetchPageMock} />);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
      });

      // No load more button since hasNextPage is false
      expect(screen.queryByRole('button', { name: /tải thêm/i })).toBeNull();
    });

    it('renders custom emptySlot when page has 0 items', async () => {
      const fetchPageMock = vi.fn().mockResolvedValue({
        items: [],
        next_cursor: null,
      } satisfies VideoPage);

      renderWithClient(
        <VideoFeed
          queryKey={['test-empty-feed']}
          fetchPage={fetchPageMock}
          emptySlot={<div data-testid="custom-empty">Không có dữ liệu tùy chỉnh</div>}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('custom-empty')).toBeDefined();
        expect(screen.getByText('Không có dữ liệu tùy chỉnh')).toBeDefined();
      });
    });

    it('renders fallback load-more button and fetches next page on click', async () => {
      const fetchPageMock = vi
        .fn()
        .mockResolvedValueOnce({
          items: [sampleVideo1],
          next_cursor: 'page-2-cursor',
        } satisfies VideoPage)
        .mockResolvedValueOnce({
          items: [sampleVideo2],
          next_cursor: null,
        } satisfies VideoPage);

      renderWithClient(<VideoFeed queryKey={['test-load-more']} fetchPage={fetchPageMock} />);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
      });

      const loadMoreBtn = screen.getByRole('button', { name: /tải thêm video/i });
      expect(loadMoreBtn).toBeDefined();

      fireEvent.click(loadMoreBtn);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 2')).toBeDefined();
      });
      expect(fetchPageMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('2. Trending Page (/[locale]/trending)', () => {
    it('renders rank badges 1..n on video cards in the trending list', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: {
          items: [sampleVideo1, sampleVideo2],
          next_cursor: null,
        },
        response: new Response(null, { status: 200 }),
      } as VideoGetReturn);

      renderWithClient(<TrendingPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
        expect(screen.getByText('Video Trending Top 2')).toBeDefined();
      });

      // Verify rank badges
      const badge1 = screen.getByTestId('rank-badge-1');
      const badge2 = screen.getByTestId('rank-badge-2');
      expect(badge1).toBeDefined();
      expect(badge1.textContent).toBe('1');
      expect(badge2).toBeDefined();
      expect(badge2.textContent).toBe('2');
    });

    it('supports cursor pagination with sort=trending', async () => {
      const getSpy = vi
        .spyOn(api.video, 'GET')
        .mockResolvedValueOnce({
          data: {
            items: [sampleVideo1],
            next_cursor: 'cursor-12',
          },
          response: new Response(null, { status: 200 }),
        } as VideoGetReturn)
        .mockResolvedValueOnce({
          data: {
            items: [sampleVideo2],
            next_cursor: null,
          },
          response: new Response(null, { status: 200 }),
        } as VideoGetReturn);

      renderWithClient(<TrendingPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
      });
      expect(getSpy).toHaveBeenCalledWith('/v1/videos', {
        params: {
          query: {
            sort: 'trending',
            cursor: undefined,
            limit: 12,
          },
        },
      });

      // Trigger pagination
      triggerIntersection(true);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 2')).toBeDefined();
      });
      expect(getSpy).toHaveBeenLastCalledWith('/v1/videos', {
        params: {
          query: {
            sort: 'trending',
            cursor: 'cursor-12',
            limit: 12,
          },
        },
      });
    });

    it('when trending ranking is empty: renders warning notice AND newest feed below it', async () => {
      const getSpy = vi.spyOn(api.video, 'GET').mockImplementation(async (_path, options) => {
        const query = (options as { params?: { query?: { sort?: string } } })?.params?.query;
        if (query?.sort === 'trending') {
          // Empty trending ranking
          return {
            data: { items: [], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as VideoGetReturn;
        }
        // Fallback newest feed (sort omitted)
        return {
          data: { items: [sampleVideo3], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as VideoGetReturn;
      });

      renderWithClient(<TrendingPage />);

      // Notice must appear
      await waitFor(() => {
        expect(screen.getByTestId('empty-trending-notice')).toBeDefined();
        expect(screen.getByText('Chưa có video thịnh hành — xem video mới nhất')).toBeDefined();
      });

      // Newest feed video must also appear below notice
      await waitFor(() => {
        expect(screen.getByText('Video Newest Feed Item')).toBeDefined();
      });

      // Newest feed items should NOT have rank badges
      expect(screen.queryByTestId('rank-badge-1')).toBeNull();
      expect(getSpy).toHaveBeenCalled();
    });

    it('renders English translations when locale is set to en', async () => {
      setTestLocale('en');
      vi.spyOn(api.video, 'GET')
        .mockResolvedValueOnce({
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as VideoGetReturn)
        .mockResolvedValueOnce({
          data: { items: [sampleVideo3], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as VideoGetReturn);

      renderWithClient(<TrendingPage />);

      await waitFor(() => {
        expect(screen.getByText('Trending')).toBeDefined();
        expect(
          screen.getByText('No trending videos yet — check out the newest videos'),
        ).toBeDefined();
      });
    });
  });

  describe('3. Subscriptions Feed Page (/[locale]/feed/subscriptions)', () => {
    it('redirects anonymous users to /login?return_to=/feed/subscriptions', async () => {
      mockIsAuthenticated = false;
      mockAuthUser = null;

      renderWithClient(<SubscriptionsFeedPage />);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?return_to=/feed/subscriptions');
      });
    });

    it('renders subscription feed items for signed-in user', async () => {
      const getSpy = vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: {
          items: [sampleVideo1],
          next_cursor: null,
        },
        response: new Response(null, { status: 200 }),
      } as VideoGetReturn);

      renderWithClient(<SubscriptionsFeedPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Trending Top 1')).toBeDefined();
      });

      expect(getSpy).toHaveBeenCalledWith('/v1/feed/subscriptions', {
        params: {
          query: {
            cursor: undefined,
            limit: 12,
          },
        },
      });
    });

    it('renders empty state with CTA to /trending when subscription feed is empty', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: {
          items: [],
          next_cursor: null,
        },
        response: new Response(null, { status: 200 }),
      } as VideoGetReturn);

      renderWithClient(<SubscriptionsFeedPage />);

      await waitFor(() => {
        expect(screen.getByTestId('subscriptions-empty-state')).toBeDefined();
        expect(screen.getByText('Bạn chưa theo dõi kênh nào')).toBeDefined();
        expect(
          screen.getByText('Đăng ký các kênh yêu thích của bạn để xem video mới nhất tại đây.'),
        ).toBeDefined();
      });

      // Verify CTA button links to /trending
      const ctaLink = screen.getByRole('link', { name: /xem thịnh hành/i });
      expect(ctaLink).toBeDefined();
      expect(ctaLink.getAttribute('href')).toBe('/trending');
    });

    it('handles 401 error as expired session, calls clearSession and redirects to login', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        error: {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        response: new Response(null, { status: 401 }),
      } as VideoGetReturn);

      renderWithClient(<SubscriptionsFeedPage />);

      await waitFor(() => {
        expect(mockClearSession).toHaveBeenCalled();
        expect(mockPush).toHaveBeenCalledWith('/login?return_to=/feed/subscriptions');
      });
    });
  });

  describe('4. SubscribeButton Query Invalidation', () => {
    it('invalidates ["feed", "subscriptions"] query on subscribe and unsubscribe toggle', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: {
          channel_id: 'chan-100',
          subscribed: false,
          subscriber_count: 10,
        },
        response: new Response(null, { status: 200 }),
      } as SocialGetReturn);

      const putSpy = vi.spyOn(api.social, 'PUT').mockResolvedValueOnce({
        data: {
          channel_id: 'chan-100',
          subscribed: true,
          subscriber_count: 11,
        },
        response: new Response(null, { status: 200 }),
      } as SocialPutReturn);

      const client = createTestQueryClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      renderWithClient(
        <SubscribeButton channelId="chan-100" initialSubscriberCount={10} />,
        client,
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Đăng ký' })).toBeDefined();
      });

      const subBtn = screen.getByRole('button', { name: 'Đăng ký' });
      fireEvent.click(subBtn);

      await waitFor(() => {
        expect(putSpy).toHaveBeenCalled();
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['feed', 'subscriptions'],
        });
      });

      // Now unsubscribe toggle (DELETE)
      const deleteSpy = vi.spyOn(api.social, 'DELETE').mockResolvedValueOnce({
        data: {
          channel_id: 'chan-100',
          subscribed: false,
          subscriber_count: 10,
        },
        response: new Response(null, { status: 200 }),
      } as SocialDeleteReturn);

      fireEvent.click(subBtn);

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalled();
        expect(invalidateSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('5. Sidebar Navigation & Active States', () => {
    it('renders /trending link and applies active state when on /trending', () => {
      setTestPathname('/trending');

      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      const trendingLink = screen.getByRole('link', { name: 'Thịnh hành' });
      expect(trendingLink).toBeDefined();
      expect(trendingLink.getAttribute('href')).toBe('/trending');

      // Check active classes applied to /trending link
      expect(trendingLink.className).toContain('text-red-500');
    });

    it('renders /feed/subscriptions only when user is authenticated, and active when on route', () => {
      mockIsAuthenticated = true;
      setTestPathname('/feed/subscriptions');

      const { rerender } = render(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />,
      );

      const subLink = screen.getByRole('link', { name: 'Kênh đăng ký' });
      expect(subLink).toBeDefined();
      expect(subLink.getAttribute('href')).toBe('/feed/subscriptions');
      expect(subLink.className).toContain('text-red-500');

      // When unauthenticated, /feed/subscriptions must NOT be rendered
      mockIsAuthenticated = false;
      rerender(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      expect(screen.queryByRole('link', { name: 'Kênh đăng ký' })).toBeNull();
    });
  });
});
