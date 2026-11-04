import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Conversation } from '@winkey/api-client';
import type { DecryptedMessageItem } from '../src/lib/e2ee/chat-service';
import { parseChatEvent, serializeTextEvent } from '../src/lib/e2ee/events';
import { makeReplyRef, resolveQuote } from '../src/lib/chat/timeline';
import { EMOJIS, EmojiPicker } from '../src/components/chat/emoji-picker';

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
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => service }));
vi.mock('../src/lib/api-client', () => ({
  api: { chat: { POST: vi.fn().mockResolvedValue({ data: { users: [] } }) } },
}));

import { ConversationView } from '../src/components/chat/conversation-view';

const ME = 'user-me';
const LAN = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';

const member = (user_id: string, name: string) => ({
  user_id,
  role: 'MEMBER' as const,
  state: 'ACTIVE' as const,
  last_read_seq: 0,
  user: { id: user_id, handle: name.toLowerCase(), display_name: name, avatar_url: null },
});

const conversation = {
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
} as unknown as Conversation;

function msg(
  seq: number,
  sender: string,
  text: string,
  extra: Partial<DecryptedMessageItem> = {},
): DecryptedMessageItem {
  return {
    message: {
      id: `m${seq}`,
      seq,
      sender_id: sender,
      created_at: new Date(2026, 10, 3, 9, seq).toISOString(),
      system: null,
      kind: 'ENCRYPTED',
    },
    plaintext: text,
    status: 'DECRYPTED',
    ...extra,
  } as unknown as DecryptedMessageItem;
}

const ref = { seq: 1, sender_id: LAN, preview: 'Mai đi không?' };

describe('reply_to in the encrypted event', () => {
  it('round-trips inside the event', () => {
    const parsed = parseChatEvent(serializeTextEvent('Đi chứ', [], ref));
    expect(parsed).toEqual({ type: 'text', body: 'Đi chứ', reply_to: ref });
  });

  it('leaves events without a reply exactly as before', () => {
    expect(serializeTextEvent('hi')).toBe('{"type":"text","body":"hi"}');
    expect(parseChatEvent('{"type":"text","body":"hi"}')).toEqual({ type: 'text', body: 'hi' });
  });

  it.each([
    ['not an object', 'x'],
    ['no seq', { sender_id: LAN, preview: 'a' }],
    ['seq 0', { seq: 0, sender_id: LAN, preview: 'a' }],
    ['float seq', { seq: 1.5, sender_id: LAN, preview: 'a' }],
    ['no sender', { seq: 1, preview: 'a' }],
    ['long sender', { seq: 1, sender_id: 'x'.repeat(65), preview: 'a' }],
    ['preview not text', { seq: 1, sender_id: LAN, preview: 5 }],
    ['long preview', { seq: 1, sender_id: LAN, preview: 'x'.repeat(201) }],
  ])('keeps the message and drops a malformed reply_to: %s', (_name, reply_to) => {
    const parsed = parseChatEvent(JSON.stringify({ type: 'text', body: 'hi', reply_to }));
    expect(parsed).toEqual({ type: 'text', body: 'hi' });
  });

  it('builds the reference from a decrypted message, trimmed', () => {
    const made = makeReplyRef(msg(4, LAN, `  Xin\nchào ${'x'.repeat(300)}`));
    expect(made?.seq).toBe(4);
    expect(made?.sender_id).toBe(LAN);
    expect(made?.preview.startsWith('Xin chào')).toBe(true);
    expect(made?.preview.length).toBeLessThanOrEqual(120);
    const photo = msg(5, LAN, '', {
      attachments: [{ mime: 'image/webp' }] as DecryptedMessageItem['attachments'],
    });
    expect(makeReplyRef(photo)?.preview).toBe('Đã gửi 1 ảnh');
  });

  it('cannot reply to what has no readable content', () => {
    expect(makeReplyRef(msg(1, LAN, '', { status: 'DELETED', plaintext: null }))).toBeNull();
    expect(
      makeReplyRef(msg(1, LAN, '', { status: 'WAITING_FOR_KEY', plaintext: null })),
    ).toBeNull();
    expect(makeReplyRef(msg(1, LAN, '', { status: 'SYSTEM', plaintext: null }))).toBeNull();
  });
});

describe('resolveQuote', () => {
  const members = conversation.members;

  it('prefers the original on this device over the text the sender put in the event', () => {
    const forged = { seq: 1, sender_id: LAN, preview: 'Lan chưa từng nói câu này' };
    const quote = resolveQuote(forged, [msg(1, LAN, 'Câu thật')], members);
    expect(quote).toMatchObject({ name: 'Lan', text: 'Câu thật', state: 'loaded' });
  });

  it('does not bring a deleted message back', () => {
    const items = [msg(1, LAN, '', { status: 'DELETED', plaintext: null })];
    const quote = resolveQuote(ref, items, members);
    expect(quote.text).toBe('Tin nhắn đã bị thu hồi');
    expect(quote.text).not.toContain('Mai đi');
    expect(quote.state).toBe('deleted');
  });

  it('flags a sender that does not match the original', () => {
    const quote = resolveQuote(
      { ...ref, sender_id: 'someone-else' },
      [msg(1, LAN, 'Thật')],
      members,
    );
    expect(quote.name).toBe('Lan');
    expect(quote.text).toBe('Thật');
  });

  it('shows the text from the event when the original is not loaded', () => {
    const quote = resolveQuote(ref, [], members);
    expect(quote).toMatchObject({ name: 'Lan', text: 'Mai đi không?', state: 'unloaded' });
  });

  it('names a member who left', () => {
    expect(resolveQuote({ ...ref, sender_id: 'gone' }, [], members).name).toBe('Thành viên cũ');
  });
});

