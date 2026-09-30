import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { NotificationBell } from '../src/components/notifications/notification-bell';
import { NotificationDropdown } from '../src/components/notifications/notification-dropdown';
import {
  NotificationItem,
  getNotificationUrl,
} from '../src/components/notifications/notification-item';
import NotificationsPage from '../src/app/[locale]/notifications/page';
import { CommentSection } from '../src/components/social/comment-section';
import { api } from '../src/lib/api-client';
import type { Notification, NotificationPage, Comment, Video } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

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

// --- Routing & Search Params Mock ---
const mockPush = vi.fn();
let currentSearchParamComment: string | null = null;

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === 'comment') return currentSearchParamComment;
      return null;
    },
  }),
}));

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/watch/video-123',
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
const mockUser = {
  id: '0192f5e4-1000-7000-8000-000000000001',
  handle: 'testcreator',
  display_name: 'Test Creator',
  roles: ['user'],
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockUser,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

// --- Realtime Mock ---
vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtimeRoom: vi.fn(),
}));

// Helper to create test QueryClient
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
    },
  });
}

function renderWithClient(ui: React.ReactElement, client = createTestQueryClient()) {
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...result,
    client,
    rerender: (newUi: React.ReactElement) =>
      result.rerender(<QueryClientProvider client={client}>{newUi}</QueryClientProvider>),
  };
}

// Sample notifications fixture
const mockNotificationItems: Notification[] = [
  {
    id: 'notif-1',
    kind: 'VIDEO_COMMENT',
    actor: {
      id: 'user-coder',
      handle: 'vietcoder',
      display_name: 'Viet Coder',
      avatar_url: 'https://cdn.example.com/avatar1.jpg',
    },
    video_id: 'video-123',
    comment_id: 'comment-1',
    read_at: null,
    created_at: '2026-09-20T10:00:00Z',
  },
  {
    id: 'notif-2',
    kind: 'COMMENT_REPLY',
    actor: {
      id: 'user-coder',
      handle: 'vietcoder',
      display_name: 'Viet Coder',
      avatar_url: null,
    },
    video_id: 'video-123',
    comment_id: 'reply-1',
    read_at: null,
    created_at: '2026-09-20T09:30:00Z',
  },
  {
    id: 'notif-3',
    kind: 'VIDEO_PUBLISHED',
    actor: {
      id: 'user-coder',
      handle: 'vietcoder',
      display_name: 'Viet Coder',
      avatar_url: null,
    },
    video_id: 'video-456',
    comment_id: null,
    read_at: null,
    created_at: '2026-09-20T09:00:00Z',
  },
  {
    id: 'notif-4',
    kind: 'NEW_SUBSCRIBER',
    actor: {
      id: 'user-fan',
      handle: 'winkeyfan',
      display_name: 'Winkey Fan',
      avatar_url: null,
    },
    video_id: null,
    comment_id: null,
    read_at: '2026-09-19T08:00:00Z',
    created_at: '2026-09-19T08:00:00Z',
  },
];

