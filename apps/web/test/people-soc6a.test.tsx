import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const searchGet = vi.fn();
vi.mock('../src/lib/api-client', () => ({
  api: { social: { GET: (...args: unknown[]) => searchGet(...args) } },
}));

const createConversation = vi.fn();
vi.mock('../src/lib/e2ee/chat-service', () => ({
  getChatService: () => ({ createConversation }),
}));

import { UserPicker, type PickedUser } from '../src/components/social/user-picker';
import { findMentionToken, MentionTextarea } from '../src/components/social/mention-textarea';
import { NewChatDialog } from '../src/components/chat/new-chat-dialog';

const tuan: PickedUser = {
  id: '0192f5e4-0000-7000-8000-000000000001',
  handle: 'tuan_anh',
  display_name: 'Tuấn Anh',
  avatar_url: null,
};
const mai: PickedUser = {
  id: '0192f5e4-0000-7000-8000-000000000002',
  handle: 'mai.t',
  display_name: 'Mai Tuyết',
  avatar_url: 'https://media.winkey.vn/a.webp',
};

function page(items: PickedUser[]) {
  return { data: { items, next_cursor: null }, response: new Response(null, { status: 200 }) };
}

function Harness({ max, initial = [] }: { max: number; initial?: PickedUser[] }) {
  const [value, setValue] = useState<PickedUser[]>(initial);
  return (
    <>
      <UserPicker label="Người nhận" max={max} value={value} onChange={setValue} />
      <output data-testid="picked">{value.map((u) => u.handle).join(',')}</output>
    </>
  );
}

