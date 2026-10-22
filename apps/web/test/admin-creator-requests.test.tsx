import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreatorRequestsViewer } from '../src/components/admin/creator-requests-viewer';
import { UserManagement } from '../src/components/admin/user-management';
import { api } from '../src/lib/api-client';
import { computePermissions } from '../src/lib/auth/permissions';
import type { AdminCreatorRequest, AdminUser } from '@winkey/api-client';

const mockToast = vi.fn();
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: mockToast, dismissToast: vi.fn() }),
}));

vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin',
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

let mockAuthState = {
  user: { id: 'admin-1', email: 'admin@winkey.vn', roles: ['viewer', 'admin'] },
  isAuthenticated: true,
  isLoading: false,
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => {
    const can = computePermissions(mockAuthState.user, mockAuthState.isAuthenticated);
    return {
      user: mockAuthState.user,
      isAuthenticated: mockAuthState.isAuthenticated,
      isLoading: mockAuthState.isLoading,
      can,
      isAdmin: mockAuthState.user?.roles?.includes('admin') ?? false,
      isModerator: mockAuthState.user?.roles?.includes('moderator') ?? false,
    };
  },
}));

vi.mock('../src/lib/api-client', () => ({
  api: {
    auth: {
      GET: vi.fn(),
      POST: vi.fn(),
      PUT: vi.fn(),
    },
  },
}));

const mockRequests: AdminCreatorRequest[] = [
  {
    id: 'req-1',
    status: 'PENDING',
    message: 'Tôi muốn chia sẻ video về lập trình và thiết kế.',
    decision_note: null,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    decided_at: null,
    user: {
      id: 'user-viewer-1',
      email: 'viewer1@winkey.vn',
      email_verified: true,
      handle: 'dev_viewer',
      display_name: 'Dev Viewer',
      avatar_url: null,
      roles: ['viewer'],
      status: 'ACTIVE',
      created_at: '2026-02-01T00:00:00Z',
      suspended_until: null,
      suspension_reason: null,
    },
    decided_by: null,
  },
  {
    id: 'req-2',
    status: 'PENDING',
    message: 'Kênh chuyên review phim điện ảnh.',
    decision_note: null,
    created_at: new Date(Date.now() - 7200000).toISOString(),
    decided_at: null,
    user: {
      id: 'user-viewer-2',
      email: 'viewer2@winkey.vn',
      email_verified: true,
      handle: 'cine_fan',
      display_name: 'Cine Fan',
      avatar_url: null,
      roles: ['viewer'],
      status: 'ACTIVE',
      created_at: '2026-02-05T00:00:00Z',
      suspended_until: null,
      suspension_reason: null,
    },
    decided_by: null,
  },
];