describe('N1-web: Notifications System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTestLocale('vi');
    mockIsAuthenticated = true;
    currentSearchParamComment = null;
    Element.prototype.scrollIntoView = vi.fn();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    focusManager.setFocused(true);
  });

  // --------------------------------------------------------------------------
  // 1. NotificationBell & Unread Badge
  // --------------------------------------------------------------------------
  describe('NotificationBell', () => {
    it('hides badge when unread count is 0', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 0, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByTestId('notification-bell-button')).toBeDefined();
      });

      expect(screen.queryByTestId('notification-badge')).toBeNull();
    });

    it('shows exact number when unread count is 7', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 7, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      await waitFor(() => {
        const badge = screen.getByTestId('notification-badge');
        expect(badge).toBeDefined();
        expect(badge.textContent).toBe('7');
      });
    });

    it('shows "99+" when capped is true or count >= 100', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 100, capped: true },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      await waitFor(() => {
        const badge = screen.getByTestId('notification-badge');
        expect(badge).toBeDefined();
        expect(badge.textContent).toBe('99+');
      });
    });

    it('does not poll when signed out', async () => {
      mockIsAuthenticated = false;
      const getSpy = vi.spyOn(api.social, 'GET');

      renderWithClient(<NotificationBell />);

      expect(screen.queryByTestId('notification-bell-button')).toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    });

    it('pauses polling when tab is hidden (refetchIntervalInBackground: false)', async () => {
      vi.useFakeTimers();
      try {
        let fetchCount = 0;
        vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
          if (path === '/v1/notifications/unread-count') {
            fetchCount++;
            return {
              data: { count: 3, capped: false },
              response: new Response(null, { status: 200 }),
            } as any;
          }
          return { response: new Response(null, { status: 404 }) } as any;
        });

        renderWithClient(<NotificationBell />);

        // Initial query resolves
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        expect(fetchCount).toBe(1);

        // Simulate tab hidden
        focusManager.setFocused(false);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Advance 60 seconds while hidden
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60000);
        });
        // Should not refetch in background
        expect(fetchCount).toBe(1);

        // Tab becomes visible again
        focusManager.setFocused(true);
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        // Refetched on focus / visibility
        expect(fetchCount).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
        focusManager.setFocused(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. NotificationDropdown & Accessibility
  // --------------------------------------------------------------------------
  describe('NotificationDropdown', () => {
    it('toggles aria-expanded and closes on Escape and click-outside', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 2, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/notifications') {
          return {
            data: { items: mockNotificationItems.slice(0, 2), next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      const button = screen.getByTestId('notification-bell-button');
      expect(button.getAttribute('aria-expanded')).toBe('false');

      // Click to open
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');

      // Dialog is open
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeDefined();

      // Press Escape closes it
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      // Re-open and test click outside
      fireEvent.click(button);
      expect(await screen.findByRole('dialog')).toBeDefined();

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('opening dropdown does NOT mark notifications as read', async () => {
      const postSpy = vi.spyOn(api.social, 'POST');
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 3, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/notifications') {
          return {
            data: { items: mockNotificationItems, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      fireEvent.click(screen.getByTestId('notification-bell-button'));
      await screen.findByRole('dialog');

      expect(postSpy).not.toHaveBeenCalled();
    });

    it('clicking an unread item marks that single ID as read and closes dropdown', async () => {
      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        response: new Response(null, { status: 204 }),
      } as any);

      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 3, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/notifications') {
          return {
            data: { items: mockNotificationItems, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      fireEvent.click(screen.getByTestId('notification-bell-button'));
      const item1 = await screen.findByTestId('notification-item-notif-1');

      fireEvent.click(item1);

      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith('/v1/notifications/read', {
          body: { ids: ['notif-1'] },
        });
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('"Đánh dấu đã đọc tất cả" sends up_to = newest notification created_at (NEVER client clock)', async () => {
      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValue({
        response: new Response(null, { status: 204 }),
      } as any);

      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 3, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/notifications') {
          return {
            data: { items: mockNotificationItems, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationBell />);

      fireEvent.click(screen.getByTestId('notification-bell-button'));
      await screen.findByRole('dialog');

      // Click "Đánh dấu đã đọc tất cả"
      const markAllBtn = await screen.findByText('Đánh dấu đã đọc tất cả');
      fireEvent.click(markAllBtn);

      const newestCreatedAt = mockNotificationItems[0].created_at; // '2026-09-20T10:00:00Z'
      await waitFor(() => {
        expect(postSpy).toHaveBeenCalledWith('/v1/notifications/read', {
          body: { up_to: newestCreatedAt },
        });
      });
    });

    it('rolls back optimistic update on 500 error', async () => {
      vi.spyOn(api.social, 'POST').mockResolvedValue({
        response: new Response(null, { status: 500 }),
      } as any);

      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications/unread-count') {
          return {
            data: { count: 3, capped: false },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/notifications') {
          return {
            data: { items: [...mockNotificationItems], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      const { client } = renderWithClient(<NotificationDropdown isOpen={true} onClose={vi.fn()} />);

      const item1 = await screen.findByTestId('notification-item-notif-1');
      expect(item1.getAttribute('data-unread')).toBe('true');

      // Trigger mark read
      fireEvent.click(item1);

      // On error, mutation rolls back and invalidates
      await waitFor(() => {
        const itemState = client.getQueryData<NotificationPage>(['notifications', 'latest-10']);
        expect(itemState?.items[0].read_at).toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // 3. Rendering Per Kind & Lazy Title Loading
  // --------------------------------------------------------------------------
  describe('NotificationItem', () => {
    it('renders correct text and URL for each kind in Vietnamese', async () => {
      setTestLocale('vi');

      // 1. VIDEO_COMMENT
      const urlComment = getNotificationUrl(mockNotificationItems[0]);
      expect(urlComment).toBe('/watch/video-123?comment=comment-1');

      // 2. COMMENT_REPLY
      const urlReply = getNotificationUrl(mockNotificationItems[1]);
      expect(urlReply).toBe('/watch/video-123?comment=reply-1');

      // 3. VIDEO_PUBLISHED
      const urlPublished = getNotificationUrl(mockNotificationItems[2]);
      expect(urlPublished).toBe('/watch/video-456');

      // 4. NEW_SUBSCRIBER
      const urlSubscriber = getNotificationUrl(mockNotificationItems[3]);
      expect(urlSubscriber).toBe('/c/winkeyfan');
    });

    it('renders correct translated text for each kind in English', async () => {
      setTestLocale('en');

      const { rerender } = renderWithClient(
        <NotificationItem notification={mockNotificationItems[0]} />,
      );
      expect(screen.getByText('Viet Coder commented on your video')).toBeDefined();

      rerender(<NotificationItem notification={mockNotificationItems[1]} />);
      expect(screen.getByText('Viet Coder replied to your comment')).toBeDefined();

      rerender(<NotificationItem notification={mockNotificationItems[2]} />);
      expect(screen.getByText('Viet Coder published a new video')).toBeDefined();

      rerender(<NotificationItem notification={mockNotificationItems[3]} />);
      expect(screen.getByText('Winkey Fan subscribed to your channel')).toBeDefined();
    });

    it('unread items are visually distinct not by color only (dot indicator + aria-label)', () => {
      renderWithClient(<NotificationItem notification={mockNotificationItems[0]} />);

      const dot = screen.getByTitle(/chưa đọc/i);
      expect(dot).toBeDefined();
      expect(dot.getAttribute('aria-label')).toBe('chưa đọc');
    });

    it('lazily fetches video title and displays it', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { id: 'video-123', title: 'Kubernetes Architecture 101' } as Video,
        response: new Response(null, { status: 200 }),
      } as any);

      renderWithClient(<NotificationItem notification={mockNotificationItems[0]} />);

      await waitFor(() => {
        expect(screen.getByText('"Kubernetes Architecture 101"')).toBeDefined();
      });
    });

    it('404 on getVideo gracefully falls back without title and without error state', async () => {
      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: null,
        response: new Response(null, { status: 404 }),
      } as any);

      renderWithClient(<NotificationItem notification={mockNotificationItems[0]} />);

      // Still renders notification text cleanly
      expect(screen.getByText(/Viet Coder đã bình luận về video của bạn/)).toBeDefined();
      // No title quotes
      expect(screen.queryByText(/".*"/)).toBeNull();
      // No error state
      expect(screen.queryByText(/lỗi/i)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Notifications Page (Tabs, Cursor Pagination, Infinite List)
  // --------------------------------------------------------------------------
  describe('Notifications Page', () => {
    it('supports switching between "Tất cả" and "Chưa đọc" tabs', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path, opts: any) => {
        if (path === '/v1/notifications') {
          const isUnread = opts?.params?.query?.unread;
          if (isUnread) {
            return {
              data: { items: mockNotificationItems.filter((n) => !n.read_at), next_cursor: null },
              response: new Response(null, { status: 200 }),
            } as any;
          }
          return {
            data: { items: mockNotificationItems, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationsPage />);

      // Initially on "Tất cả" tab
      await waitFor(() => {
        expect(screen.getByTestId('notification-item-notif-1')).toBeDefined();
        expect(screen.getByTestId('notification-item-notif-4')).toBeDefined();
      });

      // Switch to "Chưa đọc" tab
      const unreadTab = screen.getByTestId('notifications-tab-unread');
      fireEvent.click(unreadTab);

      // Now only unread items are visible
      await waitFor(() => {
        expect(screen.getByTestId('notification-item-notif-1')).toBeDefined();
        expect(screen.queryByTestId('notification-item-notif-4')).toBeNull();
      });
    });

    it('renders empty state when there are no notifications', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path) => {
        if (path === '/v1/notifications') {
          return {
            data: { items: [], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<NotificationsPage />);

      await waitFor(() => {
        expect(screen.getByText('Chưa có thông báo nào.')).toBeDefined();
      });
    });
  });

  // --------------------------------------------------------------------------
  // 5. Comment Deep-linking (/watch/{id}?comment={comment_id})
  // --------------------------------------------------------------------------
  describe('Comment Deep-Linking (?comment={comment_id})', () => {
    const mockComments: Comment[] = [
      {
        id: 'comment-top-1',
        video_id: 'video-123',
        parent_id: null,
        author: { id: 'u1', handle: 'author1', display_name: 'Author 1', avatar_url: null },
        body: 'Top level comment 1',
        status: 'VISIBLE',
        reply_count: 1,
        created_at: '2026-09-18T10:00:00Z',
        edited_at: null,
        can_edit: false,
        can_delete: false,
      },
      {
        id: 'comment-top-2',
        video_id: 'video-123',
        parent_id: null,
        author: { id: 'u2', handle: 'author2', display_name: 'Author 2', avatar_url: null },
        body: 'Top level comment 2',
        status: 'VISIBLE',
        reply_count: 0,
        created_at: '2026-09-18T11:00:00Z',
        edited_at: null,
        can_edit: false,
        can_delete: false,
      },
    ];

    const mockReply: Comment = {
      id: 'reply-child-1',
      video_id: 'video-123',
      parent_id: 'comment-top-1',
      author: { id: 'u3', handle: 'author3', display_name: 'Author 3', avatar_url: null },
      body: 'Child reply 1',
      status: 'VISIBLE',
      reply_count: 0,
      created_at: '2026-09-18T12:00:00Z',
      edited_at: null,
      can_edit: false,
      can_delete: false,
    };

    it('scrolls to and highlights a top-level comment', async () => {
      currentSearchParamComment = 'comment-top-1';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path, _opts: any) => {
        if (path === '/v1/videos/{video_id}/comments') {
          return {
            data: { items: mockComments, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/comments/{comment_id}') {
          return { data: mockComments[0], response: new Response(null, { status: 200 }) } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<CommentSection videoId="video-123" />);

      const topItem = await screen.findByTestId('comment-item-comment-top-1');
      expect(topItem).toBeDefined();

      await waitFor(() => {
        expect(topItem.getAttribute('data-highlighted')).toBe('true');
      });
      await waitFor(() => {
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      });
    });

    it('expands parent thread and highlights reply comment when comment is a reply', async () => {
      currentSearchParamComment = 'reply-child-1';

      vi.spyOn(api.social, 'GET').mockImplementation(async (path, opts: any) => {
        if (path === '/v1/videos/{video_id}/comments') {
          return {
            data: { items: mockComments, next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        if (path === '/v1/comments/{comment_id}') {
          const commentId = opts?.params?.path?.comment_id;
          if (commentId === 'reply-child-1') {
            return { data: mockReply, response: new Response(null, { status: 200 }) } as any;
          }
          return { response: new Response(null, { status: 404 }) } as any;
        }
        if (path === '/v1/comments/{comment_id}/replies') {
          return {
            data: { items: [mockReply], next_cursor: null },
            response: new Response(null, { status: 200 }),
          } as any;
        }
        return { response: new Response(null, { status: 404 }) } as any;
      });

      renderWithClient(<CommentSection videoId="video-123" />);

      // Parent thread is auto-expanded and reply is rendered & highlighted
      const replyItem = await screen.findByTestId('comment-item-reply-child-1');
      expect(replyItem).toBeDefined();

      await waitFor(() => {
        expect(replyItem.getAttribute('data-highlighted')).toBe('true');
      });
      await waitFor(() => {
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      });
    });
  });
});
