import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminVideosViewer } from '../src/components/admin/admin-videos-viewer';
import AdminPage from '../src/app/[locale]/admin/page';
import { WatchClientSection } from '../src/app/[locale]/watch/[id]/watch-client';
import type { AdminVideo, Video } from '@winkey/api-client';

// --- Mocks ---
const mockPush = vi.fn();
const mockShowToast = vi.fn();

vi.mock('../src/i18n/routing', () => ({
  Link: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/admin',
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      title: 'Bảng điều khiển quản trị',
      description: 'Quản lý kiểm duyệt',
      'nav.queue': 'Hàng đợi báo cáo',
      'nav.videos': 'Video',
      'nav.users': 'Người dùng',
      'nav.audit': 'Nhật ký kiểm toán',
    };
    return translations[key] || key;
  },
}));

vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

// Mock Auth
let mockAuthState = {
  user: null as any,
  isAuthenticated: false,
  isLoading: false,
  can: {
    upload: false,
    studio: false,
    requestCreator: true,
    moderate: false,
    adminOnly: false,
  },
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => mockAuthState,
}));

// Mock API Client
const mockApiGet = vi.fn();
const mockApiPut = vi.fn();
const mockApiDelete = vi.fn();

vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      GET: (...args: any[]) => mockApiGet(...args),
      PUT: (...args: any[]) => mockApiPut(...args),
      DELETE: (...args: any[]) => mockApiDelete(...args),
    },
    auth: {
      GET: vi.fn().mockResolvedValue({ data: { pending_count: 0 }, response: { ok: true } }),
    },
  },
}));

// Mock child components for AdminPage tabs
vi.mock('../src/components/admin/moderation-queue', () => ({
  ModerationQueue: () => <div data-testid="mock-moderation-queue">Queue View</div>,
}));
vi.mock('../src/components/admin/user-management', () => ({
  UserManagement: () => <div data-testid="mock-user-management">User Management View</div>,
}));
vi.mock('../src/components/admin/audit-log-viewer', () => ({
  AuditLogViewer: () => <div data-testid="mock-audit-log">Audit Log View</div>,
}));
vi.mock('../src/components/admin/creator-requests-viewer', () => ({
  CreatorRequestsViewer: () => <div data-testid="mock-creator-requests">Creator Requests View</div>,
}));

// Test Fixtures
const sampleAdminVideos: AdminVideo[] = [
  {
    id: 'vid-001',
    title: 'Hướng dẫn lập trình TypeScript căn bản',
    visibility: 'PUBLIC',
    status: 'READY',
    progress: 100,
    error: null,
    duration_ms: 180000,
    created_at: '2026-10-20T10:00:00Z',
    thumbnail_url: 'https://img.winkey.vn/thumb1.jpg',
    owner: {
      id: 'user-001',
      handle: 'coder_pro',
      display_name: 'Coder Pro',
      avatar_url: null,
    },
    owner_active: true,
    moderation: {
      state: 'VISIBLE',
      reason: null,
      moderated_at: null,
    },
  },
  {
    id: 'vid-002',
    title: 'Video vi phạm bản quyền ca nhạc',
    visibility: 'PRIVATE',
    status: 'READY',
    progress: 100,
    error: null,
    duration_ms: 240000,
    created_at: '2026-10-19T10:00:00Z',
    thumbnail_url: null,
    owner: {
      id: 'user-002',
      handle: 'deleted_user',
      display_name: 'Người dùng cũ',
      avatar_url: null,
    },
    owner_active: false,
    moderation: {
      state: 'HIDDEN',
      reason: 'Vi phạm bản quyền âm nhạc theo báo cáo số 1234',
      moderated_at: '2026-10-21T08:00:00Z',
    },
  },
];