describe('Task ROLE1 (ADR-046): Admin Creator Requests & Quick Role Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToast.mockClear();
    mockAuthState = {
      user: { id: 'admin-1', email: 'admin@winkey.vn', roles: ['viewer', 'admin'] },
      isAuthenticated: true,
      isLoading: false,
    };
  });

  describe('CreatorRequestsViewer', () => {
    it('1. Renders requests list with user info, message, avatar, age, and handles Approve', async () => {
      (api.auth.GET as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          items: [...mockRequests],
          next_cursor: null,
          pending_count: 2,
        },
      });

      const onPendingCountChange = vi.fn();
      render(<CreatorRequestsViewer onPendingCountChange={onPendingCountChange} />);

      await waitFor(() => {
        expect(screen.getByTestId('creator-request-row-req-1')).toBeDefined();
        expect(screen.getByTestId('creator-request-row-req-2')).toBeDefined();
        expect(screen.getByText('Dev Viewer')).toBeDefined();
        expect(screen.getByText('@dev_viewer')).toBeDefined();
        expect(screen.getByText('Tôi muốn chia sẻ video về lập trình và thiết kế.')).toBeDefined();
      });

      // Click Approve on req-1
      const approveBtn = screen.getByTestId('admin-approve-btn-req-1');
      fireEvent.click(approveBtn);

      // Approve dialog opens
      expect(screen.getByText('Phê duyệt yêu cầu sáng tạo')).toBeDefined();
      const confirmApproveBtn = screen.getByTestId('confirm-approve-btn');

      (api.auth.POST as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          ...mockRequests[0],
          status: 'APPROVED',
        },
      });

      fireEvent.click(confirmApproveBtn);

      await waitFor(() => {
        expect(api.auth.POST).toHaveBeenCalledWith(
          '/v1/admin/creator-requests/{request_id}/decision',
          expect.objectContaining({
            params: { path: { request_id: 'req-1' } },
            body: { decision: 'APPROVE' },
          }),
        );
        // Optimistically removed req-1 from pending view
        expect(screen.queryByTestId('creator-request-row-req-1')).toBeNull();
        expect(screen.getByTestId('creator-request-row-req-2')).toBeDefined();
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'success',
          }),
        );
      });
    });

    it('2. Reject action: requires note input in dialog, submits REJECT with note', async () => {
      (api.auth.GET as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          items: [mockRequests[0]],
          next_cursor: null,
          pending_count: 1,
        },
      });

      render(<CreatorRequestsViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('creator-request-row-req-1')).toBeDefined();
      });

      // Click Reject
      const rejectBtn = screen.getByTestId('admin-reject-btn-req-1');
      fireEvent.click(rejectBtn);

      // Reject dialog opens
      expect(screen.getByText('Từ chối yêu cầu sáng tạo')).toBeDefined();
      const noteInput = screen.getByTestId('admin-reject-note-input') as HTMLTextAreaElement;
      const confirmRejectBtn = screen.getByTestId('confirm-reject-btn') as HTMLButtonElement;

      // When note is empty, confirm is disabled
      expect(confirmRejectBtn.disabled).toBe(true);

      fireEvent.change(noteInput, {
        target: { value: 'Nội dung chưa phù hợp với định hướng hiện tại.' },
      });
      expect(confirmRejectBtn.disabled).toBe(false);

      (api.auth.POST as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          ...mockRequests[0],
          status: 'REJECTED',
          decision_note: 'Nội dung chưa phù hợp với định hướng hiện tại.',
        },
      });

      fireEvent.click(confirmRejectBtn);

      await waitFor(() => {
        expect(api.auth.POST).toHaveBeenCalledWith(
          '/v1/admin/creator-requests/{request_id}/decision',
          expect.objectContaining({
            params: { path: { request_id: 'req-1' } },
            body: {
              decision: 'REJECT',
              note: 'Nội dung chưa phù hợp với định hướng hiện tại.',
            },
          }),
        );
        expect(screen.queryByTestId('creator-request-row-req-1')).toBeNull();
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'info',
          }),
        );
      });
    });

    it('3. Handles 409 REQUEST_ALREADY_DECIDED: refetches and shows warning toast', async () => {
      (api.auth.GET as any).mockResolvedValue({
        response: { ok: true, status: 200 },
        data: {
          items: [mockRequests[0]],
          next_cursor: null,
          pending_count: 1,
        },
      });

      render(<CreatorRequestsViewer />);

      await waitFor(() => {
        expect(screen.getByTestId('creator-request-row-req-1')).toBeDefined();
      });

      // Click Approve
      fireEvent.click(screen.getByTestId('admin-approve-btn-req-1'));

      (api.auth.POST as any).mockResolvedValueOnce({
        response: { ok: false, status: 409 },
        error: { code: 'REQUEST_ALREADY_DECIDED' },
      });

      fireEvent.click(screen.getByTestId('confirm-approve-btn'));

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Yêu cầu này đã được xử lý trước đó.',
            type: 'warning',
          }),
        );
        // Refetched
        expect(api.auth.GET).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('UserManagement Quick Role Actions', () => {
    const mockUsersList: AdminUser[] = [
      {
        id: 'u-1',
        email: 'user1@winkey.vn',
        email_verified: true,
        handle: 'user1',
        display_name: 'User One',
        avatar_url: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        created_at: '2026-01-01T00:00:00Z',
        suspended_until: null,
        suspension_reason: null,
      },
      {
        id: 'u-2',
        email: 'user2@winkey.vn',
        email_verified: true,
        handle: 'user2',
        display_name: 'User Two',
        avatar_url: null,
        roles: ['viewer', 'creator'],
        status: 'ACTIVE',
        created_at: '2026-01-02T00:00:00Z',
        suspended_until: null,
        suspension_reason: null,
      },
    ];

    it('Quick grant creator: user without creator has "Cấp Creator" button, updates role to include creator', async () => {
      (api.auth.GET as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          items: [...mockUsersList],
          next_cursor: null,
        },
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByTestId('quick-grant-creator-btn-u-1')).toBeDefined();
        expect(screen.getByTestId('quick-revoke-creator-btn-u-2')).toBeDefined();
      });

      (api.auth.PUT as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
      });

      fireEvent.click(screen.getByTestId('quick-grant-creator-btn-u-1'));

      await waitFor(() => {
        expect(api.auth.PUT).toHaveBeenCalledWith(
          '/v1/admin/users/{user_id}/roles',
          expect.objectContaining({
            params: { path: { user_id: 'u-1' } },
            body: { roles: ['viewer', 'creator'] },
          }),
        );
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Đã cấp quyền Creator cho @user1.',
            type: 'success',
          }),
        );
      });
    });

    it('Quick revoke creator: warns that revoking creator signs user out, then revokes creator on confirm', async () => {
      (api.auth.GET as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
        data: {
          items: [...mockUsersList],
          next_cursor: null,
        },
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByTestId('quick-revoke-creator-btn-u-2')).toBeDefined();
      });

      // Click "Thu hồi Creator"
      fireEvent.click(screen.getByTestId('quick-revoke-creator-btn-u-2'));

      // Warning modal opens
      expect(screen.getByText('Cảnh báo thu hồi quyền Creator')).toBeDefined();
      expect(screen.getByText(/hủy toàn bộ phiên đăng nhập/)).toBeDefined();

      (api.auth.PUT as any).mockResolvedValueOnce({
        response: { ok: true, status: 200 },
      });

      // Confirm revoke
      fireEvent.click(screen.getByTestId('confirm-quick-revoke-btn'));

      await waitFor(() => {
        expect(api.auth.PUT).toHaveBeenCalledWith(
          '/v1/admin/users/{user_id}/roles',
          expect.objectContaining({
            params: { path: { user_id: 'u-2' } },
            body: { roles: ['viewer'] },
          }),
        );
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'info',
          }),
        );
      });
    });
  });
});
