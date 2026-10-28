import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';

const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/bang-tin',
  Link: ({ children, href, className, onClick, ...rest }: any) => (
    <a href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/bang-tin',
  useSearchParams: () => new URLSearchParams(),
}));

const mockUser = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  handle: 'creator',
  display_name: 'Winkey Creator',
  email: 'creator@winkey.vn',
  avatar_url: 'https://images.winkey.vn/avatar.webp',
  roles: ['creator'],
  is_private: false,
};

let currentMockUser: any = mockUser;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: currentMockUser,
    isAuthenticated: Boolean(currentMockUser),
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

import { PostBodyText, tokenizePostBody } from '../src/components/social/posts/post-body-text';
import { PostCard } from '../src/components/social/posts/post-card';
import { PostComposer } from '../src/components/social/posts/post-composer';
import { PostReactions } from '../src/components/social/posts/post-reactions';
import {
  NotificationItem,
  getNotificationUrl,
} from '../src/components/notifications/notification-item';
import type { Post, Notification } from '@winkey/api-client';
import { api } from '../src/lib/api-client';
import viMessages from '../messages/vi.json';

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

describe('SOC-2a: Post Body Text Tokenizer & Safe Rendering', () => {
  it('strictly treats raw HTML and scripts as plain text without rendering HTML tags', () => {
    const malicious = '<script>alert("xss")</script><img src=x onerror=alert(1)><b>Bold</b>';
    const { container } = renderWithProviders(<PostBodyText body={malicious} />);

    // Must not contain injected script or img elements
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<script>alert("xss")</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('only links mentions and hashtags that are listed in post metadata', () => {
    const body = 'Xin chào @valid_user và @unlisted_user! Xem #winkey và #unlisted_tag nhé.';
    const mentions = [{ handle: 'valid_user', user_id: 'chan-1' }];
    const hashtags = [{ tag: 'winkey', slug: 'winkey' }];

    const { container } = renderWithProviders(
      <PostBodyText body={body} mentions={mentions} hashtags={hashtags} />,
    );

    const links = container.querySelectorAll('a');
    expect(links.length).toBe(2);

    expect(links[0].getAttribute('href')).toBe('/c/valid_user');
    expect(links[0].textContent).toBe('@valid_user');

    expect(links[1].getAttribute('href')).toBe('/hashtag/winkey');
    expect(links[1].textContent).toBe('#winkey');

    // Unlisted handles and tags remain plain text
    expect(container.textContent).toContain('@unlisted_user');
    expect(container.textContent).toContain('#unlisted_tag');
  });

  it('tokenizePostBody correctly segments text, handles punctuation after tags', () => {
    const tokens = tokenizePostBody(
      'Ghé thăm @winkeyvn, hay tìm #tech!',
      [{ handle: 'winkeyvn', user_id: '1' }],
      [{ tag: 'tech', slug: 'tech' }],
    );

    expect(tokens.length).toBe(5);
    expect(tokens[0]).toEqual({ type: 'text', text: 'Ghé thăm ' });
    expect(tokens[1]).toEqual({ type: 'mention', text: '@winkeyvn', href: '/c/winkeyvn' });
    expect(tokens[2]).toEqual({ type: 'text', text: ', hay tìm ' });
    expect(tokens[3]).toEqual({ type: 'hashtag', text: '#tech', href: '/hashtag/tech' });
    expect(tokens[4]).toEqual({ type: 'text', text: '!' });
  });

  it('renders mentions with /c/${handle} href and adheres to server hashtag regex rules (letters, numbers, underscore)', () => {
    const body = 'Xin chào @developer_vn! Tham gia #HàNội_2026 và #winkey_100 ngay hôm nay.';
    const mentions = [{ handle: 'developer_vn', user_id: 'user-dev' }];
    const hashtags = [
      { tag: 'HàNội_2026', slug: 'hanoi-2026' },
      { tag: 'winkey_100', slug: 'winkey-100' },
    ];

    const { container } = renderWithProviders(
      <PostBodyText body={body} mentions={mentions} hashtags={hashtags} />,
    );

    const mentionLink = container.querySelector('a[href="/c/developer_vn"]');
    expect(mentionLink).not.toBeNull();
    expect(mentionLink?.textContent).toBe('@developer_vn');
    // Ensure no legacy /@ links
    expect(container.querySelector('a[href="/@developer_vn"]')).toBeNull();

    const hashtag1Link = container.querySelector('a[href="/hashtag/hanoi-2026"]');
    expect(hashtag1Link).not.toBeNull();
    expect(hashtag1Link?.textContent).toBe('#HàNội_2026');

    const hashtag2Link = container.querySelector('a[href="/hashtag/winkey-100"]');
    expect(hashtag2Link).not.toBeNull();
    expect(hashtag2Link?.textContent).toBe('#winkey_100');
  });
});

describe('SOC-2a: Post Card Component', () => {
  const basePost: Post = {
    id: '0192f5e4-0000-7000-8000-000000000001',
    author: {
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
      handle: 'tech_guy',
      display_name: 'Tech Guy',
      avatar_url: 'https://images.winkey.vn/avatar2.webp',
    },
    body: 'Nội dung bài viết mẫu trên Winkey.',
    visibility: 'PUBLIC',
    status: 'VISIBLE',
    mentions: [],
    hashtags: [],
    images: [],
    video_id: null,
    reshare_of: null,
    reshared_post: null,
    reshare_unavailable: false,
    reaction_count: 5,
    my_reaction: null,
    top_reactions: [{ reaction: 'LIKE', count: 5 }],
    comment_count: 2,
    reshare_count: 1,
    created_at: '2026-10-28T09:00:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  };

  it('renders author, relative time, body and visibility icon', () => {
    const { container } = renderWithProviders(<PostCard post={basePost} />);

    expect(screen.getByText('Tech Guy')).toBeDefined();
    expect(screen.getByText('@tech_guy')).toBeDefined();
    expect(screen.getByText('Nội dung bài viết mẫu trên Winkey.')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();

    // Verify author profile link points to /c/${handle} and not /@${handle}
    const authorLinks = container.querySelectorAll('a[href="/c/tech_guy"]');
    expect(authorLinks.length).toBeGreaterThan(0);
    expect(container.querySelector('a[href="/@tech_guy"]')).toBeNull();
  });

  it('renders "Bài viết này không còn khả dụng" when reshare_unavailable is true', () => {
    const postWithBrokenReshare: Post = {
      ...basePost,
      id: 'post-broken-reshare',
      reshare_of: 'deleted-post-id',
      reshared_post: null,
      reshare_unavailable: true,
    };

    renderWithProviders(<PostCard post={postWithBrokenReshare} />);
    expect(screen.getByText(/Bài viết này không còn khả dụng/i)).toBeDefined();
  });

  it('renders nested reshared post when available', () => {
    const postWithReshare: Post = {
      ...basePost,
      id: 'post-with-reshare',
      reshare_of: 'orig-1',
      reshared_post: {
        ...basePost,
        id: 'orig-1',
        body: 'Bài viết gốc từ tác giả!',
      },
      reshare_unavailable: false,
    };

    renderWithProviders(<PostCard post={postWithReshare} />);
    expect(screen.getByText('Bài viết gốc từ tác giả!')).toBeDefined();
  });
});

describe('SOC-2a: Post Reactions Bar & Optimistic Rollback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('optimistically updates reaction on click, rolls back on API error', async () => {
    // Mock API failure for reaction
    vi.spyOn(api.social, 'PUT').mockRejectedValueOnce(new Error('Network error'));

    renderWithProviders(
      <PostReactions
        postId="test-post-id"
        initialMyReaction={null}
        initialReactionCount={10}
        initialTopReactions={[{ reaction: 'LIKE', count: 10 }]}
        isAuthenticated={true}
      />,
    );

    const reactButton = screen.getByRole('button', { name: /Thích/i });
    expect(reactButton).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();

    // Click to react
    fireEvent.click(reactButton);

    // Optimistic update: count increases to 11
    await waitFor(() => {
      expect(screen.getByText('11')).toBeDefined();
    });

    // After API failure, count must roll back to 10
    await waitFor(() => {
      expect(screen.getByText('10')).toBeDefined();
    });
  });
});

describe('SOC-2a: Post Composer', () => {
  beforeEach(() => {
    currentMockUser = mockUser;
  });

  it('shows live counter decreasing up to 2000 chars and disables submit when empty', () => {
    renderWithProviders(<PostComposer />);

    const submitBtn = screen.getByRole('button', { name: /Đăng/i });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    const textarea = screen.getByPlaceholderText('Bạn đang nghĩ gì?');
    expect(screen.getByText('2000')).toBeDefined();

    fireEvent.change(textarea, { target: { value: 'Xin chào Winkey!' } });
    expect(screen.getByText((2000 - 'Xin chào Winkey!'.length).toString())).toBeDefined();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides visibility selector and locks to followers-only with note for private accounts', () => {
    currentMockUser = {
      ...mockUser,
      is_private: true,
    };

    renderWithProviders(<PostComposer />);

    expect(screen.getByText(/Chỉ người theo dõi \(Tài khoản riêng tư\)/i)).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('SOC-2a: Notifications 5 POST_* kinds', () => {
  const baseNotification: Notification = {
    id: '0192f5e4-0000-7000-8000-000000000099',
    actor: {
      id: 'actor-1',
      handle: 'minh_nguyen',
      display_name: 'Minh Nguyễn',
      avatar_url: 'https://images.winkey.vn/avatar.webp',
    },
    kind: 'POST_COMMENT',
    video_id: null,
    comment_id: null,
    post_id: '0192f5e4-7c1a-7b3e-9d2a-000000000001',
    post_comment_id: 'c-1',
    created_at: '2026-10-28T10:00:00Z',
    read_at: null,
  };

  it('correctly maps URL to /bai-viet/{post_id}', () => {
    expect(getNotificationUrl(baseNotification)).toBe(
      '/bai-viet/0192f5e4-7c1a-7b3e-9d2a-000000000001',
    );
  });

  it('renders all 5 POST_* notification kinds properly', () => {
    const kinds: Array<Notification['kind']> = [
      'POST_COMMENT',
      'POST_COMMENT_REPLY',
      'POST_MENTION',
      'POST_RESHARE',
      'POST_REACTION',
    ];

    for (const kind of kinds) {
      const n: Notification = { ...baseNotification, kind };
      const { unmount } = renderWithProviders(<NotificationItem notification={n} />);
      expect(screen.getByTestId(`notification-item-${n.id}`)).toBeDefined();
      unmount();
    }
  });

  it('ignores unknown notification kinds by returning null', () => {
    const unknownNotification = {
      ...baseNotification,
      kind: 'UNKNOWN_FUTURE_EVENT' as any,
    };

    const { container } = renderWithProviders(
      <NotificationItem notification={unknownNotification} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

import { FeedClient } from '../src/app/[locale]/bang-tin/feed-client';

describe('SOC-2a: FeedClient & CURSOR_EXPIRED recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders feeds tabs and switches between Following and Explore', async () => {
    renderWithProviders(<FeedClient />);

    expect(screen.getByTestId('feed-tab-following')).toBeDefined();
    expect(screen.getByTestId('feed-tab-explore')).toBeDefined();

    // Switch to Explore tab
    fireEvent.click(screen.getByTestId('feed-tab-explore'));

    await waitFor(() => {
      expect(screen.getByTestId('feed-tab-explore').className).toContain('bg-red-600');
    });
  });

  it('recovers from CURSOR_EXPIRED by resetting cursor and reloading top of feed', async () => {
    let callCount = 0;
    vi.spyOn(api.social, 'GET').mockImplementation((path: any, options: any) => {
      if (path === '/v1/feed/following') {
        callCount++;
        if (options?.params?.query?.cursor === 'expired-cur') {
          return Promise.resolve({
            response: { status: 400, ok: false },
            error: { code: 'CURSOR_EXPIRED', detail: 'Snapshot expired' },
            data: undefined,
          } as any);
        }
        return Promise.resolve({
          response: { status: 200, ok: true },
          data: {
            items: [
              {
                id: `post-${callCount}`,
                author: mockUser,
                body: `Post call ${callCount}`,
                visibility: 'PUBLIC',
                status: 'VISIBLE',
                mentions: [],
                hashtags: [],
                images: [],
                reaction_count: 0,
                my_reaction: null,
                top_reactions: [],
                comment_count: 0,
                reshare_count: 0,
                created_at: '2026-10-28T10:00:00Z',
                can_edit: true,
                can_delete: true,
              },
            ],
            next_cursor: 'expired-cur',
          },
        } as any);
      }
      return Promise.resolve({
        response: { status: 200, ok: true },
        data: { items: [] },
      } as any);
    });

    renderWithProviders(<FeedClient />);

    await waitFor(() => {
      expect(screen.getByText('Post call 1')).toBeDefined();
    });

    // Click Tải thêm which uses next_cursor 'expired-cur'
    const loadMoreBtn = await screen.findByRole('button', { name: /Tải thêm/i });
    fireEvent.click(loadMoreBtn);

    // CURSOR_EXPIRED triggers reload without cursor
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });
});
