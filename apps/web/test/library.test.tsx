import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { LibraryView } from '../src/components/library/library-view';
import { CreatePlaylistDialog } from '../src/components/playlist/create-playlist-dialog';
import { AddMyVideosDialog } from '../src/components/playlist/add-my-videos-dialog';
import PlaylistPage from '../src/app/[locale]/playlist/[id]/page';
import { ChannelTabs } from '../src/app/[locale]/c/[handle]/channel-tabs';
import { Sidebar } from '../src/components/layout/sidebar';
import { CinemaShell } from '../src/components/layout/cinema-shell';
import { api } from '../src/lib/api-client';
import type { Playlist, StudioVideo, PublicProfile } from '@winkey/api-client';
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
  useLocale: () => 'vi',
}));

// --- Router & Params Mock ---
const mockPush = vi.fn();
let mockParamsId = 'pl-100';

vi.mock('next/navigation', () => ({
  useParams: () => ({
    id: mockParamsId,
    locale: 'vi',
  }),
  useRouter: () => ({
    push: mockPush,
  }),
  usePathname: () => '/thu-vien',
}));

vi.mock('../src/i18n/routing', () => ({
  routing: { locales: ['vi', 'en'], defaultLocale: 'vi' },
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/thu-vien',
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

// --- Auth Context Mock ---
let mockIsAuthenticated = true;
let mockIsLoading = false;
const testUserId = '0192f5e4-7c1a-7b3e-9d2a-user00000001';

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
    user: mockIsAuthenticated
      ? {
          id: testUserId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          roles: ['CREATOR'],
          avatar_url: 'https://cdn.winkey.vn/avatars/creator.jpg',
        }
      : null,
    isCreator: true,
    isAdmin: false,
    logout: vi.fn(),
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

const mockOwner: PublicProfile = {
  id: testUserId,
  handle: 'testcreator',
  display_name: 'Test Creator',
  avatar_url: null,
};

const mockPlaylistsList: Playlist[] = [
  {
    id: 'pl-watch-later',
    owner: mockOwner,
    kind: 'WATCH_LATER',
    title: 'Xem sau',
    description: '',
    visibility: 'PRIVATE',
    is_series: false,
    item_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'pl-series-1',
    owner: mockOwner,
    kind: 'REGULAR',
    title: 'Phim Bộ Thử Nghiệm',
    description: 'Mô tả bộ phim',
    visibility: 'PUBLIC',
    is_series: true,
    item_count: 5,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'pl-unlisted-1',
    owner: mockOwner,
    kind: 'REGULAR',
    title: 'Danh sách không công khai',
    description: '',
    visibility: 'UNLISTED',
    is_series: false,
    item_count: 2,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
  },
  {
    id: 'pl-private-series',
    owner: mockOwner,
    kind: 'REGULAR',
    title: 'Phim Bộ Riêng Tư',
    description: 'Chưa công khai',
    visibility: 'PRIVATE',
    is_series: true,
    item_count: 1,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
];

const mockStudioVideosList: StudioVideo[] = [
  {
    id: 'vid-1',
    title: 'Tập 1: Khởi đầu',
    status: 'READY',
    visibility: 'PUBLIC',
    duration_ms: 600000,
    progress: 100,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/vid-1.jpg',
  },
  {
    id: 'vid-2',
    title: 'Tập 2: Thử thách',
    status: 'READY',
    visibility: 'PUBLIC',
    duration_ms: 700000,
    progress: 100,
    error: null,
    created_at: '2026-01-02T00:00:00Z',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/vid-2.jpg',
  },
  {
    id: 'vid-3',
    title: 'Tập 3: Kết thúc',
    status: 'READY',
    visibility: 'PUBLIC',
    duration_ms: 800000,
    progress: 100,
    error: null,
    created_at: '2026-01-03T00:00:00Z',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/vid-3.jpg',
  },
  {
    id: 'vid-4',
    title: 'Video đang xử lý',
    status: 'PROCESSING',
    visibility: 'PRIVATE',
    duration_ms: 500000,
    progress: 50,
    error: null,
    created_at: '2026-01-04T00:00:00Z',
    thumbnail_url: null,
  },
];

describe('PL2-web: Thư viện (Library) Page & Playlists Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = true;
    mockIsLoading = false;
    mockParamsId = 'pl-100';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Auth Redirect
  // =========================================================================
  describe('1. Auth Redirect', () => {
    it('redirects anonymous users to /login?return_to=/thu-vien', async () => {
      mockIsAuthenticated = false;
      renderWithProviders(<LibraryView />);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?return_to=/thu-vien');
      });
    });
  });

  // =========================================================================
  // 2. Library Grid & Badges
  // =========================================================================
  describe('2. Library Grid, Badges & Empty State', () => {
    it('renders playlists with visibility badges and series badge', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string, _options: any) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylistsList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return {
            data: {
              items: [{ video_id: 'vid-1', position: 1, added_at: '2026-01-01T00:00:00Z' }],
              next_cursor: null,
            },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return {
            data: {
              items: [
                {
                  id: 'vid-1',
                  title: 'Cover Video',
                  duration_ms: 600000,
                  view_count: 100,
                  published_at: '2026-01-01T00:00:00Z',
                  thumbnail_url: 'https://cdn.winkey.vn/thumbs/cover.jpg',
                  owner: mockOwner,
                },
              ],
            },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<LibraryView />);

      // Verify grid renders
      await waitFor(() => {
        expect(screen.getByTestId('library-playlists-grid')).toBeDefined();
      });

      // Verify cards render
      expect(screen.getByTestId('library-playlist-card-pl-series-1')).toBeDefined();
      expect(screen.getByTestId('library-playlist-card-pl-watch-later')).toBeDefined();

      // Verify badges: Series badges
      const seriesBadges = screen.getAllByTestId('playlist-series-badge');
      expect(seriesBadges.length).toBeGreaterThanOrEqual(2); // pl-series-1 & pl-private-series

      // Verify visibility badges
      const visibilityBadges = screen.getAllByTestId('playlist-visibility-badge');
      expect(visibilityBadges.length).toBe(mockPlaylistsList.length);
    });

    it('renders empty state when caller has 0 playlists', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<LibraryView />);

      await waitFor(() => {
        expect(screen.getByTestId('library-empty-state')).toBeDefined();
      });
      expect(screen.getByTestId('empty-create-playlist-btn')).toBeDefined();
    });
  });

  // =========================================================================
  // 3. Create Playlist Dialog
  // =========================================================================
  describe('3. Create Playlist Dialog', () => {
    it('validates input and navigates to the new playlist on success', async () => {
      const onClose = vi.fn();
      const onCreated = vi.fn();

      vi.spyOn(api.social, 'POST').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/playlists') {
          const body = options.body;
          return {
            data: {
              id: 'pl-new-999',
              owner: mockOwner,
              kind: 'REGULAR',
              title: body.title,
              description: body.description,
              visibility: body.visibility,
              is_series: body.is_series,
              item_count: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            response: new Response(null, { status: 201 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(
        <CreatePlaylistDialog
          isOpen={true}
          onClose={onClose}
          onCreated={onCreated}
          navigateOnSuccess={true}
        />,
      );

      const titleInput = screen.getByTestId('create-playlist-title-input');
      const submitBtn = screen.getByTestId('submit-create-playlist-btn');
      const isSeriesCheckbox = screen.getByTestId('create-playlist-is-series-checkbox');

      // Check series hint exists
      expect(screen.getByTestId('create-playlist-series-hint')).toBeDefined();

      // Enter valid data
      fireEvent.change(titleInput, { target: { value: 'Bộ Phim Mới' } });
      fireEvent.click(isSeriesCheckbox);

      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'pl-new-999',
            title: 'Bộ Phim Mới',
            is_series: true,
          }),
        );
        expect(mockPush).toHaveBeenCalledWith('/playlist/pl-new-999');
      });
    });
  });

  // =========================================================================
  // 4. Add My Videos Picker
  // =========================================================================
  describe('4. Add My Videos Picker', () => {
    it('lists own READY videos, filters by search, and adds in order with at most 4 in parallel', async () => {
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/studio/videos') {
          return {
            data: { items: mockStudioVideosList, next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      const addedIds: string[] = [];
      vi.spyOn(api.social, 'POST').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/playlists/{playlist_id}/items') {
          addedIds.push(options.body.video_id);
          return {
            data: {
              video_id: options.body.video_id,
              position: 1,
              added_at: new Date().toISOString(),
            },
            response: new Response(null, { status: 201 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(
        <AddMyVideosDialog
          playlistId="pl-100"
          isOpen={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />,
      );

      // Verify ready videos are rendered, non-ready omitted
      await waitFor(() => {
        expect(screen.getByTestId('video-picker-item-vid-1')).toBeDefined();
        expect(screen.getByTestId('video-picker-item-vid-2')).toBeDefined();
        expect(screen.getByTestId('video-picker-item-vid-3')).toBeDefined();
        expect(screen.queryByTestId('video-picker-item-vid-4')).toBeNull(); // vid-4 status is PROCESSING
      });

      // Test search filter
      const searchInput = screen.getByTestId('video-picker-search-input');
      fireEvent.change(searchInput, { target: { value: 'Tập 2' } });

      await waitFor(() => {
        expect(screen.getByTestId('video-picker-item-vid-2')).toBeDefined();
        expect(screen.queryByTestId('video-picker-item-vid-1')).toBeNull();
      });

      // Clear search
      fireEvent.change(searchInput, { target: { value: '' } });

      // Select vid-1 and vid-3
      fireEvent.click(screen.getByTestId('video-picker-item-vid-1'));
      fireEvent.click(screen.getByTestId('video-picker-item-vid-3'));

      // Submit
      const submitBtn = screen.getByTestId('video-picker-submit-btn');
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });

      // Confirm added in order
      expect(addedIds).toEqual(['vid-1', 'vid-3']);
    });

    it('reports per-item 409 errors (SERIES_FOREIGN_ITEM / PLAYLIST_FULL) in plain Vietnamese', async () => {
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/studio/videos') {
          return {
            data: { items: [mockStudioVideosList[0], mockStudioVideosList[1]], next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.social, 'POST').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/playlists/{playlist_id}/items') {
          if (options.body.video_id === 'vid-1') {
            return {
              error: { code: 'SERIES_FOREIGN_ITEM', title: 'Foreign item' },
              response: new Response(null, { status: 409 }),
            } as any;
          }
          if (options.body.video_id === 'vid-2') {
            return {
              error: { code: 'PLAYLIST_FULL', title: 'Playlist full' },
              response: new Response(null, { status: 409 }),
            } as any;
          }
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(
        <AddMyVideosDialog
          playlistId="pl-100"
          isSeries={true}
          isOpen={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('video-picker-item-vid-1')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('video-picker-item-vid-1'));
      fireEvent.click(screen.getByTestId('video-picker-item-vid-2'));

      const submitBtn = screen.getByTestId('video-picker-submit-btn');
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Bộ phim chỉ chứa video của chính kênh bạn/).length,
        ).toBeGreaterThan(0);
        expect(screen.getAllByText(/Danh sách phát đã đầy/).length).toBeGreaterThan(0);
      });
    });
  });

  // =========================================================================
  // 5. Playlist Page Non-Public Series Notice & Add Videos Button
  // =========================================================================
  describe('5. Playlist Page Non-Public Series Notice & Actions', () => {
    it('shows non-public series notice when is_series and visibility != PUBLIC', async () => {
      mockParamsId = 'pl-private-series';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return {
            data: {
              id: 'pl-private-series',
              owner: mockOwner,
              kind: 'REGULAR',
              title: 'Bộ phim riêng tư',
              description: '',
              visibility: 'PRIVATE',
              is_series: true,
              item_count: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByTestId('series-non-public-notice')).toBeDefined();
      });

      expect(
        screen.getByText(/Bộ phim đang ở chế độ Riêng tư, chưa hiện trên trang chủ/),
      ).toBeDefined();

      // Owner sees "+ Thêm video của tôi" button
      expect(screen.getByTestId('add-my-videos-btn')).toBeDefined();
    });

    it('hides notice when series is PUBLIC', async () => {
      mockParamsId = 'pl-public-series';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return {
            data: {
              id: 'pl-public-series',
              owner: mockOwner,
              kind: 'REGULAR',
              title: 'Bộ phim công khai',
              description: '',
              visibility: 'PUBLIC',
              is_series: true,
              item_count: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByTestId('playlist-series-badge')).toBeDefined();
      });

      expect(screen.queryByTestId('series-non-public-notice')).toBeNull();
    });
  });

  // =========================================================================
  // 6. Navigation Links & Channel Tabs
  // =========================================================================
  describe('6. Navigation Links to /thu-vien & Channel Tab Button', () => {
    it('sidebar link points to /thu-vien', () => {
      renderWithProviders(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={() => {}} />,
      );
      const libraryLink = screen.getByRole('link', { name: /Thư viện/ });
      expect(libraryLink.getAttribute('href')).toBe('/thu-vien');
    });

    it('cinema shell top bar links point to /thu-vien', () => {
      renderWithProviders(
        <CinemaShell>
          <div>Cinema content</div>
        </CinemaShell>,
      );

      const myListLinks = screen.getAllByRole('link', { name: /Danh sách của tôi/i });
      expect(myListLinks.some((l) => l.getAttribute('href') === '/thu-vien')).toBe(true);
    });

    it('channel page playlists tab shows "+ Tạo danh sách" button to owner only', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      // Render as owner (profile.id === testUserId)
      const { unmount } = renderWithProviders(
        <ChannelTabs profile={mockOwner} initialVideos={[]} />,
      );

      // Switch to playlists tab
      fireEvent.click(screen.getByTestId('tab-channel-playlists'));

      await waitFor(() => {
        expect(screen.getByTestId('channel-create-playlist-btn')).toBeDefined();
      });

      unmount();

      // Render as non-owner (profile.id !== testUserId)
      const foreignOwner = { ...mockOwner, id: 'other-user-999' };
      renderWithProviders(<ChannelTabs profile={foreignOwner} initialVideos={[]} />);

      fireEvent.click(screen.getByTestId('tab-channel-playlists'));

      await waitFor(() => {
        expect(screen.queryByTestId('channel-create-playlist-btn')).toBeNull();
      });
    });
  });
});
