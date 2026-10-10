import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { SavePlaylistDialog } from '../src/components/playlist/save-playlist-dialog';
import PlaylistPage from '../src/app/[locale]/playlist/[id]/page';
import { ChannelTabs } from '../src/app/[locale]/c/[handle]/channel-tabs';
import {
  getCachedWatchLaterId,
  resetCachedWatchLaterId,
  addToWatchLater,
  computeBeforeVideoId,
  computeDropBeforeVideoId,
} from '../src/lib/playlist/playlist-utils';
import { api } from '../src/lib/api-client';
import type { Playlist, PlaylistItem, VideoSummary, PublicProfile } from '@winkey/api-client';
import { server } from '../src/mocks/server';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

// --- Locale Mock ---
const activeLocale: 'vi' | 'en' = 'vi';

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
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
  },
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
}));

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/playlist/pl-100',
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
        e.preventDefault();
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
const testOwnerId = '0192f5e4-1000-7000-8000-000000000001';
let currentUserId = testOwnerId;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated
      ? {
          id: currentUserId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          roles: ['creator'],
        }
      : null,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('PL1-web: Playlists & Watch Later Unit Tests (ADR-024)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCachedWatchLaterId();
    mockIsAuthenticated = true;
    currentUserId = testOwnerId;
    mockParamsId = 'pl-100';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Save Dialog: add/remove/create + rollback on 500 + 409 toasts
  // =========================================================================
  describe('1. Save Dialog', () => {
    const mockPlaylists: Playlist[] = [
      {
        id: 'wl-1',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        kind: 'WATCH_LATER',
        title: 'Xem sau',
        description: '',
        visibility: 'PRIVATE',
        item_count: 5,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'pl-go',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        kind: 'REGULAR',
        title: 'Học Go cơ bản',
        description: 'Khoá học lập trình Go',
        visibility: 'PUBLIC',
        item_count: 10,
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      },
    ];

    it('lists user playlists with watch-later first and pre-checks membership', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylists, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: ['wl-1'] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(
        <SavePlaylistDialog videoId="video-test-1" isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Xem sau')).toBeDefined();
        expect(screen.getByText('Học Go cơ bản')).toBeDefined();
      });

      const wlCheckbox = screen.getByTestId('playlist-checkbox-wl-1') as HTMLInputElement;
      const goCheckbox = screen.getByTestId('playlist-checkbox-pl-go') as HTMLInputElement;

      expect(wlCheckbox.checked).toBe(true);
      expect(goCheckbox.checked).toBe(false);
    });

    it('toggles checkbox: adding calls POST addPlaylistItem and removing calls DELETE', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylists, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: ['wl-1'] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        data: { video_id: 'video-test-1', position: 1048576, added_at: '2026-03-01T00:00:00Z' },
        response: new Response(null, { status: 201 }),
      } as any);

      const deleteSpy = vi.spyOn(api.social, 'DELETE').mockResolvedValue({
        response: new Response(null, { status: 204 }),
      } as any);

      renderWithProviders(
        <SavePlaylistDialog videoId="video-test-1" isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('playlist-checkbox-pl-go')).toBeDefined();
      });

      // Check pl-go -> triggers add
      const goCheckbox = screen.getByTestId('playlist-checkbox-pl-go') as HTMLInputElement;
      fireEvent.click(goCheckbox);

      expect(goCheckbox.checked).toBe(true);
      expect(postSpy).toHaveBeenCalledWith(
        '/v1/playlists/{playlist_id}/items',
        expect.objectContaining({
          params: { path: { playlist_id: 'pl-go' } },
          body: { video_id: 'video-test-1' },
        }),
      );

      // Uncheck wl-1 -> triggers remove
      const wlCheckbox = screen.getByTestId('playlist-checkbox-wl-1') as HTMLInputElement;
      fireEvent.click(wlCheckbox);

      expect(wlCheckbox.checked).toBe(false);
      expect(deleteSpy).toHaveBeenCalledWith(
        '/v1/playlists/{playlist_id}/items/{video_id}',
        expect.objectContaining({
          params: { path: { playlist_id: 'wl-1', video_id: 'video-test-1' } },
        }),
      );
    });

    it('rolls back checkbox state on 500 server error', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylists, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: [] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.social, 'POST').mockRejectedValue(new Error('Internal Server Error 500'));

      renderWithProviders(
        <SavePlaylistDialog videoId="video-test-1" isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('playlist-checkbox-pl-go')).toBeDefined();
      });

      const goCheckbox = screen.getByTestId('playlist-checkbox-pl-go') as HTMLInputElement;
      expect(goCheckbox.checked).toBe(false);

      // Click to check
      fireEvent.click(goCheckbox);

      // Wait for error handling and rollback
      await waitFor(() => {
        expect(goCheckbox.checked).toBe(false);
        expect(screen.getByText('Lỗi kết nối mạng, vui lòng thử lại.')).toBeDefined();
      });
    });

    it('shows toast and rolls back on 409 PLAYLIST_FULL', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylists, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: [] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.social, 'POST').mockResolvedValue({
        error: { code: 'PLAYLIST_FULL', title: 'Playlist full' },
        response: new Response(null, { status: 409 }),
      } as any);

      renderWithProviders(
        <SavePlaylistDialog videoId="video-test-1" isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('playlist-checkbox-pl-go')).toBeDefined();
      });

      const goCheckbox = screen.getByTestId('playlist-checkbox-pl-go') as HTMLInputElement;
      fireEvent.click(goCheckbox);

      await waitFor(() => {
        expect(screen.getByText('Danh sách phát đã đầy (tối đa 5.000 video).')).toBeDefined();
        expect(goCheckbox.checked).toBe(false);
      });
    });

    it('creates new playlist and shows toast on 409 PLAYLIST_LIMIT', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: { items: mockPlaylists, next_cursor: null },
            response: new Response(),
          } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: [] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.social, 'POST').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists') {
          return {
            error: { code: 'PLAYLIST_LIMIT', title: 'Playlist limit reached' },
            response: new Response(null, { status: 409 }),
          } as any;
        }
        return { response: new Response() } as any;
      });

      renderWithProviders(
        <SavePlaylistDialog videoId="video-test-1" isOpen={true} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('open-create-playlist-btn')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('open-create-playlist-btn'));

      const titleInput = screen.getByTestId('new-playlist-title-input');
      fireEvent.change(titleInput, { target: { value: 'Danh sách mới quá giới hạn' } });

      fireEvent.click(screen.getByTestId('submit-create-playlist-btn'));

      await waitFor(() => {
        expect(screen.getByText('Bạn đã đạt giới hạn tối đa 200 danh sách phát.')).toBeDefined();
      });
    });
  });

  // =========================================================================
  // 2. Watch-later ID cached: exactly one getWatchLater per session
  // =========================================================================
  describe('2. Watch-later session cache', () => {
    it('caches watch-later ID across multiple calls without re-fetching', async () => {
      const getSpy = vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: {
          id: 'wl-cached-uuid-12345',
          kind: 'WATCH_LATER',
          title: 'Xem sau',
          visibility: 'PRIVATE',
        },
        response: new Response(),
      } as any);

      resetCachedWatchLaterId();

      // First call -> calls API
      const id1 = await getCachedWatchLaterId();
      expect(id1).toBe('wl-cached-uuid-12345');
      expect(getSpy).toHaveBeenCalledTimes(1);

      // Second call -> returns cached ID
      const id2 = await getCachedWatchLaterId();
      expect(id2).toBe('wl-cached-uuid-12345');
      expect(getSpy).toHaveBeenCalledTimes(1);

      // Third call -> still cached
      const id3 = await getCachedWatchLaterId();
      expect(id3).toBe('wl-cached-uuid-12345');
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('addToWatchLater uses cached watch-later ID and calls POST addPlaylistItem', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: {
          id: 'wl-cached-uuid-12345',
          kind: 'WATCH_LATER',
          title: 'Xem sau',
        },
        response: new Response(),
      } as any);

      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        data: { video_id: 'v-100', position: 1048576, added_at: '2026-03-01T00:00:00Z' },
        response: new Response(null, { status: 201 }),
      } as any);

      const toastFn = vi.fn();
      const success = await addToWatchLater('v-100', { showToast: toastFn });

      expect(success).toBe(true);
      expect(postSpy).toHaveBeenCalledWith(
        '/v1/playlists/{playlist_id}/items',
        expect.objectContaining({
          params: { path: { playlist_id: 'wl-cached-uuid-12345' } },
          body: { video_id: 'v-100' },
        }),
      );
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Đã thêm vào danh sách Xem sau',
          type: 'success',
        }),
      );
    });

    it('invalidates cache on logout and account switch (A caches -> logout -> B logs in -> calls getWatchLater again)', async () => {
      let callCount = 0;
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/me/watch-later') {
          callCount++;
          return {
            data: {
              id: currentUserId === 'user-A' ? 'wl-A' : 'wl-B',
              owner: { id: currentUserId },
              kind: 'WATCH_LATER',
            },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      // User A caches
      currentUserId = 'user-A';
      const idA = await getCachedWatchLaterId('user-A');
      expect(idA).toBe('wl-A');
      expect(callCount).toBe(1);

      // Calling again with same user -> cached, no additional GET
      const idA2 = await getCachedWatchLaterId('user-A');
      expect(idA2).toBe('wl-A');
      expect(callCount).toBe(1);

      // User A logs out -> cache reset
      resetCachedWatchLaterId();
      currentUserId = 'user-B';

      // User B logs in -> getWatchLater called again
      const idB = await getCachedWatchLaterId('user-B');
      expect(idB).toBe('wl-B');
      expect(callCount).toBe(2);
    });
  });

  // =========================================================================
  // 3. Playlist page: merges items with batch results in order & handles omitted IDs
  // =========================================================================
  describe('3. Playlist page batch merge and omitted IDs', () => {
    const mockPlaylist: Playlist = {
      id: 'pl-100',
      owner: {
        id: testOwnerId,
        handle: 'testcreator',
        display_name: 'Test Creator',
        avatar_url: null,
      },
      kind: 'REGULAR',
      title: 'Danh sách phát thử nghiệm',
      description: 'Mô tả thử nghiệm',
      visibility: 'PUBLIC',
      item_count: 3,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    const mockItems: PlaylistItem[] = [
      { video_id: 'vid-1', position: 1048576, added_at: '2026-01-01T00:00:00Z' },
      { video_id: 'vid-2-deleted', position: 2097152, added_at: '2026-01-02T00:00:00Z' },
      { video_id: 'vid-3', position: 3145728, added_at: '2026-01-03T00:00:00Z' },
    ];

    const mockBatchVideos: VideoSummary[] = [
      {
        id: 'vid-1',
        title: 'Video Số 1',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        duration_ms: 120000,
        thumbnail_url: 'https://example.com/thumb1.jpg',
        view_count: 1000,
        published_at: '2026-01-01T00:00:00Z',
      },
      // vid-2-deleted is omitted by batchGetVideos!
      {
        id: 'vid-3',
        title: 'Video Số 3',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        duration_ms: 300000,
        thumbnail_url: 'https://example.com/thumb3.jpg',
        view_count: 5000,
        published_at: '2026-01-03T00:00:00Z',
      },
    ];

    it('merges items with batch results in exact order and shows "Video không còn khả dụng" only to owner', async () => {
      currentUserId = testOwnerId; // Current user is owner

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items: mockItems, next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      const batchSpy = vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Số 1')).toBeDefined();
        expect(screen.getByText('Video Số 3')).toBeDefined();
      });

      // ONE batchGetVideos called
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).toHaveBeenCalledWith(
        '/v1/videos/batch',
        expect.objectContaining({
          params: { query: { ids: ['vid-1', 'vid-2-deleted', 'vid-3'] } },
          querySerializer: { array: { style: 'form', explode: false } },
        }),
      );

      // Owner sees "Video không còn khả dụng" placeholder with a remove button
      expect(screen.getByText('Video không còn khả dụng')).toBeDefined();
      expect(screen.getByTestId('remove-unavailable-vid-2-deleted')).toBeDefined();
    });

    it('omits unavailable video row completely when viewer is not the owner', async () => {
      currentUserId = 'different-viewer-id-999'; // Non-owner viewer

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items: mockItems, next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/videos/batch') {
          return { data: { items: mockBatchVideos }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Số 1')).toBeDefined();
        expect(screen.getByText('Video Số 3')).toBeDefined();
      });

      // Unavailable row should NOT be rendered for non-owner
      expect(screen.queryByText('Video không còn khả dụng')).toBeNull();
      expect(screen.queryByTestId('remove-unavailable-vid-2-deleted')).toBeNull();
    });

    it('sends ids with style: form, explode: false producing comma-separated ids in request URL', async () => {
      server.listen({ onUnhandledRequest: 'bypass' });
      let capturedUrl = '';
      server.events.on('request:start', ({ request }) => {
        if (request.url.includes('/v1/videos/batch')) {
          capturedUrl = request.url;
        }
      });

      try {
        await api.video.GET('/v1/videos/batch', {
          params: { query: { ids: ['vid-1', 'vid-3'] } },
          querySerializer: { array: { style: 'form', explode: false } },
        });

        expect(capturedUrl).toMatch(/ids=vid-1(%2C|,)vid-3/);
      } finally {
        server.close();
      }
    });

    it('MSW batch handler requires single comma-separated ids parameter (rejects exploded form)', async () => {
      server.listen({ onUnhandledRequest: 'bypass' });
      try {
        // 1. Exploded form (?ids=a&ids=b) -> 400 Bad Request
        const badRes = await fetch('http://localhost:8080/v1/videos/batch?ids=vid-1&ids=vid-3');
        expect(badRes.status).toBe(400);
        const badJson = await badRes.json();
        expect(badJson.status).toBe(400);

        // 2. Comma-separated form (?ids=a,b) -> 200 OK
        const okRes = await fetch('http://localhost:8080/v1/videos/batch?ids=vid-1,vid-3');
        expect(okRes.status).toBe(200);
      } finally {
        server.close();
      }
    });
  });

  // =========================================================================
  // 4. Reorder: calls move with the right before_video_id (keyboard and drag)
  // =========================================================================
  describe('4. Reorder calculations and API move calls', () => {
    it('computes correct before_video_id for keyboard up and down moves', () => {
      const items = [{ video_id: 'A' }, { video_id: 'B' }, { video_id: 'C' }];

      // Move B up -> placed before A
      expect(computeBeforeVideoId(items, 1, 'up')).toBe('A');

      // Move A up (at index 0) -> undefined (cannot move up)
      expect(computeBeforeVideoId(items, 0, 'up')).toBeUndefined();

      // Move A down -> placed after B, which is before C
      expect(computeBeforeVideoId(items, 0, 'down')).toBe('C');

      // Move B down -> placed after C, which is at the end => null
      expect(computeBeforeVideoId(items, 1, 'down')).toBeNull();

      // Move C down (at index 2) -> undefined (cannot move down)
      expect(computeBeforeVideoId(items, 2, 'down')).toBeUndefined();
    });

    it('computes correct before_video_id for drag and drop operations', () => {
      const items = [{ video_id: 'A' }, { video_id: 'B' }, { video_id: 'C' }, { video_id: 'D' }];

      // Drag D (index 3) and drop on B (index 1) -> target < source -> placed before B
      expect(computeDropBeforeVideoId(items, 3, 1)).toBe('B');

      // Drag A (index 0) and drop on B (index 1) -> placed before C
      expect(computeDropBeforeVideoId(items, 0, 1)).toBe('C');

      // Drag A (index 0) and drop on D (index 3, last item) -> placed at the end => null
      expect(computeDropBeforeVideoId(items, 0, 3)).toBeNull();

      // Drag A onto A -> undefined
      expect(computeDropBeforeVideoId(items, 0, 0)).toBeUndefined();
    });

    it('keyboard move up/down triggers movePlaylistItem with computed before_video_id', async () => {
      currentUserId = testOwnerId;

      const mockPlaylist: Playlist = {
        id: 'pl-reorder',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        kind: 'REGULAR',
        title: 'Playlist Reorder',
        description: '',
        visibility: 'PUBLIC',
        item_count: 3,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const items: PlaylistItem[] = [
        { video_id: 'V1', position: 1048576, added_at: '2026-01-01T00:00:00Z' },
        { video_id: 'V2', position: 2097152, added_at: '2026-01-02T00:00:00Z' },
        { video_id: 'V3', position: 3145728, added_at: '2026-01-03T00:00:00Z' },
      ];

      const videos: VideoSummary[] = [
        {
          id: 'V1',
          title: 'Video 1',
          owner: mockPlaylist.owner,
          duration_ms: 1000,
          thumbnail_url: 'https://example.com/thumb1.jpg',
          view_count: 0,
          published_at: '',
        },
        {
          id: 'V2',
          title: 'Video 2',
          owner: mockPlaylist.owner,
          duration_ms: 2000,
          thumbnail_url: 'https://example.com/thumb2.jpg',
          view_count: 0,
          published_at: '',
        },
        {
          id: 'V3',
          title: 'Video 3',
          owner: mockPlaylist.owner,
          duration_ms: 3000,
          thumbnail_url: 'https://example.com/thumb3.jpg',
          view_count: 0,
          published_at: '',
        },
      ];

      mockParamsId = 'pl-reorder';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items, next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: videos },
        response: new Response(),
      } as any);

      const moveSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        data: { video_id: 'V2', position: 524288, added_at: '2026-01-02T00:00:00Z' },
        response: new Response(),
      } as any);

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByTestId('move-up-btn-V2')).toBeDefined();
      });

      // Move V2 up -> should call move with before_video_id: 'V1'
      fireEvent.click(screen.getByTestId('move-up-btn-V2'));

      expect(moveSpy).toHaveBeenCalledWith(
        '/v1/playlists/{playlist_id}/items/{video_id}/move',
        expect.objectContaining({
          params: { path: { playlist_id: 'pl-reorder', video_id: 'V2' } },
          body: { before_video_id: 'V1' },
        }),
      );
    });
  });

  // =========================================================================
  // 5. Owner-only controls hidden for others
  // =========================================================================
  describe('5. Owner-only controls', () => {
    const mockPlaylist: Playlist = {
      id: 'pl-privacy',
      owner: {
        id: testOwnerId,
        handle: 'testcreator',
        display_name: 'Test Creator',
        avatar_url: null,
      },
      kind: 'REGULAR',
      title: 'Public Playlist',
      description: 'Description',
      visibility: 'PUBLIC',
      item_count: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    const mockItem: PlaylistItem = {
      video_id: 'vid-priv-1',
      position: 1048576,
      added_at: '2026-01-01T00:00:00Z',
    };

    const mockVideoSummary: VideoSummary = {
      id: 'vid-priv-1',
      title: 'Video Trong Playlist',
      owner: mockPlaylist.owner,
      duration_ms: 60000,
      thumbnail_url: 'https://example.com/thumb.jpg',
      view_count: 50,
      published_at: '2026-01-01T00:00:00Z',
    };

    it('shows edit, delete, reorder and remove buttons to playlist owner', async () => {
      currentUserId = testOwnerId;
      mockParamsId = 'pl-privacy';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return {
            data: { items: [mockItem], next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: [mockVideoSummary] },
        response: new Response(),
      } as any);

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-playlist-btn')).toBeDefined();
        expect(screen.getByTestId('delete-playlist-btn')).toBeDefined();
        expect(screen.getByTestId('remove-item-btn-vid-priv-1')).toBeDefined();
      });
    });

    it('hides edit, delete, reorder and remove buttons for other viewers', async () => {
      currentUserId = 'other-user-999';
      mockParamsId = 'pl-privacy';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockPlaylist, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return {
            data: { items: [mockItem], next_cursor: null },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: [mockVideoSummary] },
        response: new Response(),
      } as any);

      renderWithProviders(<PlaylistPage />);

      await waitFor(() => {
        expect(screen.getByText('Video Trong Playlist')).toBeDefined();
      });

      expect(screen.queryByTestId('edit-playlist-btn')).toBeNull();
      expect(screen.queryByTestId('delete-playlist-btn')).toBeNull();
      expect(screen.queryByTestId('remove-item-btn-vid-priv-1')).toBeNull();
      expect(screen.queryByTestId('move-up-btn-vid-priv-1')).toBeNull();
      expect(screen.queryByTestId('move-down-btn-vid-priv-1')).toBeNull();
    });
  });

  // =========================================================================
  // 6. Channel tab "Danh sách phát"
  // =========================================================================
  describe('6. Channel Tab Playlists', () => {
    const mockProfile: PublicProfile = {
      id: testOwnerId,
      handle: 'testcreator',
      display_name: 'Test Creator',
      avatar_url: null,
    };

    const mockChannelPlaylists: Playlist[] = [
      {
        id: 'pl-ch-1',
        owner: mockProfile,
        kind: 'REGULAR',
        title: 'Playlist Kênh 1',
        description: '',
        visibility: 'PUBLIC',
        item_count: 8,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'pl-ch-2',
        owner: mockProfile,
        kind: 'REGULAR',
        title: 'Playlist Kênh 2',
        description: '',
        visibility: 'PUBLIC',
        item_count: 15,
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
    ];

    it('fetches and lists only what listChannelPlaylists returns when tab is selected', async () => {
      const getSpy = vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { items: mockChannelPlaylists, next_cursor: null },
        response: new Response(),
      } as any);

      renderWithProviders(<ChannelTabs profile={mockProfile} initialVideos={[]} />);

      // Initially on Videos tab
      expect(screen.queryByText('Playlist Kênh 1')).toBeNull();

      // Click "Danh sách phát" tab
      fireEvent.click(screen.getByTestId('tab-channel-playlists'));

      await waitFor(() => {
        expect(screen.getByText('Playlist Kênh 1')).toBeDefined();
        expect(screen.getByText('Playlist Kênh 2')).toBeDefined();
      });

      expect(getSpy).toHaveBeenCalledWith(
        '/v1/channels/{channel_id}/playlists',
        expect.objectContaining({
          params: { path: { channel_id: testOwnerId } },
        }),
      );
    });
  });

  // =========================================================================
  // 8. CIN2: Series Playlist (Bộ phim checkbox, 409 SERIES_FOREIGN_ITEM, badge)
  // =========================================================================
  describe('8. Series Playlist (CIN2 / ADR-035)', () => {
    it('provides "Bộ phim" checkbox in SavePlaylistDialog and handles 409 SERIES_FOREIGN_ITEM', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        if (path === '/v1/videos/{video_id}/playlist-membership') {
          return { data: { playlist_ids: [] }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      let postPlaylistBody: any = null;
      vi.spyOn(api.social, 'POST').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/playlists') {
          postPlaylistBody = options?.body;
          return {
            error: {
              code: 'SERIES_FOREIGN_ITEM',
              title: 'Bộ phim chỉ chứa video của chính kênh bạn.',
            },
            response: new Response(null, { status: 409 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(
        <SavePlaylistDialog videoId="foreign-vid-1" isOpen={true} onClose={vi.fn()} />,
      );

      // Open creation form
      await waitFor(() => {
        expect(screen.getByTestId('open-create-playlist-btn')).toBeDefined();
      });
      fireEvent.click(screen.getByTestId('open-create-playlist-btn'));

      // Check for "Bộ phim" checkbox
      const isSeriesCheckbox = screen.getByTestId(
        'new-playlist-is-series-checkbox',
      ) as HTMLInputElement;
      expect(isSeriesCheckbox).toBeDefined();
      expect(isSeriesCheckbox.checked).toBe(false);

      // Fill form and check "Bộ phim"
      fireEvent.change(screen.getByTestId('new-playlist-title-input'), {
        target: { value: 'Bộ Phim Mới' },
      });
      fireEvent.click(isSeriesCheckbox);
      expect(isSeriesCheckbox.checked).toBe(true);

      // Submit form
      fireEvent.click(screen.getByTestId('submit-create-playlist-btn'));

      await waitFor(() => {
        expect(postPlaylistBody).toEqual({
          title: 'Bộ Phim Mới',
          description: '',
          visibility: 'PRIVATE',
          is_series: true,
        });
        // 409 SERIES_FOREIGN_ITEM error toast is shown
        expect(screen.getByText('Bộ phim chỉ chứa video của chính kênh bạn.')).toBeDefined();
      });
    });

    it('renders "Bộ phim" badge on playlist page and allows editing is_series with 409 toast', async () => {
      const mockSeriesPlaylistData: Playlist = {
        id: 'pl-series-100',
        owner: {
          id: testOwnerId,
          handle: 'testcreator',
          display_name: 'Test Creator',
          avatar_url: null,
        },
        kind: 'REGULAR',
        title: 'Phim Bộ Thử Nghiệm',
        description: 'Mô tả bộ phim',
        visibility: 'PUBLIC',
        item_count: 5,
        is_series: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/playlists/{playlist_id}') {
          return { data: mockSeriesPlaylistData, response: new Response() } as any;
        }
        if (path === '/v1/playlists/{playlist_id}/items') {
          return { data: { items: [], next_cursor: null }, response: new Response() } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      let patchBody: any = null;
      vi.spyOn(api.social, 'PATCH').mockImplementation(async (path: string, options: any) => {
        if (path === '/v1/playlists/{playlist_id}') {
          patchBody = options?.body;
          return {
            error: {
              code: 'SERIES_FOREIGN_ITEM',
              title: 'Bộ phim chỉ chứa video của chính kênh bạn.',
            },
            response: new Response(null, { status: 409 }),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<PlaylistPage />);

      // Verify "Bộ phim" badge is displayed
      await waitFor(() => {
        const badge = screen.getByTestId('playlist-series-badge');
        expect(badge).toBeDefined();
        expect(badge.textContent).toBe('Bộ phim');
      });

      // Open edit modal
      fireEvent.click(screen.getByTestId('edit-playlist-btn'));

      // Verify edit modal contains "Bộ phim" checkbox, checked by default
      const editCheckbox = screen.getByTestId(
        'edit-playlist-is-series-checkbox',
      ) as HTMLInputElement;
      expect(editCheckbox).toBeDefined();
      expect(editCheckbox.checked).toBe(true);

      // Save changes -> triggers 409 SERIES_FOREIGN_ITEM
      fireEvent.click(screen.getByTestId('save-edit-playlist-btn'));

      await waitFor(() => {
        expect(patchBody).toMatchObject({
          title: 'Phim Bộ Thử Nghiệm',
          is_series: true,
        });
        expect(screen.getByText('Bộ phim chỉ chứa video của chính kênh bạn.')).toBeDefined();
      });
    });
  });
});
