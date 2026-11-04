import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { Conversation } from '@winkey/api-client';
import type { DecryptedMessageItem } from '../src/lib/e2ee/chat-service';
import {
  applyReadHint,
  buildTimeline,
  formatDayLabel,
  mergeMessages,
  readReceipt,
} from '../src/lib/chat/timeline';

// One service object, like the real singleton.
const service = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(),
  markRead: vi.fn(),
  decryptMessageItem: vi.fn(),
  deleteMessage: vi.fn(),
  acceptConversation: vi.fn(),
  leaveOrRemoveMember: vi.fn(),
  getDeviceId: () => 'dev-me',
}));
const { fetchMessages, sendMessage, markRead, decryptMessageItem } = service;
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => service }));
vi.mock('../src/lib/api-client', () => ({
  api: { chat: { POST: vi.fn().mockResolvedValue({ data: { users: [] } }) } },
}));

import { ConversationView } from '../src/components/chat/conversation-view';

const ME = 'user-me';
const LAN = 'user-lan';
const TUAN = 'user-tuan';

const member = (user_id: string, name: string, last_read_seq: number | null = 0) => ({
  user_id,
  role: 'MEMBER' as const,
  state: 'ACTIVE' as const,
  last_read_seq,
  user: { id: user_id, handle: name.toLowerCase(), display_name: name, avatar_url: null },
});

function conversation(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    kind: 'DIRECT',
    title: null,
    members: [member(ME, 'Tôi'), member(LAN, 'Lan')],
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

function msg(
  seq: number,
  sender: string,
  text: string,
  createdAt: string,
  status: DecryptedMessageItem['status'] = 'DECRYPTED',
) {
  return {
    message: {
      id: `m${seq}`,
      seq,
      sender_id: sender,
      created_at: createdAt,
      system: null,
      kind: 'ENCRYPTED',
    },
    plaintext: status === 'DECRYPTED' ? text : null,
    status,
  } as unknown as DecryptedMessageItem;
}

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).toISOString();

// jsdom has no layout: give the scroll area a size so "at the bottom" and "near the top" mean something.
function sizeScroller(
  el: HTMLElement,
  opts: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  let top = opts.scrollTop;
  let height = opts.scrollHeight;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => opts.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return {
    setHeight: (h: number) => {
      height = h;
    },
    get top() {
      return top;
    },
  };
}

