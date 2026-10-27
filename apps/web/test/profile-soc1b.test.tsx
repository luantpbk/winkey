import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';

const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/c/testuser',
  Link: ({ children, href, className, onClick }: any) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/c/testuser',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    can: {
      uploadVideo: true,
      comment: true,
      manageChannel: true,
      moderateComments: false,
      accessAdmin: false,
    },
    isCreator: true,
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

import {
  validateImageFile,
  uploadImage,
  MAX_IMAGE_SIZE_BYTES,
} from '../src/lib/media/upload-image';
import { SubscribeButton } from '../src/components/social/subscribe-button';
import { BlockConfirmDialog } from '../src/components/social/block-confirm-dialog';
import { RelationsModal } from '../src/components/social/relations-modal';
import { FollowRequestsSection } from '../src/components/settings/follow-requests-section';
import { BlockedMutedSection } from '../src/components/settings/blocked-muted-section';
import { ProfileSettings } from '../src/components/settings/profile-settings';
import { NotificationItem } from '../src/components/notifications/notification-item';
import { CommentSection } from '../src/components/social/comment-section';
import { api } from '../src/lib/api-client';
import type { User, Notification } from '@winkey/api-client';
import viMessages from '../messages/vi.json';

const mockUser: User = {
  id: 'usr-11111111-1111-1111-1111-111111111111',
  email: 'test@winkey.vn',
  email_verified: true,
  handle: 'testuser',
  display_name: 'Test User',
  avatar_url: 'https://images.winkey.vn/avatar.webp',
  roles: ['viewer'],
  has_password: true,
  mfa_enabled: false,
  bio: 'Tiểu sử thử nghiệm',
  links: [{ label: 'Website', url: 'https://winkey.vn' }],
  banner_url: 'https://images.winkey.vn/banner.webp',
  is_private: false,
  created_at: '2026-01-01T00:00:00Z',
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('SOC-1b Profile UI, Avatar/Banner Upload, Privacy, Follow Requests, Block/Mute', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Image Upload Helper Validation
  describe('1. Image Upload Helper (lib/media/upload-image.ts)', () => {
    it('rejects files exceeding 20 MiB limit', () => {
      const largeFile = new File(['x'], 'huge.png', { type: 'image/png' });
      Object.defineProperty(largeFile, 'size', { value: MAX_IMAGE_SIZE_BYTES + 1 });

      const result = validateImageFile(largeFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tối đa 20 MiB');
    });

    it('rejects unsupported image MIME types', () => {
      const gifFile = new File(['gif-data'], 'anim.gif', { type: 'image/gif' });
      const result = validateImageFile(gifFile);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Định dạng tệp không được hỗ trợ');
    });

    it('accepts valid image MIME types (JPEG, PNG, WebP, AVIF) under 20 MiB', () => {
      ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].forEach((type) => {
        const file = new File(['data'], `img.${type.split('/')[1]}`, { type });
        Object.defineProperty(file, 'size', { value: 1024 * 1024 });
        expect(validateImageFile(file).valid).toBe(true);
      });
    });

    it('handles successful upload flow with READY polling', async () => {
      const mockBlob = new Blob(['test-image'], { type: 'image/webp' });

      vi.spyOn(api.upload, 'POST').mockImplementation(async (path: any) => {
        if (path === '/v1/images') {
          return {
            data: {
              image_id: 'img-test-123',
              upload_url: 'http://localhost:8080/mock-upload/images/img-test-123',
              upload_headers: { 'Content-Type': 'image/webp' },
              expires_at: '2026-10-28T00:00:00Z',
            },
            response: new Response(null, { status: 201 }),
          } as any;
        }
        if (path === '/v1/images/{image_id}/complete') {
          return { response: new Response(null, { status: 204 }) } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      vi.spyOn(api.upload, 'GET').mockResolvedValueOnce({
        data: {
          id: 'img-test-123',
          purpose: 'AVATAR',
          status: 'READY',
          url: 'https://images.winkey.vn/img-test-123.webp',
          thumb_url: 'https://images.winkey.vn/img-test-123_thumb.webp',
          width: 800,
          height: 800,
          error: null,
          created_at: new Date().toISOString(),
        },
        response: new Response(null, { status: 200 }),
      } as any);

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const res = await uploadImage({
        blob: mockBlob,
        purpose: 'AVATAR',
        pollIntervalMs: 10,
      });

      expect(res.status).toBe('READY');
      expect(res.url).toBe('https://images.winkey.vn/img-test-123.webp');

      global.fetch = originalFetch;
    });

    it('handles FAILED polling status with error message', async () => {
      const mockBlob = new Blob(['corrupt'], { type: 'image/webp' });

      vi.spyOn(api.upload, 'POST').mockImplementation(async (path: any) => {
        if (path === '/v1/images') {
          return {
            data: {
              image_id: 'img-failed',
              upload_url: 'http://localhost:8080/mock-upload/images/img-failed',
              upload_headers: { 'Content-Type': 'image/webp' },
              expires_at: '2026-10-28T00:00:00Z',
            },
            response: new Response(null, { status: 201 }),
          } as any;
        }
        return { response: new Response(null, { status: 204 }) } as any;
      });

      vi.spyOn(api.upload, 'GET').mockResolvedValueOnce({
        data: {
          id: 'img-failed',
          purpose: 'AVATAR',
          status: 'FAILED',
          url: null,
          thumb_url: null,
          width: null,
          height: null,
          error: 'Tệp ảnh bị hỏng.',
          created_at: new Date().toISOString(),
        },
        response: new Response(null, { status: 200 }),
      } as any);

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await expect(
        uploadImage({
          blob: mockBlob,
          purpose: 'AVATAR',
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow('Tệp ảnh bị hỏng.');

      global.fetch = originalFetch;
    });
  });

  // 2. Profile Settings Validation
  describe('2. Edit Profile Settings', () => {
    it('renders bio with 300 character counter and links manager', () => {
      renderWithProviders(<ProfileSettings user={mockUser} />);

      expect(screen.getByLabelText(/Tiểu sử/i)).toBeDefined();
      expect(screen.getByText(/18\/300/i)).toBeDefined();
      expect(screen.getByText(/Tài khoản riêng tư/i)).toBeDefined();
      expect(screen.getByText(/Thêm liên kết/i)).toBeDefined();
    });

    it('updates character counter as user types in bio', () => {
      renderWithProviders(<ProfileSettings user={mockUser} />);

      const bioInput = screen.getByLabelText(/Tiểu sử/i) as HTMLTextAreaElement;
      fireEvent.change(bioInput, { target: { value: 'Xin chao' } });

      expect(screen.getByText(/8\/300/i)).toBeDefined();
    });

    it('allows toggling private account checkbox', () => {
      renderWithProviders(<ProfileSettings user={mockUser} />);

      const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
    });
  });

  // 3. Follow Button 3-State Machine
  describe('3. Follow Button 3-State Machine', () => {
    it('transitions to "Đang theo dõi" when subscribed=true', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: { channel_id: 'chan-1', subscribed: true, subscriber_count: 42 },
        response: { ok: true, status: 200 } as any,
      } as any);

      renderWithProviders(<SubscribeButton channelId="chan-1" mode="follow" />);

      await waitFor(() => {
        expect(screen.getByText('Đang theo dõi')).toBeDefined();
      });
    });

    it('transitions to "Đã yêu cầu" when requested=true on private channel', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: { channel_id: 'chan-priv', subscribed: false, requested: true, subscriber_count: 10 },
        response: { ok: true, status: 200 } as any,
      } as any);

      renderWithProviders(<SubscribeButton channelId="chan-priv" mode="follow" />);

      await waitFor(() => {
        expect(screen.getByText('Đã yêu cầu')).toBeDefined();
      });
    });

    it('hides button when isBlocked is true', () => {
      renderWithProviders(
        <SubscribeButton channelId="chan-blocked" isBlocked={true} mode="follow" />,
      );
      expect(screen.queryByText(/theo dõi/i)).toBeNull();
    });
  });

  // 4. Block Confirmation Dialog
  describe('4. Block Confirmation Dialog', () => {
    it('renders explanation of two-way block effects and calls onConfirmBlock', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      renderWithProviders(
        <BlockConfirmDialog
          isOpen={true}
          targetUser={{ handle: 'spammer', display_name: 'Spam Bot' }}
          onClose={onClose}
          onConfirmBlock={onConfirm}
        />,
      );

      expect(screen.getByText(/Chặn Spam Bot/i)).toBeDefined();
      expect(screen.getByText(/Hai bên sẽ không thể theo dõi/i)).toBeDefined();

      const blockBtn = screen.getByRole('button', { name: /Chặn người này/i });
      fireEvent.click(blockBtn);

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });
  });

  // 5. Relations Modal (Followers / Following)
  describe('5. Followers & Following Modal with Private Guard', () => {
    it('renders private locked message on 403 status', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        error: { code: 'PRIVATE_ACCOUNT_REQUIRED' },
        response: { ok: false, status: 403 } as any,
      } as any);

      renderWithProviders(
        <RelationsModal
          isOpen={true}
          channelId="private-chan"
          type="followers"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Tài khoản này là riêng tư/i)).toBeDefined();
        expect(
          screen.getByText(/Chỉ những người được phê duyệt theo dõi mới có thể xem/i),
        ).toBeDefined();
      });
    });
  });

  // 6. Comments INTERACTION_BLOCKED Handling
  describe('6. Comment Section INTERACTION_BLOCKED Handling', () => {
    it('displays "Bạn không thể bình luận ở đây" on INTERACTION_BLOCKED code', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: { ok: true, status: 200 } as any,
      } as any);

      vi.spyOn(api.social, 'POST').mockResolvedValueOnce({
        error: { code: 'INTERACTION_BLOCKED' },
        response: { ok: false, status: 403 } as any,
      } as any);

      renderWithProviders(<CommentSection videoId="vid-blocked" />);

      const textarea = await screen.findByPlaceholderText(/Viết bình luận/i);
      fireEvent.change(textarea, { target: { value: 'Bình luận thử nghiệm' } });

      const submitBtn = screen.getByRole('button', { name: /Bình luận/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByText(/Bạn không thể bình luận ở đây/i)).toBeDefined();
      });
    });
  });

  // 7. Follow Requests Section
  describe('7. Follow Requests Section', () => {
    it('renders pending requests and calls approve/reject decisions', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: {
          items: [
            {
              requester: {
                id: 'usr-requester-1',
                handle: 'alice',
                display_name: 'Alice',
                avatar_url: null,
              },
              requested_at: '2026-10-27T00:00:00Z',
            },
          ],
          pending_count: 1,
        },
        response: { ok: true, status: 200 } as any,
      } as any);

      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        response: { ok: true, status: 204 } as any,
      } as any);

      renderWithProviders(<FollowRequestsSection />);

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeDefined();
        expect(screen.getByText('@alice')).toBeDefined();
      });

      const approveBtn = screen.getByRole('button', { name: /Chấp nhận/i });
      fireEvent.click(approveBtn);

      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith(
          '/v1/me/follow-requests/{requester_id}/decision',
          expect.objectContaining({
            params: { path: { requester_id: 'usr-requester-1' } },
            body: { decision: 'APPROVE' },
          }),
        );
      });
    });
  });

  // 8. Blocked and Muted Users Section
  describe('8. Blocked & Muted Section', () => {
    it('renders blocked list and calls unblock', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: any) => {
        if (path === '/v1/me/blocks') {
          return {
            data: {
              items: [
                {
                  user: {
                    id: 'u-b1',
                    handle: 'baduser',
                    display_name: 'Bad User',
                    avatar_url: null,
                  },
                  since: '2026-10-20T00:00:00Z',
                },
              ],
            },
            response: { ok: true, status: 200 } as any,
          } as any;
        }
        return { data: { items: [] }, response: { ok: true, status: 200 } } as any;
      });

      const delSpy = vi.spyOn(api.social, 'DELETE').mockResolvedValue({
        response: { ok: true, status: 204 } as any,
      } as any);

      renderWithProviders(<BlockedMutedSection />);

      await waitFor(() => {
        expect(screen.getByText('Bad User')).toBeDefined();
        expect(screen.getByText('@baduser')).toBeDefined();
      });

      const unblockBtn = screen.getByRole('button', { name: /Bỏ chặn/i });
      fireEvent.click(unblockBtn);

      await waitFor(() => {
        expect(delSpy).toHaveBeenCalledWith('/v1/me/blocks/{user_id}', {
          params: { path: { user_id: 'u-b1' } },
        });
      });
    });
  });

  // 9. Notification Bell translations
  describe('9. Notification Bell Translations', () => {
    it('renders FOLLOW_REQUEST and FOLLOW_REQUEST_APPROVED texts', () => {
      const notifRequest: Notification = {
        id: 'n-1',
        kind: 'FOLLOW_REQUEST' as any,
        actor: { id: 'u-1', handle: 'bob', display_name: 'Bob', avatar_url: null },
        video_id: null,
        comment_id: null,
        created_at: new Date().toISOString(),
        read_at: null,
      };

      const notifApproved: Notification = {
        id: 'n-2',
        kind: 'FOLLOW_REQUEST_APPROVED' as any,
        actor: { id: 'u-2', handle: 'carol', display_name: 'Carol', avatar_url: null },
        video_id: null,
        comment_id: null,
        created_at: new Date().toISOString(),
        read_at: null,
      };

      const { unmount } = renderWithProviders(<NotificationItem notification={notifRequest} />);
      expect(screen.getByText(/Bob đã gửi yêu cầu theo dõi bạn/i)).toBeDefined();
      unmount();

      renderWithProviders(<NotificationItem notification={notifApproved} />);
      expect(screen.getByText(/Carol đã chấp nhận yêu cầu theo dõi của bạn/i)).toBeDefined();
    });
  });
});