describe('EmojiPicker', () => {
  it('has a Vietnamese name for every emoji and no duplicates', () => {
    expect(new Set(EMOJIS.map((e) => e.char)).size).toBe(EMOJIS.length);
    for (const e of EMOJIS) expect(e.name.length).toBeGreaterThan(1);
  });

  it('picks with the mouse, moves with arrows and closes with Escape', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<EmojiPicker onPick={onPick} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Chọn emoji' });
    const buttons = within(dialog).getAllByRole('button');
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.keyDown(buttons[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[8]);
    fireEvent.keyDown(buttons[8]!, { key: 'End' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    fireEvent.click(buttons[2]!);
    expect(onPick).toHaveBeenCalledWith(EMOJIS[2]!.char);
    fireEvent.keyDown(buttons[2]!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('conversation view: reply and emoji', () => {
  beforeEach(() => {
    service.fetchMessages.mockReset();
    service.sendMessage.mockReset();
    service.markRead.mockReset().mockResolvedValue(undefined);
  });

  const renderView = () =>
    render(
      <ConversationView
        conversation={conversation}
        currentUserId={ME}
        onConversationUpdated={vi.fn()}
        onConversationLeft={vi.fn()}
      />,
    );

  it('replies with reply_to, keeps it on retry and clears the bar after sending', async () => {
    service.fetchMessages.mockResolvedValue({
      items: [msg(1, LAN, 'Mai đi không?')],
      has_more: false,
    });
    service.sendMessage.mockRejectedValueOnce(new Error('Mất kết nối'));
    renderView();
    await screen.findByText('Mai đi không?');

    fireEvent.click(screen.getByRole('button', { name: 'Trả lời tin nhắn của Lan' }));
    const bar = screen.getByRole('status', { name: 'Đang trả lời' });
    expect(bar.textContent).toContain('Lan');
    expect(bar.textContent).toContain('Mai đi không?');

    const box = screen.getByRole('textbox');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Đi chứ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    await screen.findByRole('button', { name: 'Thử lại' });
    expect(service.sendMessage.mock.calls[0]![0].replyTo).toEqual({
      seq: 1,
      sender_id: LAN,
      preview: 'Mai đi không?',
    });
    expect(screen.queryByRole('status', { name: 'Đang trả lời' })).toBeNull();

    service.sendMessage.mockResolvedValueOnce(
      msg(2, ME, 'Đi chứ', { replyTo: { seq: 1, sender_id: LAN, preview: 'Mai đi không?' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(screen.queryByTestId('outgoing-message')).toBeNull());
    expect(service.sendMessage.mock.calls[1]![0].replyTo?.seq).toBe(1);
    expect(screen.getByRole('button', { name: 'Xem tin nhắn được trả lời của Lan' })).toBeTruthy();
  });

  it('cancels a reply with the X and with Escape', async () => {
    service.fetchMessages.mockResolvedValue({ items: [msg(1, LAN, 'Chào')], has_more: false });
    renderView();
    await screen.findByText('Chào');

    fireEvent.click(screen.getByRole('button', { name: 'Trả lời tin nhắn của Lan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ trả lời' }));
    expect(screen.queryByRole('status', { name: 'Đang trả lời' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Trả lời tin nhắn của Lan' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('status', { name: 'Đang trả lời' })).toBeNull();
  });

  it('jumps to a loaded original and highlights it', async () => {
    service.fetchMessages.mockResolvedValue({
      items: [
        msg(1, LAN, 'Câu gốc'),
        msg(2, ME, 'Đi chứ', { replyTo: { seq: 1, sender_id: LAN, preview: 'Câu gốc' } }),
      ],
      has_more: false,
    });
    renderView();
    const quote = await screen.findByRole('button', { name: 'Xem tin nhắn được trả lời của Lan' });
    const scrolled = vi.fn();
    const row = document.querySelector('[data-seq="1"]') as HTMLElement;
    row.scrollIntoView = scrolled;
    fireEvent.click(quote);
    expect(scrolled).toHaveBeenCalled();
    expect(row.getAttribute('data-highlight')).toBe('true');
  });

  it('loads older pages to reach an original that is not loaded', async () => {
    service.fetchMessages.mockResolvedValueOnce({
      items: [msg(60, ME, 'Đi chứ', { replyTo: { seq: 5, sender_id: LAN, preview: 'Câu cũ' } })],
      has_more: true,
    });
    renderView();
    const quote = await screen.findByRole('button', { name: 'Xem tin nhắn được trả lời của Lan' });
    expect(quote.textContent).toContain('Câu cũ');

    service.fetchMessages.mockResolvedValueOnce({
      items: [msg(5, LAN, 'Câu cũ thật')],
      has_more: false,
    });
    fireEvent.click(quote);
    await screen.findAllByText('Câu cũ thật');
    expect(service.fetchMessages).toHaveBeenLastCalledWith('conv-1', { before_seq: 60, limit: 50 });
  });

  it('inserts an emoji at the cursor and returns focus to the box', async () => {
    service.fetchMessages.mockResolvedValue({ items: [], has_more: false });
    renderView();
    await waitFor(() => expect(service.fetchMessages).toHaveBeenCalled());

    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Chào bạn' } });
    box.setSelectionRange(4, 4);

    const trigger = screen.getByRole('button', { name: 'Chọn emoji' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = screen.getByRole('dialog', { name: 'Chọn emoji' });
    fireEvent.click(within(dialog).getAllByRole('button')[0]!);

    expect(box.value).toBe(`Chào${EMOJIS[0]!.char} bạn`);
    expect(screen.queryByRole('dialog', { name: 'Chọn emoji' })).toBeNull();
    expect(document.activeElement).toBe(box);
  });
});
