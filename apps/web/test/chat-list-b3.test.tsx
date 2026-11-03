import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { Conversation } from '@winkey/api-client';

const fetchMessages = vi.fn();
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => ({ fetchMessages }) }));

import { ConversationList } from '../src/components/chat/conversation-list';
import { clearConversationPreviews } from '../src/lib/chat/conversation-previews';
import { foldText, formatListTime } from '../src/lib/chat/format';
import { previewOf } from '../src/lib/chat/message-text';
import type { DecryptedMessageItem } from '../src/lib/e2ee/chat-service';

const ME = 'user-me';
const LAN = 'user-lan';
const TUAN = 'user-tuan';

const member = (user_id: string, name: string, handle: string) => ({
  user_id,
  role: 'MEMBER' as const,
  state: 'ACTIVE' as const,
  last_read_seq: 0,
  user: { id: user_id, handle, display_name: name, avatar_url: null },
});

function conv(id: string, extra: Partial<Conversation>): Conversation {
  return {
    id,
    kind: 'DIRECT',
    title: null,
    members: [member(ME, 'Tôi', 'me')],
    my_role: 'MEMBER',
    my_state: 'ACTIVE',
    last_seq: 3,
    last_message_at: new Date().toISOString(),
    unread_count: 0,
    muted_until: null,
    created_at: '2026-10-01T00:00:00Z',
    ...extra,
  } as unknown as Conversation;
}

function item(
  seq: number,
  sender: string,
  status: DecryptedMessageItem['status'],
  plaintext: string | null = null,
) {
  return {
    message: {
      id: `m${seq}`,
      seq,
      sender_id: sender,
      created_at: new Date().toISOString(),
      system: null,
    },
    plaintext,
    status,
  } as unknown as DecryptedMessageItem;
}

describe('B3 list helpers', () => {
  it('formats list times like a messenger', () => {
    const now = new Date(2026, 9, 31, 15, 0); // Saturday 31/10/2026
    expect(formatListTime(new Date(2026, 9, 31, 9, 5).toISOString(), now)).toBe('09:05');
    expect(formatListTime(new Date(2026, 9, 30, 23, 0).toISOString(), now)).toBe('Hôm qua');
    expect(formatListTime(new Date(2026, 9, 27, 8, 0).toISOString(), now)).toBe('T3');
    expect(formatListTime(new Date(2026, 9, 2, 8, 0).toISOString(), now)).toBe('02/10');
    expect(formatListTime(new Date(2025, 0, 9, 8, 0).toISOString(), now)).toBe('09/01/25');
    expect(formatListTime('not a date', now)).toBe('');
  });

  it('folds Vietnamese text for search', () => {
    expect(foldText('Nguyễn Văn Đức')).toBe('nguyen van duc');
    expect(foldText('Tuấn Anh')).toContain('tuan');
  });

  it('describes every kind of last message without leaking anything new', () => {
    expect(previewOf(item(1, LAN, 'DECRYPTED', '  Xin\nchào   bạn ')).text).toBe('Xin chào bạn');
    expect(previewOf(item(1, LAN, 'DECRYPTED', 'x'.repeat(300))).text).toHaveLength(120);
    const photos = {
      ...item(1, LAN, 'DECRYPTED', ''),
      attachments: [{ mime: 'image/webp' }, { mime: 'image/png' }],
    };
    expect(previewOf(photos as DecryptedMessageItem).text).toBe('Đã gửi 2 ảnh');
    const files = { ...item(1, LAN, 'DECRYPTED', ''), attachments: [{ mime: 'application/pdf' }] };
    expect(previewOf(files as DecryptedMessageItem).text).toBe('Đã gửi 1 tệp');
    expect(previewOf(item(1, LAN, 'WAITING_FOR_KEY'))).toEqual({
      text: 'Tin nhắn mã hoá · đang chờ khoá',
      waiting: true,
    });
    expect(previewOf(item(1, LAN, 'DELETED')).text).toBe('Tin nhắn đã bị xoá');
    const hangup = {
      ...item(1, LAN, 'CALL'),
      callEvent: {
        type: 'm.call.hangup',
        v: 1,
        call_id: 'c',
        reason: 'user_hangup',
        duration_ms: 180_000,
      },
    };
    expect(previewOf(hangup as DecryptedMessageItem).text).toBe('Cuộc gọi · 3 phút');
  });
});