const sampleWatchVideo: Video = {
  id: 'vid-watch-100',
  title: 'Video thử nghiệm trên trang xem',
  description: 'Mô tả video trên trang watch.',
  visibility: 'PUBLIC',
  status: 'READY',
  duration_ms: 120000,
  width: 1920,
  height: 1080,
  view_count: 500,
  like_count: 50,
  published_at: '2026-10-22T00:00:00Z',
  created_at: '2026-10-22T00:00:00Z',
  owner: {
    id: 'user-owner-watch',
    handle: 'watch_owner',
    display_name: 'Watch Owner',
    avatar_url: null,
  },
  playback: null,
  moderation: {
    state: 'VISIBLE',
    reason: null,
    moderated_at: null,
  },
};

describe('ADMV1 (ADR-047): Admin Videos & Watch-Page Moderation Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({
      data: {
        items: [...sampleAdminVideos],
        next_cursor: null,
      },
      response: { ok: true, status: 200 },
    });
    mockApiPut.mockResolvedValue({
      data: { id: 'vid-001', moderation: { state: 'HIDDEN', reason: 'Test reason' } },
      response: { ok: true, status: 200 },
    });
    mockApiDelete.mockResolvedValue({
      response: { ok: true, status: 204 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Admin Page: Tab Visibility by Role', () => {
    it('Moderator user: sees "Video" tab along with Queue and Users', () => {
      mockAuthState = {
        user: { id: 'mod-1', roles: ['viewer', 'moderator'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: false,
          studio: false,
          requestCreator: false,
          moderate: true,
          adminOnly: false,
        },
      };

      render(<AdminPage />);

      expect(screen.getByTestId('admin-tab-videos')).toBeDefined();
      expect(screen.getByText('Video')).toBeDefined();
      expect(screen.queryByTestId('admin-tab-creator-requests')).toBeNull();
    });

    it('Administrator user: sees "Video" tab along with all tabs', () => {
      mockAuthState = {
        user: { id: 'admin-1', roles: ['viewer', 'admin'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: true,
          studio: true,
          requestCreator: false,
          moderate: true,
          adminOnly: true,
        },
      };

      render(<AdminPage />);

      expect(screen.getByTestId('admin-tab-videos')).toBeDefined();
      expect(screen.getByTestId('admin-tab-creator-requests')).toBeDefined();
    });
  });

  describe('2. AdminVideosViewer: Search & Filter Query Building', () => {
    it('initial render queries /v1/studio/admin/videos with limit 20 and no empty q', async () => {
      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(mockApiGet).toHaveBeenCalledWith(
          '/v1/studio/admin/videos',
          expect.objectContaining({
            params: {
              query: { limit: '20' },
            },
          }),
        );
      });

      expect(screen.getByText('Hướng dẫn lập trình TypeScript căn bản')).toBeDefined();
      expect(screen.getByText('Video vi phạm bản quyền ca nhạc')).toBeDefined();
    });

    it('does not send q when search text has only 1 character', async () => {
      vi.useFakeTimers();
      render(<AdminVideosViewer />);

      const searchInput = screen.getByTestId('admin-videos-search-input');
      fireEvent.change(searchInput, { target: { value: 'a' } });

      vi.advanceTimersByTime(400);

      expect(mockApiGet).toHaveBeenCalledWith(
        '/v1/studio/admin/videos',
        expect.objectContaining({
          params: { query: { limit: '20' } },
        }),
      );
      vi.useRealTimers();
    });

    it('debounces and sends q when search text has >= 2 characters', async () => {
      render(<AdminVideosViewer />);

      const searchInput = screen.getByTestId('admin-videos-search-input');
      fireEvent.change(searchInput, { target: { value: 'TypeScript' } });

      await waitFor(
        () => {
          expect(mockApiGet).toHaveBeenCalledWith(
            '/v1/studio/admin/videos',
            expect.objectContaining({
              params: {
                query: expect.objectContaining({
                  q: 'TypeScript',
                }),
              },
            }),
          );
        },
        { timeout: 1000 },
      );
    });

    it('sends status, visibility, and moderation_state filters when selected', async () => {
      render(<AdminVideosViewer />);

      fireEvent.change(screen.getByTestId('admin-videos-status-filter'), {
        target: { value: 'READY' },
      });

      await waitFor(() => {
        expect(mockApiGet).toHaveBeenCalledWith(
          '/v1/studio/admin/videos',
          expect.objectContaining({
            params: { query: expect.objectContaining({ status: 'READY' }) },
          }),
        );
      });

      fireEvent.change(screen.getByTestId('admin-videos-visibility-filter'), {
        target: { value: 'PUBLIC' },
      });

      await waitFor(() => {
        expect(mockApiGet).toHaveBeenCalledWith(
          '/v1/studio/admin/videos',
          expect.objectContaining({
            params: {
              query: expect.objectContaining({
                status: 'READY',
                visibility: 'PUBLIC',
              }),
            },
          }),
        );
      });

      fireEvent.change(screen.getByTestId('admin-videos-moderation-filter'), {
        target: { value: 'HIDDEN' },
      });

      await waitFor(() => {
        expect(mockApiGet).toHaveBeenCalledWith(
          '/v1/studio/admin/videos',
          expect.objectContaining({
            params: {
              query: expect.objectContaining({
                status: 'READY',
                visibility: 'PUBLIC',
                moderation_state: 'HIDDEN',
              }),
            },
          }),
        );
      });
    });
  });

  describe('3. Cursor Pagination', () => {
    it('shows "Tải thêm video" button when next_cursor is present and appends items on click', async () => {
      mockApiGet.mockResolvedValueOnce({
        data: {
          items: [sampleAdminVideos[0]],
          next_cursor: 'cursor-token-page-1',
        },
        response: { ok: true, status: 200 },
      });

      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-videos-load-more-btn')).toBeDefined();
      });

      mockApiGet.mockResolvedValueOnce({
        data: {
          items: [sampleAdminVideos[1]],
          next_cursor: null,
        },
        response: { ok: true, status: 200 },
      });

      fireEvent.click(screen.getByTestId('admin-videos-load-more-btn'));

      await waitFor(() => {
        expect(mockApiGet).toHaveBeenCalledWith(
          '/v1/studio/admin/videos',
          expect.objectContaining({
            params: {
              query: expect.objectContaining({
                cursor: 'cursor-token-page-1',
              }),
            },
          }),
        );
      });

      // After appending second item with next_cursor = null, button disappears
      await waitFor(() => {
        expect(screen.queryByTestId('admin-videos-load-more-btn')).toBeNull();
      });
      expect(screen.getByText('Video vi phạm bản quyền ca nhạc')).toBeDefined();
    });
  });

  describe('4. Row Rendering & Inactive Owner Badge', () => {
    it('displays "Tài khoản đã khoá/xoá" for video with owner_active === false', async () => {
      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-owner-inactive')).toBeDefined();
      });
      expect(screen.getByText('Tài khoản đã khoá/xoá')).toBeDefined();
      expect(screen.getByText('@coder_pro')).toBeDefined();
    });
  });

  describe('5. Hide Video: Dialog, Validation & Optimistic Update', () => {
    it('requires a reason (disabled until reason input) and calls PUT /v1/videos/{id}/moderation', async () => {
      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-hide-btn-vid-001')).toBeDefined();
      });

      // Open dialog
      fireEvent.click(screen.getByTestId('admin-video-hide-btn-vid-001'));
      expect(screen.getByTestId('hide-video-dialog')).toBeDefined();

      const submitBtn = screen.getByTestId('hide-video-submit-btn') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);

      const reasonInput = screen.getByTestId('hide-video-reason-input');
      fireEvent.change(reasonInput, { target: { value: 'Spam nội dung quảng cáo' } });
      expect(submitBtn.disabled).toBe(false);

      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockApiPut).toHaveBeenCalledWith('/v1/videos/{video_id}/moderation', {
          params: { path: { video_id: 'vid-001' } },
          body: { state: 'HIDDEN', reason: 'Spam nội dung quảng cáo' },
        });
      });

      // Optimistic row update to "Hiện lại" button
      await waitFor(() => {
        expect(screen.getByTestId('admin-video-restore-btn-vid-001')).toBeDefined();
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Đã ẩn video thành công' }),
      );
    });

    it('rolls back optimistic hide on API failure and shows error toast', async () => {
      mockApiPut.mockResolvedValueOnce({
        error: { detail: 'Quyền hạn không hợp lệ' },
        response: { ok: false, status: 403 },
      });

      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-hide-btn-vid-001')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('admin-video-hide-btn-vid-001'));
      fireEvent.change(screen.getByTestId('hide-video-reason-input'), {
        target: { value: 'Lý do kiểm thử thất bại' },
      });
      fireEvent.click(screen.getByTestId('hide-video-submit-btn'));

      await waitFor(() => {
        // Rollback back to "Ẩn video" button
        expect(screen.getByTestId('admin-video-hide-btn-vid-001')).toBeDefined();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Không thể ẩn video',
          description: 'Quyền hạn không hợp lệ',
        }),
      );
    });
  });

  describe('6. Restore Video Action', () => {
    it('restores a hidden video to VISIBLE via PUT', async () => {
      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-restore-btn-vid-002')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('admin-video-restore-btn-vid-002'));

      await waitFor(() => {
        expect(mockApiPut).toHaveBeenCalledWith('/v1/videos/{video_id}/moderation', {
          params: { path: { video_id: 'vid-002' } },
          body: { state: 'VISIBLE' },
        });
      });

      // Optimistically changes to "Ẩn video" button
      await waitFor(() => {
        expect(screen.getByTestId('admin-video-hide-btn-vid-002')).toBeDefined();
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Đã khôi phục hiển thị video' }),
      );
    });
  });

  describe('7. Delete Video: Confirmation typing "XOÁ" & Optimistic Removal', () => {
    it('requires typing exact "XOÁ" to enable delete button and removes row on success', async () => {
      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-delete-btn-vid-001')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('admin-video-delete-btn-vid-001'));
      expect(screen.getByTestId('delete-video-dialog')).toBeDefined();

      const confirmBtn = screen.getByTestId('confirm-delete-submit-btn') as HTMLButtonElement;
      const input = screen.getByTestId('confirm-delete-input');

      // Typing wrong text does not enable
      fireEvent.change(input, { target: { value: 'XOA' } });
      expect(confirmBtn.disabled).toBe(true);

      // Typing correct text "XOÁ" enables
      fireEvent.change(input, { target: { value: 'XOÁ' } });
      expect(confirmBtn.disabled).toBe(false);

      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(mockApiDelete).toHaveBeenCalledWith('/v1/videos/{video_id}', {
          params: { path: { video_id: 'vid-001' } },
        });
      });

      // Row is removed from list
      await waitFor(() => {
        expect(screen.queryByTestId('admin-video-row-vid-001')).toBeNull();
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Đã xoá video vĩnh viễn' }),
      );
    });

    it('rolls back deleted video row when DELETE API fails', async () => {
      mockApiDelete.mockResolvedValueOnce({
        error: { detail: 'Lỗi máy chủ khi xoá video' },
        response: { ok: false, status: 500 },
      });

      render(<AdminVideosViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-delete-btn-vid-001')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('admin-video-delete-btn-vid-001'));
      fireEvent.change(screen.getByTestId('confirm-delete-input'), { target: { value: 'XOÁ' } });
      fireEvent.click(screen.getByTestId('confirm-delete-submit-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('admin-video-row-vid-001')).toBeDefined();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Không thể xoá video',
          description: 'Lỗi máy chủ khi xoá video',
        }),
      );
    });
  });

  describe('8. Watch Page: Staff "⋯ Quản trị" Menu & Hidden Video Banner', () => {
    it('hides "⋯ Quản trị" menu for normal viewer or creator', () => {
      mockAuthState = {
        user: { id: 'viewer-user', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: true,
          studio: true,
          requestCreator: false,
          moderate: false,
          adminOnly: false,
        },
      };

      render(<WatchClientSection video={sampleWatchVideo} />);

      expect(screen.queryByTestId('staff-moderation-menu-btn')).toBeNull();
    });

    it('renders "⋯ Quản trị" menu for moderator and admin', () => {
      mockAuthState = {
        user: { id: 'staff-user', roles: ['viewer', 'moderator'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: false,
          studio: false,
          requestCreator: false,
          moderate: true,
          adminOnly: false,
        },
      };

      render(<WatchClientSection video={sampleWatchVideo} />);

      expect(screen.getByTestId('staff-moderation-menu-btn')).toBeDefined();
    });

    it('renders "Video đang bị ẩn" banner for staff and owner when video is HIDDEN', () => {
      const hiddenVideo: Video = {
        ...sampleWatchVideo,
        moderation: {
          state: 'HIDDEN',
          reason: 'Bản quyền nhạc số 987',
          moderated_at: '2026-10-22T02:00:00Z',
        },
      };

      // Case A: Staff viewer sees banner
      mockAuthState = {
        user: { id: 'staff-user', roles: ['viewer', 'moderator'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: false,
          studio: false,
          requestCreator: false,
          moderate: true,
          adminOnly: false,
        },
      };

      const { rerender } = render(<WatchClientSection video={hiddenVideo} />);
      expect(screen.getByTestId('hidden-video-banner')).toBeDefined();
      expect(screen.getByText(/Bản quyền nhạc số 987/)).toBeDefined();

      // Case B: Non-staff owner sees banner
      mockAuthState = {
        user: { id: 'user-owner-watch', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: true,
          studio: true,
          requestCreator: false,
          moderate: false,
          adminOnly: false,
        },
      };

      rerender(<WatchClientSection video={hiddenVideo} />);
      expect(screen.getByTestId('hidden-video-banner')).toBeDefined();

      // Case C: Non-staff other viewer does NOT see banner
      mockAuthState = {
        user: { id: 'other-user', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: false,
          studio: false,
          requestCreator: true,
          moderate: false,
          adminOnly: false,
        },
      };

      rerender(<WatchClientSection video={hiddenVideo} />);
      expect(screen.queryByTestId('hidden-video-banner')).toBeNull();
    });

    it('staff clicking "Xoá" from watch menu redirects to "/" upon confirmation', async () => {
      mockAuthState = {
        user: { id: 'admin-user', roles: ['viewer', 'admin'] },
        isAuthenticated: true,
        isLoading: false,
        can: {
          upload: true,
          studio: true,
          requestCreator: false,
          moderate: true,
          adminOnly: true,
        },
      };

      render(<WatchClientSection video={sampleWatchVideo} />);

      // Open staff dropdown
      fireEvent.click(screen.getByTestId('staff-moderation-menu-btn'));
      expect(screen.getByTestId('staff-delete-video-btn')).toBeDefined();

      // Click delete option
      fireEvent.click(screen.getByTestId('staff-delete-video-btn'));
      expect(screen.getByTestId('delete-video-dialog')).toBeDefined();

      // Type "XOÁ" and submit
      fireEvent.change(screen.getByTestId('confirm-delete-input'), { target: { value: 'XOÁ' } });
      fireEvent.click(screen.getByTestId('confirm-delete-submit-btn'));

      await waitFor(() => {
        expect(mockApiDelete).toHaveBeenCalledWith('/v1/videos/{video_id}', {
          params: { path: { video_id: 'vid-watch-100' } },
        });
      });

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Đã xoá video vĩnh viễn' }),
      );
    });
  });
});
