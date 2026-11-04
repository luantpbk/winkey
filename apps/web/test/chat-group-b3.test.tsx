import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Conversation } from '@winkey/api-client';
import { systemMessageText } from '../src/lib/chat/message-text';

const service = vi.hoisted(() => ({
  updateGroupTitle: vi.fn(),
  addMembers: vi.fn(),
  updateMember: vi.fn(),
  leaveOrRemoveMember: vi.fn(),
  getConversation: vi.fn(),
}));
vi.mock('../src/lib/e2ee/chat-service', () => ({ getChatService: () => service }));

const api = vi.hoisted(() => ({ socialGet: vi.fn() }));
vi.mock('../src/lib/api-client', () => ({
  api: {
    social: { GET: api.socialGet },
    chat: { PATCH: vi.fn(), POST: vi.fn() },
  },
}));

import { GroupSettingsDialog } from '../src/components/chat/group-settings-dialog';

const ME = 'user-me';
const profile = (id: string, name: string) => ({
  id,
  handle: name.toLowerCase(),
  display_name: name,
  avatar_url: null,
});
const member = (id: string, name: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER') => ({
  user_id: id,
  role,
  state: 'ACTIVE' as const,
  last_read_seq: 0,
  user: profile(id, name),
});

function group(myRole: 'OWNER' | 'ADMIN' | 'MEMBER', extra: Partial<Conversation> = {}) {
  const owner = myRole === 'OWNER' ? member(ME, 'Tôi', 'OWNER') : member('u-owner', 'Chủ', 'OWNER');
  const me = myRole === 'OWNER' ? null : member(ME, 'Tôi', myRole);
  return {
    id: 'conv-g',
    kind: 'GROUP',
    title: 'Nhóm học',
    members: [owner, ...(me ? [me] : []), member('u-admin', 'Hà', 'ADMIN'), member('u-lan', 'Lan')],
    my_role: myRole,
    my_state: 'ACTIVE',
    last_seq: 3,
    last_message_at: null,
    unread_count: 0,
    muted_until: null,
    created_at: '2026-10-01T00:00:00Z',
    ...extra,
  } as unknown as Conversation;
}

const onUpdated = vi.fn();
const onLeft = vi.fn();
const onClose = vi.fn();

const open = (conversation: Conversation) =>
  render(
    <GroupSettingsDialog
      isOpen
      onClose={onClose}
      conversation={conversation}
      currentUserId={ME}
      onUpdated={onUpdated}
      onLeft={onLeft}
    />,
  );