describe('SOC-6a: UserPicker', () => {
  beforeEach(() => {
    searchGet.mockReset();
    searchGet.mockResolvedValue(page([tuan, mai]));
  });

  it('searches once per pause (debounced) and strips a leading @', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness max={1} />);
      const input = screen.getByRole('combobox', { name: 'Người nhận' });
      fireEvent.change(input, { target: { value: '@t' } });
      fireEvent.change(input, { target: { value: '@tu' } });
      fireEvent.change(input, { target: { value: '@tua' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(searchGet).toHaveBeenCalledTimes(1);
      expect(searchGet).toHaveBeenCalledWith(
        '/v1/people/search',
        expect.objectContaining({
          params: { query: { q: 'tua', limit: 8 } },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('is keyboard operable: arrows move the active option, Enter picks it', async () => {
    render(<Harness max={49} />);
    const input = screen.getByRole('combobox', { name: 'Người nhận' });
    fireEvent.change(input, { target: { value: 'tu' } });
    await screen.findByRole('option', { name: /Mai Tuyết/ });

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('option', { name: /Tuấn Anh/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Mai Tuyết/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(input.getAttribute('aria-activedescendant')).toContain(mai.id);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('picked').textContent).toBe('mai.t');
    expect(screen.getByRole('button', { name: 'Bỏ chọn Mai Tuyết' })).toBeTruthy();
    expect(screen.getByText('Đã chọn 1/49 người.')).toBeTruthy();
  });

  it('does not offer users already picked, and Backspace on an empty input removes the last chip', async () => {
    render(<Harness max={49} initial={[tuan]} />);
    const input = screen.getByRole('combobox', { name: 'Người nhận' });
    fireEvent.change(input, { target: { value: 'tu' } });
    await screen.findByRole('option', { name: /Mai Tuyết/ });
    expect(screen.queryByRole('option', { name: /Tuấn Anh/ })).toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByTestId('picked').textContent).toBe('');
  });

  it('single mode replaces the input with the chip', async () => {
    render(<Harness max={1} />);
    const input = screen.getByRole('combobox', { name: 'Người nhận' });
    fireEvent.change(input, { target: { value: 'tuan' } });
    fireEvent.click(await screen.findByRole('option', { name: /Tuấn Anh/ }));
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ chọn Tuấn Anh' }));
    expect(screen.getByRole('combobox', { name: 'Người nhận' })).toBeTruthy();
  });

  it('says when nothing matches and when rate limited', async () => {
    searchGet.mockResolvedValueOnce(page([]));
    render(<Harness max={1} />);
    const input = screen.getByRole('combobox', { name: 'Người nhận' });
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(await screen.findByText('Không tìm thấy ai khớp với “zzz”.')).toBeTruthy();

    searchGet.mockResolvedValueOnce({
      data: undefined,
      response: new Response(null, { status: 429 }),
    });
    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(await screen.findByText(/Bạn tìm quá nhanh/)).toBeTruthy();
  });
});

describe('SOC-6a: new chat dialog', () => {
  beforeEach(() => {
    searchGet.mockReset();
    searchGet.mockResolvedValue(page([tuan, mai]));
    createConversation.mockReset();
  });

  it('has no raw user-ID field and starts a DIRECT conversation with the picked user', async () => {
    const conv = { id: 'c1', kind: 'DIRECT', my_state: 'ACTIVE' };
    createConversation.mockResolvedValue(conv);
    const onCreated = vi.fn();
    render(<NewChatDialog isOpen onClose={() => {}} onCreated={onCreated} />);

    expect(screen.getByRole('dialog', { name: 'Bắt đầu trò chuyện mới' })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/018f3a5b/)).toBeNull();
    expect(screen.queryByText(/ID hoặc mã định danh/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Tạo trò chuyện' }));
    expect(await screen.findByText('Vui lòng chọn người bạn muốn nhắn tin.')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Người nhận' }), {
      target: { value: 'tuan' },
    });
    fireEvent.click(await screen.findByRole('option', { name: /Tuấn Anh/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo trò chuyện' }));

    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({ kind: 'DIRECT', userIds: [tuan.id] }),
    );
    expect(onCreated).toHaveBeenCalledWith(conv);
  });

  it('creates a GROUP with the picked members', async () => {
    createConversation.mockResolvedValue({ id: 'g1', kind: 'GROUP', my_state: 'ACTIVE' });
    render(<NewChatDialog isOpen onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Tạo nhóm/ }));
    fireEvent.change(screen.getByLabelText('Tên nhóm'), { target: { value: 'Nhóm phim' } });
    const input = screen.getByRole('combobox', { name: 'Thành viên (tối đa 49)' });
    fireEvent.change(input, { target: { value: 'tu' } });
    fireEvent.click(await screen.findByRole('option', { name: /Tuấn Anh/ }));
    fireEvent.change(input, { target: { value: 'ma' } });
    fireEvent.click(await screen.findByRole('option', { name: /Mai Tuyết/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo trò chuyện' }));
    await waitFor(() =>
      expect(createConversation).toHaveBeenCalledWith({
        kind: 'GROUP',
        title: 'Nhóm phim',
        userIds: [tuan.id, mai.id],
      }),
    );
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(<NewChatDialog isOpen onClose={onClose} onCreated={() => {}} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Người nhận' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SOC-6a: @mention autocomplete', () => {
  beforeEach(() => {
    searchGet.mockReset();
    searchGet.mockResolvedValue(page([tuan, mai]));
  });

  it('findMentionToken finds the partial handle before the caret only', () => {
    expect(findMentionToken('Xin chào @tu', 12)).toEqual({ start: 9, query: 'tu' });
    expect(findMentionToken('@mai.t', 6)).toEqual({ start: 0, query: 'mai.t' });
    expect(findMentionToken('mail@example', 12)).toBeNull(); // e-mail, not a mention
    expect(findMentionToken('Xin chào @', 10)).toBeNull();
    expect(findMentionToken('@tu xin', 7)).toBeNull(); // caret is past the token
  });

  it('suggests people and inserts @handle with Enter', async () => {
    function Composer() {
      const [body, setBody] = useState('');
      return <MentionTextarea aria-label="Nội dung" value={body} onValueChange={setBody} />;
    }
    render(<Composer />);
    const box = screen.getByRole('textbox', { name: 'Nội dung' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Chào @tu', selectionStart: 8, selectionEnd: 8 } });
    await screen.findByRole('option', { name: /Tuấn Anh/ });
    expect(searchGet).toHaveBeenCalledWith(
      '/v1/people/search',
      expect.objectContaining({
        params: { query: { q: 'tu', limit: 6 } },
      }),
    );
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('Chào @tuan_anh ');
  });
});