describe('B3 timeline helpers', () => {
  it('labels days like a messenger', () => {
    const now = new Date(2026, 10, 3, 15, 0); // Tuesday 03/11/2026
    expect(formatDayLabel(at(3, 9), now)).toBe('Hôm nay');
    expect(formatDayLabel(at(2, 23), now)).toBe('Hôm qua');
    expect(formatDayLabel(at(1, 8), now)).toBe('Chủ nhật, 01/11');
    expect(formatDayLabel(new Date(2025, 0, 9).toISOString(), now)).toBe('09/01/2025');
  });

  it('puts a separator on each new day and a sender header on each run in groups', () => {
    const group = conversation({
      kind: 'GROUP',
      members: [member(ME, 'Tôi'), member(LAN, 'Lan'), member(TUAN, 'Tuấn')],
    });
    const rows = buildTimeline({
      items: [
        msg(1, LAN, 'a', at(2, 9)),
        msg(2, LAN, 'b', at(2, 9, 1)),
        msg(3, TUAN, 'c', at(2, 9, 2)),
        msg(4, LAN, 'd', at(3, 8)),
        msg(5, ME, 'e', at(3, 8, 1)),
        msg(6, ME, 'f', at(3, 8, 20)),
        msg(7, 'gone', 'g', at(3, 9)),
      ],
      outgoing: [],
      conversation: group,
      currentUserId: ME,
      now: new Date(2026, 10, 3, 12),
    });
    const shape = rows.map((r) =>
      r.kind === 'day'
        ? `#${r.label}`
        : r.kind === 'message'
          ? `${r.item.plaintext}${r.showSender ? '*' : ''}`
          : 'out',
    );
    expect(shape).toEqual(['#Hôm qua', 'a*', 'b', 'c*', '#Hôm nay', 'd*', 'e', 'f', 'g*']);
    const left = rows.find((r) => r.kind === 'message' && r.item.plaintext === 'g');
    expect(left && left.kind === 'message' && left.sender).toBeNull();
  });

  it('never shows sender headers in a DIRECT chat', () => {
    const rows = buildTimeline({
      items: [msg(1, LAN, 'a', at(3, 9))],
      outgoing: [],
      conversation: conversation(),
      currentUserId: ME,
    });
    expect(rows.some((r) => r.kind === 'message' && r.showSender)).toBe(false);
  });

  it('merges pages by seq, keeps tombstones and a decrypted copy over a waiting one', () => {
    const loaded = [msg(2, LAN, 'two', at(3, 9)), msg(3, LAN, 'three', at(3, 9))];
    const merged = mergeMessages(loaded, [
      msg(1, LAN, 'one', at(3, 8)),
      msg(2, LAN, '', at(3, 9), 'DELETED'),
      msg(3, LAN, '', at(3, 9), 'WAITING_FOR_KEY'),
    ]);
    expect(merged.map((i) => [i.message.seq, i.status])).toEqual([
      [1, 'DECRYPTED'],
      [2, 'DELETED'],
      [3, 'DECRYPTED'],
    ]);
  });

  it('reports "đã xem" from last_read_seq, never for a message request', () => {
    const items = [
      msg(1, ME, 'hi', at(3, 9)),
      msg(2, LAN, 'yo', at(3, 9)),
      msg(3, ME, 'ok', at(3, 9)),
    ];
    expect(readReceipt({ items, conversation: conversation(), currentUserId: ME })).toMatchObject({
      seq: 3,
      label: 'Đã gửi',
    });
    const read = conversation({ members: [member(ME, 'Tôi'), member(LAN, 'Lan', 3)] });
    expect(readReceipt({ items, conversation: read, currentUserId: ME })).toMatchObject({
      seq: 3,
      label: 'Đã xem',
    });
    const requested = conversation({
      members: [member(ME, 'Tôi'), { ...member(LAN, 'Lan', null), state: 'REQUESTED' as const }],
    });
    expect(readReceipt({ items, conversation: requested, currentUserId: ME })).toMatchObject({
      label: 'Đã gửi',
    });
  });

  it('names group readers', () => {
    const items = [msg(5, ME, 'hi', at(3, 9))];
    const members = [
      member(ME, 'Tôi'),
      member(LAN, 'Lan', 5),
      member(TUAN, 'Tuấn', 2),
      member('u3', 'Minh', 7),
    ];
    const group = conversation({ kind: 'GROUP', members });
    expect(readReceipt({ items, conversation: group, currentUserId: ME })?.label).toBe(
      'Lan, Minh đã xem',
    );
    const all = conversation({
      kind: 'GROUP',
      members: members.map((m) => ({ ...m, last_read_seq: 9 })),
    });
    expect(readReceipt({ items, conversation: all, currentUserId: ME })?.label).toBe(
      'Mọi người đã xem',
    );
  });

  it('applies a READ hint only forward and only to its conversation', () => {
    const c = conversation();
    const moved = applyReadHint(c, { conversation_id: 'conv-1', user_id: LAN, seq: 7 });
    expect(moved.members.find((m) => m.user_id === LAN)?.last_read_seq).toBe(7);
    expect(applyReadHint(moved, { conversation_id: 'conv-1', user_id: LAN, seq: 3 })).toBe(moved);
    expect(applyReadHint(c, { conversation_id: 'other', user_id: LAN, seq: 9 })).toBe(c);
  });
});