describe('group settings (B3 4/6)', () => {
  beforeEach(() => {
    Object.values(service).forEach((f) => f.mockReset());
    [onUpdated, onLeft, onClose].forEach((f) => f.mockReset());
    api.socialGet.mockReset().mockResolvedValue({
      data: { items: [{ user: profile('u-lan', 'Lan') }, { user: profile('u-new', 'Minh') }] },
    });
    window.confirm = vi.fn(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is a labelled dialog that takes focus, and Escape closes it', () => {
    open(group('OWNER'));
    const dialog = screen.getByRole('dialog', { name: 'Cài đặt cuộc trò chuyện' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', () => {
    open(group('OWNER'));
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Đóng' });
    const leave = screen.getByRole('button', { name: 'Rời khỏi nhóm' });
    leave.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(leave);
  });

  it('keeps the focus in the dialog after a rename, so Escape still closes it', async () => {
    const updated = group('OWNER', { title: 'Nhóm mới' });
    service.updateGroupTitle.mockResolvedValue(updated);
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Đổi tên nhóm' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tên nhóm' }), {
      target: { value: 'Nhóm mới' },
    });
    screen.getByRole('button', { name: 'Lưu tên nhóm' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu tên nhóm' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Tên nhóm' })).toBeNull());
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape in the open picker closes the list first, not the dialog', async () => {
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm thành viên' }));
    const picker = await screen.findByRole('combobox');
    fireEvent.focus(picker);
    await screen.findByRole('listbox');
    fireEvent.keyDown(picker, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(picker, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('has no UUID box', async () => {
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm thành viên' }));
    await screen.findByRole('combobox');
    expect(screen.queryByPlaceholderText(/ID/)).toBeNull();
  });

  it('a MEMBER can only leave', () => {
    open(group('MEMBER'));
    expect(screen.queryByRole('button', { name: 'Đổi tên nhóm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm thành viên' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Xoá .* khỏi nhóm/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /quản trị/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rời khỏi nhóm' })).toBeTruthy();
  });

  it('an ADMIN renames, adds and removes MEMBERs, but cannot remove admins or change roles', () => {
    open(group('ADMIN'));
    expect(screen.getByRole('button', { name: 'Đổi tên nhóm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thêm thành viên' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Xoá Lan khỏi nhóm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xoá Hà khỏi nhóm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xoá Chủ khỏi nhóm' })).toBeNull();
    expect(screen.queryByRole('button', { name: /quản trị/ })).toBeNull();
  });

  it('the OWNER changes roles and removes anyone but themselves', () => {
    open(group('OWNER'));
    expect(screen.getByRole('button', { name: 'Bỏ quyền quản trị của Hà' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Đặt Lan làm quản trị viên' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Xoá Hà khỏi nhóm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xoá Tôi khỏi nhóm' })).toBeNull();
    expect(screen.queryByRole('button', { name: /quản trị của Tôi|Đặt Tôi/ })).toBeNull();
  });

  it('renames: trims, saves, and cancel restores the current name', async () => {
    const updated = group('OWNER', { title: 'Nhóm mới' });
    service.updateGroupTitle.mockResolvedValue(updated);
    open(group('OWNER'));

    fireEvent.click(screen.getByRole('button', { name: 'Đổi tên nhóm' }));
    let input = screen.getByRole('textbox', { name: 'Tên nhóm' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'tên bỏ đi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ đổi tên' }));
    fireEvent.click(screen.getByRole('button', { name: 'Đổi tên nhóm' }));
    input = screen.getByRole('textbox', { name: 'Tên nhóm' }) as HTMLInputElement;
    expect(input.value).toBe('Nhóm học');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(
      (screen.getByRole('button', { name: 'Lưu tên nhóm' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: '  Nhóm mới  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu tên nhóm' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
    expect(service.updateGroupTitle).toHaveBeenCalledWith('conv-g', 'Nhóm mới');
  });

  it('adds with the picker: friends first, without current members', async () => {
    const updated = group('OWNER');
    service.addMembers.mockResolvedValue(updated);
    open(group('OWNER'));

    fireEvent.click(screen.getByRole('button', { name: 'Thêm thành viên' }));
    const picker = await screen.findByRole('combobox');
    fireEvent.focus(picker);
    const listbox = await screen.findByRole('listbox');
    await within(listbox).findByText('Minh');
    expect(within(listbox).queryByText('Lan')).toBeNull();

    fireEvent.mouseDown(within(listbox).getByText('Minh'));
    fireEvent.click(within(listbox).getByText('Minh'));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm vào nhóm' }));
    await waitFor(() => expect(service.addMembers).toHaveBeenCalledWith('conv-g', ['u-new']));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
  });

  it('says when the group is full instead of offering to add', () => {
    const full = group('OWNER');
    full.members = Array.from({ length: 50 }, (_, i) => member(`u${i}`, `Người ${i}`)) as never;
    open(full);
    expect(screen.queryByRole('button', { name: 'Thêm thành viên' })).toBeNull();
    expect(screen.getByText('Nhóm đã đủ 50 thành viên.')).toBeTruthy();
  });

  it('shows a server error on add and keeps the picks', async () => {
    service.addMembers.mockRejectedValue(new Error('Nhóm đã đủ 50 thành viên.'));
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm thành viên' }));
    const picker = await screen.findByRole('combobox');
    fireEvent.focus(picker);
    const listbox = await screen.findByRole('listbox');
    fireEvent.mouseDown(await within(listbox).findByText('Minh'));
    fireEvent.click(within(listbox).getByText('Minh'));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm vào nhóm' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nhóm đã đủ 50 thành viên.');
    expect(onUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Thêm vào nhóm' })).toBeTruthy();
  });

  it('changes a role through the service', async () => {
    const updated = group('OWNER');
    service.updateMember.mockResolvedValue(updated);
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Đặt Lan làm quản trị viên' }));
    await waitFor(() =>
      expect(service.updateMember).toHaveBeenCalledWith('conv-g', 'u-lan', { role: 'ADMIN' }),
    );
    expect(onUpdated).toHaveBeenCalledWith(updated);
  });

  it('removes only after a confirmation that names the person', async () => {
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Xoá Lan khỏi nhóm' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Lan'));
    expect(service.leaveOrRemoveMember).not.toHaveBeenCalled();

    const after = group('OWNER');
    service.leaveOrRemoveMember.mockResolvedValue(undefined);
    service.getConversation.mockResolvedValue(after);
    fireEvent.click(screen.getByRole('button', { name: 'Xoá Lan khỏi nhóm' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after));
    expect(service.leaveOrRemoveMember).toHaveBeenCalledWith('conv-g', 'u-lan');
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('tells an OWNER who takes over when they leave', async () => {
    service.leaveOrRemoveMember.mockResolvedValue(undefined);
    open(group('OWNER'));
    fireEvent.click(screen.getByRole('button', { name: 'Rời khỏi nhóm' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Hà'));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(service.leaveOrRemoveMember).toHaveBeenCalledWith('conv-g', ME);
  });

  it('never shows part of a user id for a member without a profile', () => {
    const conv = group('OWNER');
    conv.members = [...conv.members, { ...member('0192f5e4-gone', 'x'), user: null }] as never;
    open(conv);
    expect(screen.queryByText(/0192f5e4/)).toBeNull();
    expect(screen.getByText('Người dùng Winkey')).toBeTruthy();
  });
});

describe('system messages (B3 4/6)', () => {
  const members = [member(ME, 'Tôi'), member('u-lan', 'Lan')];

  it.each([
    [{ type: 'member_added', user_id: 'u-lan' }, 'Lan đã được thêm vào nhóm'],
    [{ type: 'member_left', user_id: 'u-lan' }, 'Lan đã rời khỏi nhóm'],
    [{ type: 'member_removed', user_id: 'u-lan' }, 'Lan đã bị xoá khỏi nhóm'],
    [{ type: 'owner_changed', user_id: 'u-lan' }, 'Lan là trưởng nhóm mới'],
    [{ type: 'member_added', user_id: ME }, 'Bạn đã được thêm vào nhóm'],
    [{ type: 'owner_changed', user_id: ME }, 'Bạn là trưởng nhóm mới'],
  ])('names the member: %j', (system, text) => {
    expect(systemMessageText(system as never, { members, currentUserId: ME })).toBe(text);
  });

  it('falls back when the member is unknown or there is no context', () => {
    const removed = { type: 'member_removed', user_id: 'gone' } as never;
    expect(systemMessageText(removed, { members, currentUserId: ME })).toBe(
      'Một thành viên đã bị xoá khỏi nhóm',
    );
    expect(systemMessageText(removed)).toBe('Một thành viên đã bị xoá khỏi nhóm');
  });
});
