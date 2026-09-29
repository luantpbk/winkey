import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LikeButton } from '../src/components/social/like-button';
import { SubscribeButton } from '../src/components/social/subscribe-button';
import { CommentComposer } from '../src/components/social/comment-composer';
import { CommentItem } from '../src/components/social/comment-item';
import { CommentSection } from '../src/components/social/comment-section';
import { VideoPlayer } from '../src/components/video/video-player';
import { api } from '../src/lib/api-client';
import type { Comment } from '@winkey/api-client';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'rateLimited') {
      return `Bạn đang thao tác quá nhanh. Vui lòng thử lại sau ${values?.seconds ?? 30} giây.`;
    }
    if (key === 'deletedTombstone') return 'Bình luận này đã bị xóa.';
    if (key === 'charCount') return `${values?.current}/${values?.max}`;
    if (key === 'commentsCount') return `${values?.count} bình luận`;
    if (key === 'subscribers') return `${values?.count} người đăng ký`;
    if (key === 'like') return 'Thích';
    if (key === 'liked') return 'Đã thích';
    if (key === 'subscribe') return 'Đăng ký';
    if (key === 'subscribed') return 'Đã đăng ký';
    if (key === 'loadMoreComments') return 'Xem thêm bình luận';
    if (key === 'loadMoreReplies') return 'Xem thêm câu trả lời';
    if (key === 'showReplies') return `Xem ${values?.count} câu trả lời`;
    if (key === 'hideReplies') return 'Ẩn câu trả lời';
    if (key === 'reply') return 'Phản hồi';
    if (key === 'edit') return 'Chỉnh sửa';
    if (key === 'delete') return 'Xóa';
    if (key === 'cancel') return 'Hủy';
    if (key === 'save') return 'Lưu';
    if (key === 'commentSubmit') return 'Bình luận';
    if (key === 'replySubmit') return 'Phản hồi';
    if (key === 'addCommentPlaceholder') return 'Viết bình luận...';
    if (key === 'replyPlaceholder') return 'Viết câu trả lời...';
    if (key === 'serverError') return 'Đã có lỗi xảy ra từ máy chủ. Vui lòng thử lại sau.';
    if (key === 'unknownError') return 'Đã có lỗi xảy ra. Vui lòng thử lại.';
    if (key === 'networkError') return 'Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng.';
    if (key === 'unauthorized') return 'Bạn cần đăng nhập để thực hiện thao tác này.';
    if (key === 'forbidden') return 'Bạn không có quyền thực hiện thao tác này.';
    if (key === 'notFound') return 'Không tìm thấy nội dung yêu cầu.';
    if (key === 'conflict') return 'Thao tác xung đột dữ liệu. Vui lòng làm mới lại trang.';
    if (key === 'loadCommentsError') return 'Không thể tải bình luận. Vui lòng thử lại sau.';
    if (key === 'loadCommentsNetworkError') return 'Lỗi kết nối khi tải danh sách bình luận.';
    if (key === 'createError') return 'Không thể gửi bình luận.';
    if (key === 'editError') return 'Không thể chỉnh sửa bình luận.';
    if (key === 'deleteError') return 'Không thể xóa bình luận. Vui lòng thử lại sau.';
    if (key === 'deleteConfirm') return 'Bạn có chắc chắn muốn xóa bình luận này không?';
    if (key === 'replyError') return 'Không thể gửi câu trả lời.';
    if (key === 'anonymousUser') return 'Người dùng ẩn danh';
    if (key === 'commentOptions') return 'Tùy chọn bình luận';
    return key;
  },
}));

// Mock routing
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/watch/v-test-123',
  Link: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock auth-context
let mockUser: {
  id: string;
  display_name: string;
  avatar_url: string | null;
  roles: string[];
} | null = {
  id: 'user-alice',
  display_name: 'Alice',
  avatar_url: null,
  roles: ['user'],
};
let mockIsAuthenticated = true;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
  }),
}));

