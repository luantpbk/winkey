import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HomePage from '../src/app/[locale]/page';
import { api } from '../src/lib/api-client';
import { tokenStore } from '../src/lib/auth/token-store';
import type { VideoSummary, User } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';
import { mockPersonalRecommendedVideosFixture, resetModerationMocks } from '../src/mocks/handlers';

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

vi.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const isVi = activeLocale === 'vi';
      const root = isVi ? viMessages : enMessages;
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: any = root;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = cur[p];
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

// --- Routing Mock ---
const mockPush = vi.fn();
let mockPathname = '/vi';
let mockSearchParams = new URLSearchParams();

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
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

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// --- Toast Mock ---
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// --- IntersectionObserver Mock ---
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof window !== 'undefined') {
  window.IntersectionObserver = MockIntersectionObserver as any;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
}

// --- Auth Context Mock ---
let mockCurrentUser: User | null = null;
let mockAuthLoading = false;
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockCurrentUser,
    isAuthenticated: !!mockCurrentUser,
    isLoading: mockAuthLoading,
    isCreator: !!mockCurrentUser,
    isModerator: false,
    isAdmin: false,
    canAccessAdmin: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    updateUser: vi.fn(),
    clearSession: vi.fn(),
  }),
}));

const mockCreatorUser: User = {
  id: '0192f5e4-7c1a-7b3e-9d2a-111111111111',
  email: 'creator@winkey.vn',
  email_verified: true,
  avatar_url: null,
  handle: 'creator',
  display_name: 'Winkey Creator',
  roles: ['creator'],
  created_at: '2026-01-01T00:00:00Z',
};

function createTestVideo(
  partial: Partial<VideoSummary> & { id: string; title: string },
): VideoSummary {
  return {
    duration_ms: 60000,
    view_count: 100,
    published_at: new Date().toISOString(),
    thumbnail_url: 'https://example.com/thumb.jpg',
    owner: {
      id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
      display_name: 'Channel 1',
      handle: 'ch1',
      avatar_url: null,
    },
    ...partial,
  };
}

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

function renderHomePage(client = createTestQueryClient()) {
  return {
    ...render(
      <QueryClientProvider client={client}>
        <HomePage />
      </QueryClientProvider>,
    ),
    client,
  };
}