describe('B3 conversation view', () => {
  beforeEach(() => {
    fetchMessages.mockReset();
    sendMessage.mockReset();
    markRead.mockReset().mockResolvedValue(undefined);
    decryptMessageItem.mockReset();
  });

  const renderView = (conv = conversation(), version = 0) =>
    render(
      <ConversationView
        conversation={conv}
        currentUserId={ME}
        realtimeVersion={version}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

  it('shows day separators, group senders and "đã xem"', async () => {
    fetchMessages.mockResolvedValue({
      items: [
        msg(1, LAN, 'Chào cả nhóm', at(2, 9)),
        msg(2, TUAN, 'Chào Lan', at(3, 8)),
        msg(3, ME, 'Hi', at(3, 8, 5)),
      ],
      has_more: false,
    });
    const group = conversation({
      kind: 'GROUP',
      title: 'Nhóm học',
      members: [member(ME, 'Tôi'), member(LAN, 'Lan', 3), member(TUAN, 'Tuấn', 3)],
    });
    renderView(group);
    await screen.findByText('Chào cả nhóm');
    const separators = screen.getAllByRole('separator').map((s) => s.getAttribute('aria-label'));
    expect(separators).toHaveLength(2);
    expect(screen.getByText('Lan')).toBeTruthy();
    expect(screen.getByText('Tuấn')).toBeTruthy();
    expect(screen.getByTestId('read-receipt').textContent).toContain('Mọi người đã xem');
    expect(markRead).toHaveBeenCalledWith('conv-1', 3);
  });

  it('shows a message as sending at once, then as sent', async () => {
    fetchMessages.mockResolvedValue({ items: [], has_more: false });
    let resolveSend!: (v: DecryptedMessageItem) => void;
    sendMessage.mockImplementation(() => new Promise((r) => (resolveSend = r)));
    renderView();
    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Xin chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByText('Đang gửi…')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');

    await act(async () => resolveSend(msg(4, ME, 'Xin chào', new Date().toISOString())));
    await waitFor(() => expect(screen.queryByText('Đang gửi…')).toBeNull());
    expect(screen.getByText('Xin chào')).toBeTruthy();
    expect(screen.getByTestId('read-receipt').textContent).toContain('Đã gửi');
  });

  it('marks a failed send and retries it with the same client_msg_id', async () => {
    fetchMessages.mockResolvedValue({ items: [], has_more: false });
    sendMessage.mockRejectedValueOnce(new Error('Mất kết nối'));
    renderView();
    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Lần một' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Không gửi được: Mất kết nối');
    const firstId = sendMessage.mock.calls[0]![0].clientMsgId;

    sendMessage.mockResolvedValueOnce(msg(4, ME, 'Lần một', new Date().toISOString()));
    fireEvent.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(screen.queryByTestId('outgoing-message')).toBeNull());
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![0].clientMsgId).toBe(firstId);
    expect(screen.getByText('Lần một')).toBeTruthy();
  });

  it('loads older messages when scrolled to the top and keeps the reading position', async () => {
    const newest = Array.from({ length: 50 }, (_, i) =>
      msg(51 + i, LAN, `m${51 + i}`, at(3, 9, i)),
    );
    fetchMessages.mockResolvedValueOnce({ items: newest, has_more: true });
    renderView(conversation({ last_seq: 100 }));
    await screen.findByText('m100');

    const scroller = screen.getByTestId('message-scroll');
    const size = sizeScroller(scroller, { scrollHeight: 0, clientHeight: 500, scrollTop: 40 });
    // Like a browser: the height follows what is rendered (60 px per row).
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scroller.querySelectorAll('.whitespace-pre-wrap').length * 60,
    });
    const before = scroller.scrollHeight;
    const older = Array.from({ length: 50 }, (_, i) => msg(1 + i, LAN, `m${1 + i}`, at(3, 8, i)));
    fetchMessages.mockResolvedValueOnce({ items: older, has_more: false });
    fireEvent.scroll(scroller);

    await screen.findByText('m1');
    expect(fetchMessages).toHaveBeenLastCalledWith('conv-1', { before_seq: 51, limit: 50 });
    // The 50 prepended rows (3000 px) are above the reader, who still sees what they saw.
    expect(before).toBe(3000);
    expect(size.top).toBe(3040);
    expect(screen.getByText('Bắt đầu cuộc trò chuyện')).toBeTruthy();
  });

  it('offers "Tin mới" instead of jumping when the reader is scrolled up, and marks read only at the bottom', async () => {
    fetchMessages.mockResolvedValueOnce({ items: [msg(1, LAN, 'cũ', at(3, 8))], has_more: false });
    const view = renderView();
    await screen.findByText('cũ');
    markRead.mockClear();

    const scroller = screen.getByTestId('message-scroll');
    const size = sizeScroller(scroller, { scrollHeight: 2000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(scroller);

    fetchMessages.mockResolvedValueOnce({
      items: [
        msg(1, LAN, 'cũ', at(3, 8)),
        msg(2, LAN, 'mới 1', at(3, 9)),
        msg(3, LAN, 'mới 2', at(3, 9)),
      ],
      has_more: false,
    });
    view.rerender(
      <ConversationView
        conversation={conversation()}
        currentUserId={ME}
        realtimeVersion={1}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );
    const jump = await screen.findByRole('button', { name: '2 tin mới, xuống tin mới nhất' });
    expect(size.top).toBe(600);
    expect(markRead).not.toHaveBeenCalled();

    fireEvent.click(jump);
    expect(size.top).toBe(2000);
    fireEvent.scroll(scroller);
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('conv-1', 3));
    expect(screen.queryByRole('button', { name: /tin mới/ })).toBeNull();
  });

  it('decrypts again the messages that waited for a key when a hint arrives', async () => {
    const waiting = msg(1, LAN, '', at(3, 8), 'WAITING_FOR_KEY');
    fetchMessages.mockResolvedValueOnce({ items: [waiting], has_more: false });
    const view = renderView();
    await screen.findByText('Đang chờ khoá giải mã…');

    // The newest page no longer contains seq 1 (it scrolled out of the page), so the view decrypts it itself.
    fetchMessages.mockResolvedValueOnce({ items: [], has_more: false });
    decryptMessageItem.mockResolvedValueOnce(msg(1, LAN, 'Đã có khoá', at(3, 8)));
    view.rerender(
      <ConversationView
        conversation={conversation()}
        currentUserId={ME}
        realtimeVersion={1}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );
    expect(await screen.findByText('Đã có khoá')).toBeTruthy();
  });
});