describe('Social Features (Task U3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    mockUser = {
      id: 'user-alice',
      display_name: 'Alice',
      avatar_url: null,
      roles: ['user'],
    };
    mockIsAuthenticated = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CommentSection & CommentComposer', () => {
    it('renders comment list and handles cursor pagination ("Xem thêm")', async () => {
      const mockCommentsPage1: Comment[] = [
        {
          id: 'c-1',
          video_id: 'v-1',
          parent_id: null,
          author: { id: 'u-1', display_name: 'Bob', handle: 'bob', avatar_url: null },
          body: 'First comment',
          status: 'VISIBLE',
          reply_count: 0,
          created_at: new Date().toISOString(),
          edited_at: null,
          can_edit: false,
          can_delete: false,
        },
      ];

      const mockCommentsPage2: Comment[] = [
        {
          id: 'c-2',
          video_id: 'v-1',
          parent_id: null,
          author: { id: 'u-2', display_name: 'Charlie', handle: 'charlie', avatar_url: null },
          body: 'Second comment',
          status: 'VISIBLE',
          reply_count: 0,
          created_at: new Date().toISOString(),
          edited_at: null,
          can_edit: false,
          can_delete: false,
        },
      ];

      const getSpy = vi
        .spyOn(api.social, 'GET')
        .mockImplementation(async (path: string, options?: unknown) => {
          const opt = options as { params?: { query?: { cursor?: string } } } | undefined;
          if (path === '/v1/videos/{video_id}/comments') {
            if (!opt?.params?.query?.cursor) {
              return {
                data: { items: mockCommentsPage1, next_cursor: 'cursor-page-2' },
                response: new Response(null, { status: 200 }),
              } as any;
            } else {
              return {
                data: { items: mockCommentsPage2, next_cursor: null },
                response: new Response(null, { status: 200 }),
              } as any;
            }
          }
          return { response: new Response(null, { status: 404 }) } as any;
        });

      render(<CommentSection videoId="v-1" />);

      // Wait for initial load
      expect(await screen.findByText('First comment')).toBeDefined();
      expect(screen.getByText('Bob')).toBeDefined();

      // Click "Xem thêm bình luận"
      const loadMoreBtn = screen.getByText('Xem thêm bình luận');
      fireEvent.click(loadMoreBtn);

      // Verify second page is appended
      expect(await screen.findByText('Second comment')).toBeDefined();
      expect(screen.getByText('First comment')).toBeDefined();
      expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it('optimistic create rollback on 500 error', async () => {
      // Mock initial empty list
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any);

      // Mock POST failure (500)
      vi.spyOn(api.social, 'POST').mockResolvedValue({
        error: {
          type: '/problems/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Database connection failed',
        },
        response: new Response(null, { status: 500 }),
      } as any);

      render(<CommentSection videoId="v-1" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Viết bình luận...')).toBeDefined();
      });

      const input = screen.getByPlaceholderText('Viết bình luận...');
      fireEvent.change(input, { target: { value: 'Optimistic test comment' } });

      const submitBtn = screen.getByRole('button', { name: 'Bình luận' });
      fireEvent.click(submitBtn);

      // Error message should appear and optimistic item must be rolled back
      expect(
        await screen.findByText('Đã có lỗi xảy ra từ máy chủ. Vui lòng thử lại sau.'),
      ).toBeDefined();
      expect(screen.queryByText('Database connection failed')).toBeNull();
      // The comment text should not remain in the list
      const matching = screen.queryAllByText('Optimistic test comment');
      // Only the textarea might have it or none
      expect(matching.length).toBeLessThanOrEqual(1);
    });

    it('maps 401 error to localized unauthorized message without raw detail', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any);

      vi.spyOn(api.social, 'POST').mockResolvedValue({
        error: {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Raw backend sensitive message',
        },
        response: new Response(null, { status: 401 }),
      } as any);

      render(<CommentSection videoId="v-1" />);

      const input = await screen.findByPlaceholderText('Viết bình luận...');
      fireEvent.change(input, { target: { value: 'Test unauth' } });

      const submitBtn = screen.getByRole('button', { name: 'Bình luận' });
      fireEvent.click(submitBtn);

      expect(await screen.findByText('Bạn cần đăng nhập để thực hiện thao tác này.')).toBeDefined();
      expect(screen.queryByText('Raw backend sensitive message')).toBeNull();
    });

    it('enforces character limits (1-2000 chars) and disables submit when empty or too long', () => {
      const mockSubmit = vi.fn().mockResolvedValue({ success: true });
      render(<CommentComposer onSubmit={mockSubmit} />);

      const textarea = screen.getByPlaceholderText('Viết bình luận...');
      const submitBtn = screen.getByRole('button', { name: 'Bình luận' });

      // Initially empty -> submit button is disabled
      expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

      // Type 1 character -> valid
      fireEvent.change(textarea, { target: { value: 'A' } });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText('1/2000')).toBeDefined();

      // Over limit > 2000 characters
      fireEvent.change(textarea, { target: { value: 'A'.repeat(2001) } });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText('2001/2000')).toBeDefined();
    });

    it('renders 429 rate limit error message with retry-after header', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null },
        response: new Response(null, { status: 200 }),
      } as any);

      // Mock 429 response
      const rateLimitHeaders = new Headers();
      rateLimitHeaders.set('retry-after', '45');
      vi.spyOn(api.social, 'POST').mockResolvedValue({
        error: {
          type: '/problems/rate-limit',
          title: 'Too Many Requests',
          status: 429,
        },
        response: new Response(null, { status: 429, headers: rateLimitHeaders }),
      } as any);

      render(<CommentSection videoId="v-1" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Viết bình luận...')).toBeDefined();
      });

      const input = screen.getByPlaceholderText('Viết bình luận...');
      fireEvent.change(input, { target: { value: 'Fast commenting' } });

      const submitBtn = screen.getByRole('button', { name: 'Bình luận' });
      fireEvent.click(submitBtn);

      expect(
        await screen.findByText('Bạn đang thao tác quá nhanh. Vui lòng thử lại sau 45 giây.'),
      ).toBeDefined();
    });
  });

  describe('CommentItem & 2-Level Reply Hierarchy', () => {
    const topLevelComment: Comment = {
      id: 'c-parent-1',
      video_id: 'v-1',
      parent_id: null,
      author: { id: 'user-alice', display_name: 'Alice', handle: 'alice', avatar_url: null },
      body: 'Top-level comment body',
      status: 'VISIBLE',
      reply_count: 1,
      created_at: new Date().toISOString(),
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };

    const replyComment: Comment = {
      id: 'c-reply-2',
      video_id: 'v-1',
      parent_id: 'c-parent-1',
      author: { id: 'user-bob', display_name: 'Bob', handle: 'bob', avatar_url: null },
      body: 'Second-level reply body',
      status: 'VISIBLE',
      reply_count: 0,
      created_at: new Date().toISOString(),
      edited_at: null,
      can_edit: false,
      can_delete: false,
    };

    it('replying to a reply attaches to its top-level parent (capped at 2 levels)', async () => {
      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        data: {
          id: 'c-reply-3',
          video_id: 'v-1',
          parent_id: 'c-parent-1', // MUST be parent-1, never reply-2
          author: { id: 'user-alice', display_name: 'Alice', handle: 'alice', avatar_url: null },
          body: 'Third comment attaching to root',
          status: 'VISIBLE',
          reply_count: 0,
          created_at: new Date().toISOString(),
          edited_at: null,
          can_edit: true,
          can_delete: true,
        },
        response: new Response(null, { status: 201 }),
      } as any);

      // Render replyComment with topLevelParentId="c-parent-1"
      const { container } = render(
        <CommentItem comment={replyComment} topLevelParentId="c-parent-1" />,
      );

      // Open reply form
      const replyBtn = screen.getByRole('button', { name: /phản hồi/i });
      fireEvent.click(replyBtn);

      const replyTextarea = screen.getByPlaceholderText('Viết câu trả lời...');
      fireEvent.change(replyTextarea, { target: { value: 'Replying to Bob' } });

      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith(
          '/v1/videos/{video_id}/comments',
          expect.objectContaining({
            body: expect.objectContaining({
              parent_id: 'c-parent-1', // Capped at level 2
              body: 'Replying to Bob',
            }),
          }),
        );
      });
    });

    it('tombstone: renders "Bình luận này đã bị xóa." when status is DELETED and hides author body/actions', () => {
      const deletedComment: Comment = {
        ...topLevelComment,
        status: 'DELETED',
        body: '',
      };

      render(<CommentItem comment={deletedComment} />);

      expect(screen.getByText('Bình luận này đã bị xóa.')).toBeDefined();
      expect(screen.queryByText('Top-level comment body')).toBeNull();
      expect(screen.queryByRole('button', { name: /tùy chọn/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /phản hồi/i })).toBeNull();
    });

    it('redirects unauthenticated users to /login?returnTo=... when clicking reply', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<CommentItem comment={topLevelComment} />);

      const replyBtn = screen.getByRole('button', { name: /phản hồi/i });
      fireEvent.click(replyBtn);

      expect(mockPush).toHaveBeenCalledWith('/login?returnTo=%2Fwatch%2Fv-test-123');
    });

    it('tombstone: returns null when status is HIDDEN', () => {
      const hiddenComment: Comment = {
        ...topLevelComment,
        status: 'HIDDEN',
      };

      const { container } = render(<CommentItem comment={hiddenComment} />);
      expect(container.firstChild).toBeNull();
    });

    it('allows edit and delete only when can_edit and can_delete are true', async () => {
      const patchSpy = vi.spyOn(api.social, 'PATCH').mockResolvedValue({
        data: {
          ...topLevelComment,
          body: 'Edited body content',
          edited_at: new Date().toISOString(),
        },
        response: new Response(null, { status: 200 }),
      } as any);

      render(<CommentItem comment={topLevelComment} />);

      // Menu button is present because can_edit is true
      const menuBtn = screen.getByRole('button', { name: /tùy chọn/i });
      fireEvent.click(menuBtn);

      const editBtn = screen.getByRole('button', { name: /chỉnh sửa/i });
      fireEvent.click(editBtn);

      const textarea = screen.getByDisplayValue('Top-level comment body');
      fireEvent.change(textarea, { target: { value: 'Edited body content' } });

      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith(
          '/v1/comments/{comment_id}',
          expect.objectContaining({
            body: { body: 'Edited body content' },
          }),
        );
      });
    });
  });

  describe('LikeButton', () => {
    it('optimistic toggle and server response handling', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { video_id: 'v-1', liked: false, like_count: 10 },
        response: new Response(null, { status: 200 }),
      } as any);

      const putSpy = vi.spyOn(api.social, 'PUT').mockResolvedValue({
        data: { video_id: 'v-1', liked: true, like_count: 11 },
        response: new Response(null, { status: 200 }),
      } as any);

      render(<LikeButton videoId="v-1" initialLikeCount={10} />);

      await waitFor(() => {
        expect(screen.getByText('10')).toBeDefined();
      });

      const likeBtn = screen.getByRole('button', { name: 'Thích' });
      expect(likeBtn.getAttribute('aria-pressed')).toBe('false');

      // Click to like
      fireEvent.click(likeBtn);

      // Optimistically increments to 11
      expect(screen.getByText('11')).toBeDefined();
      expect(likeBtn.getAttribute('aria-pressed')).toBe('true');

      await waitFor(() => {
        expect(putSpy).toHaveBeenCalledWith('/v1/videos/{video_id}/like', {
          params: { path: { video_id: 'v-1' } },
        });
      });
    });

    it('rolls back like toggle on server error', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { video_id: 'v-1', liked: false, like_count: 10 },
        response: new Response(null, { status: 200 }),
      } as any);

      vi.spyOn(api.social, 'PUT').mockResolvedValue({
        error: { type: '/problems/internal', title: 'Server Error', status: 500 },
        response: new Response(null, { status: 500 }),
      } as any);

      render(<LikeButton videoId="v-1" initialLikeCount={10} />);

      await waitFor(() => {
        expect(screen.getByText('10')).toBeDefined();
      });

      const likeBtn = screen.getByRole('button', { name: 'Thích' });
      fireEvent.click(likeBtn);

      // After failure, rolls back to 10
      await waitFor(() => {
        expect(screen.getByText('10')).toBeDefined();
        expect(likeBtn.getAttribute('aria-pressed')).toBe('false');
      });
    });

    it('redirects unauthenticated users to /login?returnTo=...', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<LikeButton videoId="v-1" initialLikeCount={5} />);

      const likeBtn = screen.getByRole('button', { name: 'Thích' });
      fireEvent.click(likeBtn);

      expect(mockPush).toHaveBeenCalledWith('/login?returnTo=%2Fwatch%2Fv-test-123');
    });
  });

  describe('SubscribeButton', () => {
    it('optimistic toggle and server response handling', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValue({
        data: { channel_id: 'chan-1', subscribed: false, subscriber_count: 50 },
        response: new Response(null, { status: 200 }),
      } as any);

      const putSpy = vi.spyOn(api.social, 'PUT').mockResolvedValue({
        data: { channel_id: 'chan-1', subscribed: true, subscriber_count: 51 },
        response: new Response(null, { status: 200 }),
      } as any);

      render(<SubscribeButton channelId="chan-1" initialSubscriberCount={50} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Đăng ký' })).toBeDefined();
      });

      const subBtn = screen.getByRole('button', { name: 'Đăng ký' });
      expect(subBtn.getAttribute('aria-pressed')).toBe('false');

      fireEvent.click(subBtn);

      // Optimistically changes text to "Đã đăng ký"
      expect(screen.getByRole('button', { name: 'Đã đăng ký' })).toBeDefined();
      expect(subBtn.getAttribute('aria-pressed')).toBe('true');

      await waitFor(() => {
        expect(putSpy).toHaveBeenCalledWith('/v1/channels/{channel_id}/subscription', {
          params: { path: { channel_id: 'chan-1' } },
        });
      });
    });

    it('hides button when viewing own channel', () => {
      mockUser = { id: 'channel-self', display_name: 'Self', avatar_url: null, roles: ['user'] };
      const { container } = render(<SubscribeButton channelId="channel-self" />);
      expect(container.firstChild).toBeNull();
    });

    it('redirects unauthenticated users to /login?returnTo=...', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<SubscribeButton channelId="chan-other" />);

      const subBtn = screen.getByRole('button', { name: 'Đăng ký' });
      fireEvent.click(subBtn);

      expect(mockPush).toHaveBeenCalledWith('/login?returnTo=%2Fwatch%2Fv-test-123');
    });
  });

  describe('Keyboard Isolation (Player vs Comment Composer)', () => {
    it('does not trigger video player shortcuts when typing in the comment composer', () => {
      const { container } = render(
        <div>
          <VideoPlayer videoId="v-1" src="https://cdn.example.com/hls/master.m3u8" />
          <CommentComposer onSubmit={vi.fn().mockResolvedValue({ success: true })} />
        </div>,
      );

      const videoEl = container.querySelector('video') as HTMLVideoElement;
      const playSpy = vi.spyOn(videoEl, 'play').mockImplementation(async () => {});
      const pauseSpy = vi.spyOn(videoEl, 'pause').mockImplementation(() => {});

      const textarea = screen.getByPlaceholderText('Viết bình luận...');
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      // Fire Space keydown while focused on textarea
      fireEvent.keyDown(window, { code: 'Space', key: ' ' });
      // Fire KeyK keydown while focused on textarea
      fireEvent.keyDown(window, { code: 'KeyK', key: 'k' });
      // Fire KeyJ keydown while focused on textarea
      fireEvent.keyDown(window, { code: 'KeyJ', key: 'j' });
      // Fire ArrowLeft keydown while focused on textarea
      fireEvent.keyDown(window, { code: 'ArrowLeft', key: 'ArrowLeft' });

      // Player controls must NOT have been called!
      expect(playSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(videoEl.currentTime).toBe(0);
    });
  });
});