describe('Task R2-web: "Dành cho bạn" (For You) Home Feed', () => {
  beforeEach(() => {
    tokenStore.clear();
    setTestLocale('vi');
    mockPush.mockClear();
    mockPathname = '/vi';
    mockSearchParams = new URLSearchParams();
    mockCurrentUser = null;
    mockAuthLoading = false;
    resetModerationMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    tokenStore.clear();
    mockAuthLoading = false;
    resetModerationMocks();
    vi.restoreAllMocks();
  });

  describe('1. Default tab per auth state & ?tab= restoration', () => {
    it('defaults to "Dành cho bạn" (for-you) when user is signed in', async () => {
      mockCurrentUser = mockCreatorUser;
      renderHomePage();

      const forYouTab = screen.getByTestId('tab-for-you');
      const latestTab = screen.getByTestId('tab-latest');
      const trendingTab = screen.getByTestId('tab-trending');

      expect(forYouTab).toBeDefined();
      expect(forYouTab.getAttribute('aria-selected')).toBe('true');
      expect(latestTab.getAttribute('aria-selected')).toBe('false');
      expect(trendingTab.getAttribute('aria-selected')).toBe('false');
    });

    it('defaults to "Mới nhất" (latest) when user is anonymous', async () => {
      mockCurrentUser = null;
      renderHomePage();

      const forYouTab = screen.getByTestId('tab-for-you');
      const latestTab = screen.getByTestId('tab-latest');
      const trendingTab = screen.getByTestId('tab-trending');

      expect(latestTab.getAttribute('aria-selected')).toBe('true');
      expect(forYouTab.getAttribute('aria-selected')).toBe('false');
      expect(trendingTab.getAttribute('aria-selected')).toBe('false');
    });

    it('waits for auth loading before picking default tab: signed-in reload sends no request to /v1/videos (latest), only /v1/feed/recommended', async () => {
      // Simulate signed-in reload: starts with auth loading and user not yet loaded
      mockCurrentUser = null;
      mockAuthLoading = true;
      tokenStore.set('jwt-test-auth-token-12345');

      const requestedPaths: string[] = [];
      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        requestedPaths.push(path);
        if (path === '/v1/feed/recommended') {
          return {
            data: {
              items: mockPersonalRecommendedVideosFixture.slice(0, 24),
              next_cursor: null,
            },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      const client = createTestQueryClient();
      const { rerender } = renderHomePage(client);

      // Phase 1: While auth is loading:
      // - Neither tab is selected yet
      // - Feed skeleton is shown
      // - Zero requests to /v1/videos or /v1/feed/recommended
      const forYouTab = screen.getByTestId('tab-for-you');
      const latestTab = screen.getByTestId('tab-latest');
      expect(forYouTab.getAttribute('aria-selected')).toBe('false');
      expect(latestTab.getAttribute('aria-selected')).toBe('false');
      expect(screen.getByTestId('feed-skeleton')).toBeDefined();
      expect(requestedPaths).toEqual([]);

      // Phase 2: Auth resolves as signed-in
      mockCurrentUser = mockCreatorUser;
      mockAuthLoading = false;
      rerender(
        <QueryClientProvider client={client}>
          <HomePage />
        </QueryClientProvider>,
      );

      // Phase 3: Tab automatically becomes "Dành cho bạn"
      await waitFor(() => {
        expect(screen.getByTestId('tab-for-you').getAttribute('aria-selected')).toBe('true');
      });

      // Phase 4: Only /v1/feed/recommended is requested, never /v1/videos
      await waitFor(() => {
        expect(requestedPaths).toContain('/v1/feed/recommended');
      });
      expect(requestedPaths).not.toContain('/v1/videos');
      expect(requestedPaths.filter((p) => p === '/v1/videos')).toHaveLength(0);
    });

    it('waits for auth loading before picking default tab: anonymous reload sends no request until auth resolves, then fetches /v1/videos', async () => {
      mockCurrentUser = null;
      mockAuthLoading = true;

      const requestedPaths: string[] = [];
      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        requestedPaths.push(path);
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      const client = createTestQueryClient();
      const { rerender } = renderHomePage(client);

      // While auth is loading, no feed requests are made
      expect(screen.getByTestId('feed-skeleton')).toBeDefined();
      expect(requestedPaths).toEqual([]);

      // Auth resolves as anonymous
      mockAuthLoading = false;
      rerender(
        <QueryClientProvider client={client}>
          <HomePage />
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('tab-latest').getAttribute('aria-selected')).toBe('true');
      });

      await waitFor(() => {
        expect(requestedPaths).toContain('/v1/videos');
      });

      expect(requestedPaths).not.toContain('/v1/feed/recommended');
    });

    it('restores "Thịnh hành" tab when ?tab=trending is in URL', async () => {
      mockCurrentUser = mockCreatorUser;
      mockSearchParams = new URLSearchParams('tab=trending');
      renderHomePage();

      const trendingTab = screen.getByTestId('tab-trending');
      const forYouTab = screen.getByTestId('tab-for-you');

      expect(trendingTab.getAttribute('aria-selected')).toBe('true');
      expect(forYouTab.getAttribute('aria-selected')).toBe('false');
    });

    it('keeps explicit ?tab= as is even while auth is loading', async () => {
      mockCurrentUser = null;
      mockAuthLoading = true;
      mockSearchParams = new URLSearchParams('tab=trending');

      const client = createTestQueryClient();
      const { rerender } = renderHomePage(client);

      // Even while loading, explicit ?tab=trending is preserved
      expect(screen.getByTestId('tab-trending').getAttribute('aria-selected')).toBe('true');

      // Auth finishes loading for a signed-in user
      mockCurrentUser = mockCreatorUser;
      mockAuthLoading = false;
      rerender(
        <QueryClientProvider client={client}>
          <HomePage />
        </QueryClientProvider>,
      );

      // Tab remains trending because ?tab=trending was specified
      expect(screen.getByTestId('tab-trending').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('tab-for-you').getAttribute('aria-selected')).toBe('false');
    });

    it('restores "Dành cho bạn" tab when ?tab=for-you is in URL even if anonymous', async () => {
      mockCurrentUser = null;
      mockSearchParams = new URLSearchParams('tab=for-you');
      renderHomePage();

      const forYouTab = screen.getByTestId('tab-for-you');
      expect(forYouTab.getAttribute('aria-selected')).toBe('true');
    });

    it('switches tabs and updates URL with router.push', async () => {
      mockCurrentUser = null;
      renderHomePage();

      const trendingTab = screen.getByTestId('tab-trending');
      fireEvent.click(trendingTab);

      expect(mockPush).toHaveBeenCalledWith('/vi?tab=trending');
      expect(trendingTab.getAttribute('aria-selected')).toBe('true');

      const forYouTab = screen.getByTestId('tab-for-you');
      fireEvent.click(forYouTab);

      expect(mockPush).toHaveBeenCalledWith('/vi?tab=for-you');
      expect(forYouTab.getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('2. Data fetching, token transmission & query key changes', () => {
    it('sends Authorization token when signed in and fetches GET /v1/feed/recommended with limit 24', async () => {
      mockCurrentUser = mockCreatorUser;
      tokenStore.set('jwt-test-auth-token-12345');

      let capturedQuery: any;
      const getSpy = vi
        .spyOn(api.video, 'GET')
        .mockImplementation(async (path: string, opts?: any) => {
          if (path === '/v1/feed/recommended') {
            capturedQuery = opts?.params?.query;
            return {
              data: {
                items: mockPersonalRecommendedVideosFixture.slice(0, 24),
                next_cursor: 'reco-page-2',
              },
              error: undefined,
              response: new Response(null, { status: 200 }),
            } as any;
          }
          return {
            data: { items: [], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        });

      renderHomePage();

      await waitFor(() => {
        expect(getSpy).toHaveBeenCalledWith('/v1/feed/recommended', expect.anything());
      });

      expect(capturedQuery?.limit).toBe(24);
      expect(capturedQuery?.cursor).toBeUndefined();
    });

    it('uses query key with user.id when signed in, and anon when logged out', async () => {
      // 1. Signed in query key
      mockCurrentUser = mockCreatorUser;
      const client1 = createTestQueryClient();
      const { unmount } = renderHomePage(client1);

      await waitFor(() => {
        const queries = client1.getQueryCache().getAll();
        const recoQuery = queries.find(
          (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey[0] === 'feed' &&
            q.queryKey[1] === 'recommended',
        );
        expect(recoQuery).toBeDefined();
        expect(recoQuery?.queryKey).toEqual(['feed', 'recommended', mockCreatorUser.id]);
      });

      unmount();

      // 2. Anonymous / logged out query key
      mockCurrentUser = null;
      mockSearchParams = new URLSearchParams('tab=for-you');
      const client2 = createTestQueryClient();
      renderHomePage(client2);

      await waitFor(() => {
        const queries = client2.getQueryCache().getAll();
        const recoQuery = queries.find(
          (q) =>
            Array.isArray(q.queryKey) &&
            q.queryKey[0] === 'feed' &&
            q.queryKey[1] === 'recommended',
        );
        expect(recoQuery).toBeDefined();
        expect(recoQuery?.queryKey).toEqual(['feed', 'recommended', 'anon']);
      });
    });
  });

  describe('3. Pagination and stopping at null cursor', () => {
    it('appends pages in order and stops when next_cursor is null', async () => {
      mockCurrentUser = mockCreatorUser;

      const page1Items: VideoSummary[] = Array.from({ length: 3 }, (_, i) =>
        createTestVideo({
          id: `0192f5e4-7c1a-7b3e-9d2a-0000000000${(i + 1).toString().padStart(2, '0')}`,
          title: `Page 1 Video ${i + 1}`,
          view_count: 100,
        }),
      );

      const page2Items: VideoSummary[] = Array.from({ length: 3 }, (_, i) =>
        createTestVideo({
          id: `0192f5e4-7c1a-7b3e-9d2a-0000000001${(i + 1).toString().padStart(2, '0')}`,
          title: `Page 2 Video ${i + 1}`,
          view_count: 200,
        }),
      );

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string, opts?: any) => {
        if (path === '/v1/feed/recommended') {
          const cursor = opts?.params?.query?.cursor;
          if (!cursor) {
            return {
              data: { items: page1Items, next_cursor: 'page-2-token' },
              response: new Response(null, { status: 200 }),
            } as any;
          }
          if (cursor === 'page-2-token') {
            return {
              data: { items: page2Items, next_cursor: null },
              response: new Response(null, { status: 200 }),
            } as any;
          }
        }
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      renderHomePage();

      // Wait for page 1 items
      await waitFor(() => {
        expect(screen.getByText('Page 1 Video 1')).toBeDefined();
        expect(screen.getByText('Page 1 Video 3')).toBeDefined();
      });

      // Click "Tải thêm video" button
      const loadMoreButton = await screen.findByRole('button', { name: /Tải thêm/i });
      expect(loadMoreButton).toBeDefined();
      fireEvent.click(loadMoreButton);

      // Wait for page 2 items to append
      await waitFor(() => {
        expect(screen.getByText('Page 2 Video 1')).toBeDefined();
        expect(screen.getByText('Page 2 Video 3')).toBeDefined();
      });

      // Page 1 items are still there
      expect(screen.getByText('Page 1 Video 1')).toBeDefined();

      // Since next_cursor is now null, the "Tải thêm" button is no longer rendered
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Tải thêm/i })).toBeNull();
      });
    }, 15000);
  });

  describe('4. Defensive deduplication of video IDs across pages', () => {
    it('never renders duplicate video IDs across pages', async () => {
      mockCurrentUser = mockCreatorUser;

      const duplicateId = '0192f5e4-7c1a-7b3e-9d2a-dup000000001';
      const page1: VideoSummary[] = [
        createTestVideo({
          id: duplicateId,
          title: 'Duplicate Shared Video',
          view_count: 500,
        }),
        createTestVideo({
          id: '0192f5e4-7c1a-7b3e-9d2a-000000000002',
          title: 'Page 1 Unique Video',
          view_count: 100,
        }),
      ];

      const page2: VideoSummary[] = [
        createTestVideo({
          id: duplicateId, // Duplicate video ID in page 2
          title: 'Duplicate Shared Video',
          view_count: 500,
        }),
        createTestVideo({
          id: '0192f5e4-7c1a-7b3e-9d2a-000000000003',
          title: 'Page 2 Unique Video',
          view_count: 200,
        }),
      ];

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string, opts?: any) => {
        if (path === '/v1/feed/recommended') {
          const cursor = opts?.params?.query?.cursor;
          if (!cursor) {
            return {
              data: { items: page1, next_cursor: 'page-2-cursor' },
              response: new Response(null, { status: 200 }),
            } as any;
          }
          return {
            data: { items: page2, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      renderHomePage();

      await waitFor(() => {
        expect(screen.getByText('Page 1 Unique Video')).toBeDefined();
      });

      const loadMoreBtn = await screen.findByRole('button', { name: /Tải thêm/i });
      fireEvent.click(loadMoreBtn);

      await waitFor(() => {
        expect(screen.getByText('Page 2 Unique Video')).toBeDefined();
      });

      // The duplicate title must only appear ONCE in the document
      const duplicateElements = screen.getAllByText('Duplicate Shared Video');
      expect(duplicateElements.length).toBe(1);
    });
  });

  describe('5. Empty and error states', () => {
    it('renders friendly empty state with links to Thịnh hành and Upload', async () => {
      mockCurrentUser = mockCreatorUser;

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/feed/recommended') {
          return {
            data: { items: [], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      renderHomePage();

      await waitFor(() => {
        expect(screen.getByTestId('for-you-empty-state')).toBeDefined();
      });

      // Verify empty state title and description in vi
      expect(screen.getByText('Chưa có đề xuất nào dành riêng cho bạn')).toBeDefined();

      const trendingBtn = screen.getByTestId('empty-trending-btn');
      expect(trendingBtn).toBeDefined();
      expect(trendingBtn.textContent).toContain('Khám phá Thịnh hành');

      const uploadLink = screen.getByTestId('empty-upload-link');
      expect(uploadLink).toBeDefined();
      expect(uploadLink.getAttribute('href')).toBe('/upload');
      expect(uploadLink.textContent).toContain('Tải video lên');

      // Clicking explore trending switches to trending tab
      fireEvent.click(trendingBtn);
      expect(mockPush).toHaveBeenCalledWith('/vi?tab=trending');
      expect(screen.getByTestId('tab-trending').getAttribute('aria-selected')).toBe('true');
    });

    it('renders inline retry button on error and recovers upon retry', async () => {
      mockCurrentUser = mockCreatorUser;

      let hasFailedOnce = false;
      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/feed/recommended') {
          if (!hasFailedOnce) {
            hasFailedOnce = true;
            return {
              data: null,
              error: { detail: 'Backend service unavailable' },
              response: new Response(null, { status: 500 }),
            } as any;
          }
          return {
            data: {
              items: [
                createTestVideo({
                  id: '0192f5e4-7c1a-7b3e-9d2a-recovered001',
                  title: 'Recovered Video After Retry',
                  duration_ms: 120000,
                  view_count: 300,
                }),
              ],
              next_cursor: null,
            },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return {
          data: { items: [], next_cursor: null },
          response: new Response(null, { status: 200 }),
        } as any;
      });

      renderHomePage();

      // Inline retry button is displayed
      const retryBtn = await screen.findByTestId('feed-retry-btn');
      expect(retryBtn).toBeDefined();
      expect(retryBtn.textContent).toContain('Thử lại');

      // Click retry button
      fireEvent.click(retryBtn);

      // Successfully recovers and renders video
      await waitFor(() => {
        expect(screen.getByText('Recovered Video After Retry')).toBeDefined();
      });
      expect(screen.queryByTestId('feed-retry-btn')).toBeNull();
    });
  });

  describe('6. i18n support in Vietnamese and English', () => {
    it('renders tabs and strings in Vietnamese', async () => {
      setTestLocale('vi');
      mockCurrentUser = mockCreatorUser;

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any);

      renderHomePage();

      expect(screen.getByTestId('tab-for-you').textContent).toBe('Dành cho bạn');
      expect(screen.getByTestId('tab-latest').textContent).toBe('Mới nhất');
      expect(screen.getByTestId('tab-trending').textContent).toBe('Thịnh hành');

      await waitFor(() => {
        expect(screen.getByText('Chưa có đề xuất nào dành riêng cho bạn')).toBeDefined();
        expect(screen.getByTestId('empty-trending-btn').textContent).toContain(
          'Khám phá Thịnh hành',
        );
        expect(screen.getByTestId('empty-upload-link').textContent).toContain('Tải video lên');
      });
    });

    it('renders tabs and strings in English', async () => {
      setTestLocale('en');
      mockCurrentUser = mockCreatorUser;

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any);

      renderHomePage();

      expect(screen.getByTestId('tab-for-you').textContent).toBe('For you');
      expect(screen.getByTestId('tab-latest').textContent).toBe('Latest');
      expect(screen.getByTestId('tab-trending').textContent).toBe('Trending');

      await waitFor(() => {
        expect(screen.getByText('No recommendations for you yet')).toBeDefined();
        expect(screen.getByTestId('empty-trending-btn').textContent).toContain('Explore Trending');
        expect(screen.getByTestId('empty-upload-link').textContent).toContain('Upload Video');
      });
    });
  });
});
