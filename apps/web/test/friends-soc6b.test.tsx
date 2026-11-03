import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Notification } from '@winkey/api-client';
import viMessages from '../messages/vi.json';

const socialGet = vi.fn();
const socialPut = vi.fn();
const socialDelete = vi.fn();
const socialPost = vi.fn();
vi.mock('../src/lib/api-client', () => ({
  api: {
    social: {
      GET: (...a: unknown[]) => socialGet(...a),
      PUT: (...a: unknown[]) => socialPut(...a),
      DELETE: (...a: unknown[]) => socialDelete(...a),
      POST: (...a: unknown[]) => socialPost(...a),
    },
  },
}));

let authenticated = true;
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: authenticated, isLoading: false, user: { id: 'me' } }),
}));

const push = vi.fn();
const replace = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => '/c/lan_anh',
  Link: ({ children, href, className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href as string} className={className} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/e2ee/chat-service', () => ({
  getChatService: () => ({ createConversation: vi.fn() }),
}));

import { friendState } from '../src/lib/social/friends';
import { FriendButton, type FriendRelation } from '../src/components/social/friend-button';
import { FriendsView } from '../src/components/social/friends-view';
import { NewChatDialog } from '../src/components/chat/new-chat-dialog';
import {
  NotificationItem,
  getNotificationUrl,
} from '../src/components/notifications/notification-item';

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
const lan = {
  id: '0192f5e4-0000-7000-8000-00000000f001',
  handle: 'lan_anh',
  display_name: 'Lan Anh',
  avatar_url: null,
};
const ha = {
  id: '0192f5e4-0000-7000-8000-00000000f101',
  handle: 'thu_ha',
  display_name: 'Thu Hà',
  avatar_url: null,
};
const huy = {
  id: '0192f5e4-0000-7000-8000-00000000f102',
  handle: 'duc_huy',
  display_name: 'Đức Huy',
  avatar_url: null,
};

beforeEach(() => {
  authenticated = true;
  for (const f of [socialGet, socialPut, socialDelete, socialPost, push, replace]) f.mockReset();
});

describe('SOC-6b: friend state', () => {
  it('maps the relationship to Kết bạn / Đã gửi lời mời / Bạn bè / Chấp nhận', () => {
    expect(friendState({ following: true, follow_requested: false, followed_by: true })).toBe(
      'friends',
    );
    expect(friendState({ following: true, follow_requested: false, followed_by: false })).toBe(
      'sent',
    );
    expect(friendState({ following: false, follow_requested: true, followed_by: false })).toBe(
      'sent',
    );
    expect(friendState({ following: false, follow_requested: false, followed_by: true })).toBe(
      'incoming',
    );
    expect(friendState({ following: false, follow_requested: false, followed_by: false })).toBe(
      'none',
    );
  });
});

