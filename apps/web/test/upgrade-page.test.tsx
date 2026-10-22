import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UpgradeCreatorView } from '../src/components/auth/upgrade-creator-view';
import { api } from '../src/lib/api-client';
import { computePermissions } from '../src/lib/auth/permissions';
import type { CreatorRequest } from '@winkey/api-client';

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
  usePathname: () => '/nang-cap',
}));

const mockRefresh = vi.fn().mockResolvedValue(undefined);

let mockAuthState = {
  user: { id: 'user-1', email: 'viewer@winkey.vn', roles: ['viewer'] },
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
      refresh: mockRefresh,
    };
  },
}));

vi.mock('../src/lib/api-client', () => ({
  api: {
    auth: {
      GET: vi.fn(),
      POST: vi.fn(),
    },
  },
}));

describe('Task ROLE1 (ADR-046): Upgrade Creator Page (/nang-cap) States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefresh.mockClear();
    mockAuthState = {
      user: { id: 'user-1', email: 'viewer@winkey.vn', roles: ['viewer'] },
      isAuthenticated: true,
      isLoading: false,
    };
  });

  it('1. State NONE (404 no request): renders form, character counter, submits valid request', async () => {
    (api.auth.GET as any).mockResolvedValueOnce({
      response: { ok: false, status: 404 },
    });

    render(<UpgradeCreatorView />);

    await waitFor(() => {
      expect(screen.getByTestId('upgrade-creator-form-view')).toBeDefined();
    });

    const submitBtn = screen.getByTestId('creator-request-submit-btn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    const textarea = screen.getByTestId('creator-request-textarea') as HTMLTextAreaElement;
    const counter = screen.getByTestId('creator-request-counter');
    expect(counter.textContent).toContain('0 / 1000');

    // Type less than 10 characters
    fireEvent.change(textarea, { target: { value: 'ngắn' } });
    expect(submitBtn.disabled).toBe(true);
    expect(counter.textContent).toContain('4 / 1000');

    // Type valid message >= 10 chars
    fireEvent.change(textarea, {
      target: { value: 'Tôi là lập trình viên muốn chia sẻ video về React và Go.' },
    });
    expect(submitBtn.disabled).toBe(false);

    // Submit request
    const createdRequest: CreatorRequest = {
      id: 'req-new-1',
      status: 'PENDING',
      message: 'Tôi là lập trình viên muốn chia sẻ video về React và Go.',
      decision_note: null,
      created_at: new Date().toISOString(),
      decided_at: null,
    };

    (api.auth.POST as any).mockResolvedValueOnce({
      response: { ok: true, status: 201 },
      data: createdRequest,
    });

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.auth.POST).toHaveBeenCalledWith(
        '/v1/auth/me/creator-request',
        expect.objectContaining({
          body: { message: 'Tôi là lập trình viên muốn chia sẻ video về React và Go.' },
        }),
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
        }),
      );
    });
  });

  it('2. State PENDING: displays pending state, submitted date, and polls every 30s when visible', async () => {
    const pendingReq: CreatorRequest = {
      id: 'req-pending-1',
      status: 'PENDING',
      message: 'Kênh chuyên review phim chiếu rạp.',
      decision_note: null,
      created_at: '2026-10-22T10:00:00Z',
      decided_at: null,
    };

    (api.auth.GET as any).mockResolvedValue({
      response: { ok: true, status: 200 },
      data: pendingReq,
    });

    vi.useFakeTimers();

    render(<UpgradeCreatorView />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('upgrade-creator-pending')).toBeDefined();
    expect(screen.getByText('Yêu cầu đang chờ duyệt')).toBeDefined();
    expect(screen.getByText('Kênh chuyên review phim chiếu rạp.')).toBeDefined();

    // Verify polling when document is visible
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    expect(api.auth.GET).toHaveBeenCalledTimes(1);

    // Fast-forward 30 seconds
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(api.auth.GET).toHaveBeenCalledTimes(2);

    // If tab is hidden, should not poll
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    // Still 2 calls because tab was hidden
    expect(api.auth.GET).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('3. State APPROVED: calls refresh() once, displays success card, offers links to /upload and /studio', async () => {
    const approvedReq: CreatorRequest = {
      id: 'req-app-1',
      status: 'APPROVED',
      message: 'Kênh lập trình.',
      decision_note: 'Đã duyệt!',
      created_at: '2026-10-22T08:00:00Z',
      decided_at: '2026-10-22T09:00:00Z',
    };

    (api.auth.GET as any).mockResolvedValueOnce({
      response: { ok: true, status: 200 },
      data: approvedReq,
    });

    render(<UpgradeCreatorView />);

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Yêu cầu sáng tạo của bạn đã được duyệt thành công!',
          type: 'success',
        }),
      );
    });

    // Now user has creator role
    mockAuthState.user.roles = ['viewer', 'creator'];
    render(<UpgradeCreatorView />);

    await waitFor(() => {
      expect(screen.getByTestId('upgrade-creator-approved')).toBeDefined();
      expect(screen.getByTestId('upgrade-to-upload-btn')).toBeDefined();
      expect(screen.getByTestId('upgrade-to-studio-btn')).toBeDefined();
    });
  });

  it('4. State REJECTED: shows admin decision note and cooldown message', async () => {
    const rejectedReq: CreatorRequest = {
      id: 'req-rej-1',
      status: 'REJECTED',
      message: 'Kênh âm nhạc.',
      decision_note: 'Vui lòng bổ sung kế hoạch phát hành chi tiết hơn.',
      created_at: '2026-10-22T08:00:00Z',
      decided_at: '2026-10-22T09:00:00Z',
    };

    (api.auth.GET as any).mockResolvedValueOnce({
      response: { ok: true, status: 200 },
      data: rejectedReq,
    });

    render(<UpgradeCreatorView />);

    await waitFor(() => {
      expect(screen.getByTestId('upgrade-creator-rejected')).toBeDefined();
      expect(screen.getByText('Yêu cầu chưa được phê duyệt')).toBeDefined();
      expect(screen.getByText('Vui lòng bổ sung kế hoạch phát hành chi tiết hơn.')).toBeDefined();
      expect(screen.getByText(/24 giờ/)).toBeDefined();
    });
  });

  it('5. Error mapping in Vietnamese: ALREADY_CREATOR, REQUEST_PENDING, REQUEST_COOLDOWN, 429', async () => {
    (api.auth.GET as any).mockResolvedValue({
      response: { ok: false, status: 404 },
    });

    render(<UpgradeCreatorView />);

    await waitFor(() => {
      expect(screen.getByTestId('upgrade-creator-form-view')).toBeDefined();
    });

    const submitBtn = screen.getByTestId('creator-request-submit-btn');
    const textarea = screen.getByTestId('creator-request-textarea');
    fireEvent.change(textarea, { target: { value: 'Nội dung đăng ký hợp lệ 12345' } });

    // Test 409 ALREADY_CREATOR
    (api.auth.POST as any).mockResolvedValueOnce({
      response: { ok: false, status: 409 },
      error: { code: 'ALREADY_CREATOR' },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Tài khoản của bạn đã có quyền sáng tạo.')).toBeDefined();
    });

    // Test 409 REQUEST_PENDING
    (api.auth.POST as any).mockResolvedValueOnce({
      response: { ok: false, status: 409 },
      error: { code: 'REQUEST_PENDING' },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText('Bạn đã có một yêu cầu đang chờ quản trị viên phê duyệt.'),
      ).toBeDefined();
    });

    // Test 409 REQUEST_COOLDOWN
    (api.auth.POST as any).mockResolvedValueOnce({
      response: { ok: false, status: 409 },
      error: {
        code: 'REQUEST_COOLDOWN',
        detail: 'Bạn có thể gửi lại sau 2026-10-23T10:00:00Z',
      },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Bạn có thể gửi lại sau 2026-10-23T10:00:00Z')).toBeDefined();
    });

    // Test 429 Rate limit
    (api.auth.POST as any).mockResolvedValueOnce({
      response: { ok: false, status: 429 },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Bạn đã gửi quá nhiều yêu cầu trong hôm nay. Vui lòng thử lại vào ngày mai.',
        ),
      ).toBeDefined();
    });
  });
});