describe('B3 conversation list', () => {
  beforeEach(() => {
    clearConversationPreviews();
    fetchMessages.mockReset();
  });

  const direct = conv('c-direct', {
    members: [member(ME, 'Tôi', 'me'), member(TUAN, 'Tuấn Anh', 'tuan_anh')],
    unread_count: 2,
    last_seq: 7,
  });
  const group = conv('c-group', {
    kind: 'GROUP',
    title: 'Nhóm Hà Nội',
    members: [
      member(ME, 'Tôi', 'me'),
      member(LAN, 'Lan', 'lan'),
      member(TUAN, 'Tuấn Anh', 'tuan_anh'),
    ],
    last_seq: 4,
  });
  const waiting = conv('c-wait', {
    members: [member(ME, 'Tôi', 'me'), member(LAN, 'Lan', 'lan')],
    last_seq: 2,
  });

  function serve() {
    fetchMessages.mockImplementation(async (id: string) => {
      if (id === 'c-direct')
        return { items: [item(7, ME, 'DECRYPTED', 'Hẹn mai nhé')], has_more: true };
      if (id === 'c-group')
        return { items: [item(4, LAN, 'DECRYPTED', 'Ai đi cà phê?')], has_more: true };
      return { items: [item(2, LAN, 'WAITING_FOR_KEY')], has_more: false };
    });
  }

  const renderList = (props: Partial<React.ComponentProps<typeof ConversationList>> = {}) =>
    render(
      <ConversationList
        conversations={[direct, group, waiting]}
        activeConversationId={null}
        activeTab="ACTIVE"
        onTabChange={() => {}}
        onSelectConversation={() => {}}
        onOpenNewChat={() => {}}
        currentUserId={ME}
        requestsCount={3}
        {...props}
      />,
    );

  it('shows the decrypted last message, "Bạn:" for mine and the sender in groups, and a waiting line', async () => {
    serve();
    renderList();
    expect(await screen.findByText('Bạn: Hẹn mai nhé')).toBeTruthy();
    expect(await screen.findByText('Lan: Ai đi cà phê?')).toBeTruthy();
    expect(await screen.findByText('Tin nhắn mã hoá · đang chờ khoá')).toBeTruthy();
    // Only the newest message of each conversation is fetched.
    for (const call of fetchMessages.mock.calls) expect(call[1]).toEqual({ limit: 1 });
  });

  it('shows an unread pill and the requests count', async () => {
    serve();
    renderList();
    expect(screen.getByLabelText('2 tin chưa đọc')).toBeTruthy();
    expect(screen.getByLabelText('3 lời mời')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Hộp thư/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('searches by name or member without diacritics, and says when nothing matches', async () => {
    serve();
    renderList();
    const search = screen.getByRole('searchbox', { name: 'Tìm cuộc trò chuyện' });
    fireEvent.change(search, { target: { value: 'tuan' } });
    const rows = screen
      .getAllByRole('button')
      .filter((b) => within(b).queryByTestId('conversation-preview'));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Tuấn Anh'),
      expect.stringContaining('Nhóm Hà Nội'),
    ]);
    fireEvent.change(search, { target: { value: 'ha noi' } });
    expect(screen.getByText('Nhóm Hà Nội')).toBeTruthy();
    expect(screen.queryByText('Tuấn Anh')).toBeNull();
    fireEvent.change(search, { target: { value: 'không có ai' } });
    expect(screen.getByText('Không tìm thấy cuộc trò chuyện nào cho “không có ai”.')).toBeTruthy();
  });

  it('reuses previews until last_seq changes, and retries waiting ones when the version bumps', async () => {
    serve();
    const { rerender } = renderList();
    await screen.findByText('Tin nhắn mã hoá · đang chờ khoá');
    const calls = fetchMessages.mock.calls.length;
    const props = {
      activeConversationId: null,
      activeTab: 'ACTIVE' as const,
      onTabChange: () => {},
      onSelectConversation: () => {},
      onOpenNewChat: () => {},
      currentUserId: ME,
    };
    rerender(<ConversationList {...props} conversations={[direct, group, waiting]} version={0} />);
    expect(fetchMessages.mock.calls.length).toBe(calls);

    fetchMessages.mockImplementation(async (id: string) =>
      id === 'c-wait'
        ? { items: [item(2, LAN, 'DECRYPTED', 'Khoá tới rồi')], has_more: false }
        : { items: [], has_more: false },
    );
    rerender(<ConversationList {...props} conversations={[direct, group, waiting]} version={1} />);
    expect(await screen.findByText('Khoá tới rồi')).toBeTruthy();
    expect(fetchMessages.mock.calls.slice(calls).map((c) => c[0])).toEqual(['c-wait']);
  });
});

describe('B3 previews are per user (architect review of #563)', () => {
  const OTHER = 'user-other';
  const shared = conv('c-shared', {
    members: [
      member(ME, 'Tôi', 'me'),
      member(OTHER, 'Người khác', 'other'),
      member(LAN, 'Lan', 'lan'),
    ],
    last_seq: 5,
  });
  const list = (userId: string) => (
    <ConversationList
      conversations={[shared]}
      activeConversationId={null}
      activeTab="ACTIVE"
      onTabChange={() => {}}
      onSelectConversation={() => {}}
      onOpenNewChat={() => {}}
      currentUserId={userId}
    />
  );

  beforeEach(() => {
    clearConversationPreviews();
    fetchMessages.mockReset();
  });

  it("user B never sees user A's cached preview; B's own decryption fills it in", async () => {
    fetchMessages.mockResolvedValueOnce({
      items: [item(5, LAN, 'DECRYPTED', 'Bí mật của A')],
      has_more: false,
    });
    const a = render(list(ME));
    expect(await screen.findByText('Bí mật của A')).toBeTruthy();
    a.unmount();

    // B signs in later in the same tab, same conversation: B's decryption has not finished yet.
    let finishB!: (v: unknown) => void;
    fetchMessages.mockReturnValueOnce(new Promise((r) => (finishB = r)));
    render(list(OTHER));
    expect(screen.queryByText(/Bí mật của A/)).toBeNull();
    expect(screen.getByTestId('conversation-preview').textContent).toBe('Tin nhắn mã hoá đầu cuối');
    expect(fetchMessages).toHaveBeenCalledTimes(2);

    // Only what B itself decrypts is shown (here: B has no key yet).
    finishB({ items: [item(5, LAN, 'WAITING_FOR_KEY')], has_more: false });
    expect(await screen.findByText('Tin nhắn mã hoá · đang chờ khoá')).toBeTruthy();
    expect(screen.queryByText(/Bí mật của A/)).toBeNull();
  });

  it('clearConversationPreviews (logout, device removal) forgets every preview', async () => {
    fetchMessages.mockResolvedValue({
      items: [item(5, LAN, 'DECRYPTED', 'Xin chào')],
      has_more: false,
    });
    const first = render(list(ME));
    await screen.findByText('Xin chào');
    first.unmount();
    clearConversationPreviews();
    render(list(ME));
    expect(screen.queryByText('Xin chào')).toBeNull();
    expect(await screen.findByText('Xin chào')).toBeTruthy();
    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });
});

describe('B3 previews wait for the E2EE device (#563 sim runs)', () => {
  beforeEach(() => {
    clearConversationPreviews();
    fetchMessages.mockReset();
  });

  it('does not decrypt anything until the page says the device is ready', async () => {
    fetchMessages.mockResolvedValue({
      items: [item(3, LAN, 'DECRYPTED', 'Sau khi sẵn sàng')],
      has_more: false,
    });
    const c = conv('c-ready', { members: [member(ME, 'Tôi', 'me'), member(LAN, 'Lan', 'lan')] });
    const props = {
      conversations: [c],
      activeConversationId: null,
      activeTab: 'ACTIVE' as const,
      onTabChange: () => {},
      onSelectConversation: () => {},
      onOpenNewChat: () => {},
      currentUserId: ME,
    };
    const { rerender } = render(<ConversationList {...props} previewsEnabled={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMessages).not.toHaveBeenCalled();
    rerender(<ConversationList {...props} previewsEnabled />);
    expect(await screen.findByText('Sau khi sẵn sàng')).toBeTruthy();
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });
});