describe('SOC-6b: profile friend button', () => {
  function Harness({ initial }: { initial: FriendRelation | null }) {
    const [rel, setRel] = React.useState(initial);
    return (
      <FriendButton
        userId={lan.id}
        displayName="Lan Anh"
        relation={rel}
        onRelationChange={setRel}
      />
    );
  }

  it('Kết bạn follows and shows Đã gửi lời mời; Huỷ lời mời unfollows', async () => {
    socialPut.mockResolvedValue(
      ok({ channel_id: lan.id, subscribed: true, requested: false, subscriber_count: 5 }),
    );
    socialDelete.mockResolvedValue(
      ok({ channel_id: lan.id, subscribed: false, requested: false, subscriber_count: 4 }),
    );
    render(<Harness initial={{ following: false, follow_requested: false, followed_by: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kết bạn với Lan Anh' }));
    const sent = await screen.findByRole('button', { name: /Đã gửi lời mời/ });
    expect(socialPut).toHaveBeenCalledWith('/v1/channels/{channel_id}/subscription', {
      params: { path: { channel_id: lan.id } },
    });
    fireEvent.click(sent);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Huỷ lời mời' }));
    expect(await screen.findByRole('button', { name: 'Kết bạn với Lan Anh' })).toBeTruthy();
    expect(socialDelete).toHaveBeenCalledTimes(1);
  });

  it('Chấp nhận follows back and becomes Bạn bè, with Huỷ kết bạn in its menu', async () => {
    socialPut.mockResolvedValue(
      ok({ channel_id: lan.id, subscribed: true, requested: false, subscriber_count: 5 }),
    );
    render(<Harness initial={{ following: false, follow_requested: false, followed_by: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận lời mời kết bạn của Lan Anh' }));
    const friends = await screen.findByRole('button', { name: /Bạn bè/ });
    fireEvent.click(friends);
    expect(screen.getByRole('menuitem', { name: 'Huỷ kết bạn' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a private account answers requested: the button says Đã gửi lời mời, not Bạn bè', async () => {
    socialPut.mockResolvedValue(
      ok({ channel_id: lan.id, subscribed: false, requested: true, subscriber_count: 9 }),
    );
    render(<Harness initial={{ following: false, follow_requested: false, followed_by: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chấp nhận lời mời kết bạn của Lan Anh' }));
    expect(await screen.findByRole('button', { name: /Đã gửi lời mời/ })).toBeTruthy();
  });

  it('signed out: Kết bạn goes to login and back', () => {
    authenticated = false;
    render(<Harness initial={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kết bạn với Lan Anh' }));
    expect(push).toHaveBeenCalledWith(`/login?return_to=${encodeURIComponent('/c/lan_anh')}`);
    expect(socialPut).not.toHaveBeenCalled();
  });
});

describe('SOC-6b: /ban-be', () => {
  function routeGets() {
    socialGet.mockImplementation(async (path: string) => {
      if (path === '/v1/me/friends')
        return ok({
          items: [{ user: lan, friends_since: '2026-10-30T08:00:00Z' }],
          next_cursor: null,
        });
      if (path === '/v1/me/friend-requests') {
        return ok({
          items: [
            { user: ha, followed_at: '2026-10-31T09:00:00Z' },
            { user: huy, followed_at: '2026-10-31T08:00:00Z' },
          ],
          next_cursor: null,
          pending_count: 2,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
  }

  it('lists friends with Nhắn tin, and requests with a count badge; accept and dismiss update the list', async () => {
    routeGets();
    socialPut.mockResolvedValue(
      ok({ channel_id: ha.id, subscribed: true, requested: false, subscriber_count: 1 }),
    );
    socialPost.mockResolvedValue({
      data: undefined,
      response: new Response(null, { status: 204 }),
    });
    render(<FriendsView />);

    const list = await screen.findByRole('list');
    expect(within(list).getByText('Lan Anh')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nhắn tin cho Lan Anh' }).getAttribute('href')).toBe(
      `/tin-nhan?to=${lan.id}`,
    );
    expect(await screen.findByLabelText('2 lời mời')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Lời mời/ }));
    expect(replace).toHaveBeenCalledWith('/ban-be?tab=loi-moi');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Chấp nhận lời mời kết bạn của Thu Hà' }),
    );
    expect(await screen.findByText('Bạn và Thu Hà đã là bạn bè.')).toBeTruthy();
    expect(screen.queryByText('Thu Hà')).toBeNull();
    expect(screen.getByLabelText('1 lời mời')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Xoá lời mời kết bạn của Đức Huy' }));
    expect(await screen.findByText(/Đã xoá lời mời của Đức Huy/)).toBeTruthy();
    expect(socialPost).toHaveBeenCalledWith('/v1/me/friend-requests/{user_id}/dismiss', {
      params: { path: { user_id: huy.id } },
    });
    expect(screen.getByText('Không có lời mời kết bạn nào.')).toBeTruthy();
    expect(screen.queryByLabelText(/lời mời$/)).toBeNull();
  });

  it('tabs follow the WAI-ARIA pattern (arrow keys) and the ?tab= deep link opens Lời mời', async () => {
    routeGets();
    render(<FriendsView initialTab="loi-moi" />);
    const requestsTab = screen.getByRole('tab', { name: /Lời mời/ });
    expect(requestsTab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('Thu Hà')).toBeTruthy();
    fireEvent.keyDown(requestsTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Tìm bạn' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('Tìm người dùng')).toBeTruthy();
  });

  it('unfriend asks first, then unfollows and removes the row', async () => {
    routeGets();
    socialDelete.mockResolvedValue(
      ok({ channel_id: lan.id, subscribed: false, requested: false, subscriber_count: 0 }),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FriendsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Huỷ kết bạn với Lan Anh' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Lan Anh')).toBeNull());
    expect(socialDelete).toHaveBeenCalledWith('/v1/channels/{channel_id}/subscription', {
      params: { path: { channel_id: lan.id } },
    });
    confirm.mockRestore();
  });

  it('signed out: asks to log in', () => {
    authenticated = false;
    render(<FriendsView />);
    expect(screen.getByRole('link', { name: 'Đăng nhập' }).getAttribute('href')).toBe(
      `/login?return_to=${encodeURIComponent('/ban-be')}`,
    );
  });
});

describe('SOC-6b: friends first and the notification', () => {
  it('the new-chat dialog suggests friends before typing', async () => {
    socialGet.mockImplementation(async (path: string) =>
      path === '/v1/me/friends'
        ? ok({ items: [{ user: lan, friends_since: '2026-10-30T08:00:00Z' }], next_cursor: null })
        : ok({ items: [], next_cursor: null }),
    );
    render(<NewChatDialog isOpen onClose={() => {}} onCreated={() => {}} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Người nhận' }));
    expect(await screen.findByRole('option', { name: /Lan Anh/ })).toBeTruthy();
    expect(socialGet).toHaveBeenCalledWith('/v1/me/friends', { params: { query: { limit: 20 } } });
  });

  it('renders FRIEND_ACCEPTED in Vietnamese and links to the new friend', () => {
    const n = {
      id: '0192f5e4-0000-7000-8000-0000000a0001',
      kind: 'FRIEND_ACCEPTED',
      actor: { id: lan.id, handle: 'lan_anh', display_name: 'Lan Anh', avatar_url: null },
      read: false,
      created_at: '2026-10-31T09:00:00Z',
    } as unknown as Notification;
    expect(getNotificationUrl(n)).toBe('/c/lan_anh');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <NotificationItem notification={n} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Lan Anh đã chấp nhận lời mời kết bạn của bạn/)).toBeTruthy();
  });
});
