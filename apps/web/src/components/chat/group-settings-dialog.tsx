'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  X,
  Users,
  UserPlus,
  Shield,
  ShieldCheck,
  UserX,
  LogOut,
  BellOff,
  Bell,
  Edit3,
  Check,
} from 'lucide-react';
import { getChatService } from '../../lib/e2ee/chat-service';
import type { Conversation } from '@winkey/api-client';
import { Avatar, UserPicker, type PickedUser } from '../social/user-picker';
import { loadFriendSuggestions } from '../../lib/social/friends';

const MAX_MEMBERS = 50;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface GroupSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: Conversation;
  currentUserId: string;
  onUpdated: (conversation: Conversation) => void;
  onLeft: () => void;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function GroupSettingsDialog({
  isOpen,
  onClose,
  conversation,
  currentUserId,
  onUpdated,
  onLeft,
}: GroupSettingsDialogProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [title, setTitle] = useState(conversation.title || '');
  const [newMembers, setNewMembers] = useState<PickedUser[]>([]);
  const [friends, setFriends] = useState<PickedUser[]>([]);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const titleInputId = useId();

  // Focus moves in when it opens and back to where it was when it closes.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, [isOpen]);

  // A button that just disappeared (rename saved, picker closed) would drop focus to the page, where Escape and Tab no
  // longer reach the dialog.
  useEffect(() => {
    if (isOpen && document.activeElement === document.body) dialogRef.current?.focus();
  });

  useEffect(() => {
    if (!isOpen) {
      setIsEditingTitle(false);
      setShowAddMembers(false);
      setNewMembers([]);
      setErrorMessage(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!showAddMembers) return;
    let live = true;
    void loadFriendSuggestions().then((list) => {
      if (live) setFriends(list);
    });
    return () => {
      live = false;
    };
  }, [showAddMembers]);

  if (!isOpen) return null;

  const chatService = getChatService();
  const isGroup = conversation.kind === 'GROUP';
  const isOwner = conversation.my_role === 'OWNER';
  const isAdmin = conversation.my_role === 'ADMIN' || isOwner;
  const memberCount = conversation.members.length;
  const roomLeft = Math.max(0, MAX_MEMBERS - memberCount);
  const nameOf = (member: Conversation['members'][number]) =>
    member.user?.display_name || member.user?.handle || 'Người dùng Winkey';

  const run = async (fallback: string, action: () => Promise<void>) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await action();
    } catch (err) {
      setErrorMessage(errorText(err, fallback));
    } finally {
      setIsLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items?.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const startEditTitle = () => {
    setTitle(conversation.title || '');
    setIsEditingTitle(true);
  };

  const handleUpdateTitle = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    void run('Không thể cập nhật tên nhóm.', async () => {
      onUpdated(await chatService.updateGroupTitle(conversation.id, trimmed));
      setIsEditingTitle(false);
    });
  };

  const handleAddMembers = () => {
    if (newMembers.length === 0) return;
    void run('Không thể thêm thành viên.', async () => {
      onUpdated(
        await chatService.addMembers(
          conversation.id,
          newMembers.map((u) => u.id),
        ),
      );
      setNewMembers([]);
      setShowAddMembers(false);
    });
  };

  const handleRemoveMember = (member: Conversation['members'][number]) => {
    if (!window.confirm(`Xoá ${nameOf(member)} khỏi nhóm? Họ sẽ không đọc được tin nhắn mới.`)) {
      return;
    }
    void run('Không thể xoá thành viên.', async () => {
      await chatService.leaveOrRemoveMember(conversation.id, member.user_id);
      onUpdated(await chatService.getConversation(conversation.id));
    });
  };

  // The contract's successor when the OWNER leaves: the oldest ADMIN, else the oldest ACTIVE member.
  const successor = () => {
    const others = conversation.members.filter(
      (m) => m.user_id !== currentUserId && m.state === 'ACTIVE',
    );
    return others.find((m) => m.role === 'ADMIN') ?? others[0] ?? null;
  };

  const handleLeave = () => {
    let question = isGroup
      ? 'Bạn có chắc chắn muốn rời nhóm này?'
      : 'Bạn có chắc chắn muốn rời cuộc trò chuyện này?';
    if (isGroup && isOwner) {
      const next = successor();
      question = next
        ? `Bạn là trưởng nhóm. Nếu rời nhóm, ${nameOf(next)} sẽ trở thành trưởng nhóm. Tiếp tục?`
        : 'Bạn là thành viên cuối cùng. Rời nhóm thì nhóm sẽ không còn ai. Tiếp tục?';
    }
    if (!window.confirm(question)) return;
    void run('Không thể rời nhóm.', async () => {
      await chatService.leaveOrRemoveMember(conversation.id, currentUserId);
      onLeft();
      onClose();
    });
  };

  const handleRoleChange = (userId: string, role: 'ADMIN' | 'MEMBER') => {
    void run('Không thể thay đổi vai trò.', async () => {
      onUpdated(await chatService.updateMember(conversation.id, userId, { role }));
    });
  };

  const handleToggleMute = () => {
    const muted =
      conversation.muted_until && new Date(conversation.muted_until).getTime() > Date.now();
    const muted_until = muted ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    void run('Không thể cập nhật thông báo.', async () => {
      onUpdated(await chatService.updateMember(conversation.id, currentUserId, { muted_until }));
    });
  };

  const isMuted =
    conversation.muted_until && new Date(conversation.muted_until).getTime() > Date.now();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-[#181818] border border-zinc-200 dark:border-[#272727] p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-100 dark:border-[#242424]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
              <Users className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h3 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-white">
                Cài đặt cuộc trò chuyện
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                {isGroup ? `Nhóm • ${memberCount} thành viên` : 'Trò chuyện trực tiếp'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-700 dark:text-red-400 leading-relaxed"
          >
            {errorMessage}
          </div>
        )}

        {/* Group Title Section */}
        {isGroup && (
          <div className="space-y-2">
            <label
              htmlFor={titleInputId}
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Tên nhóm
            </label>
            {isEditingTitle ? (
              <form onSubmit={handleUpdateTitle} className="flex items-center gap-2">
                <input
                  id={titleInputId}
                  type="text"
                  autoFocus
                  maxLength={80}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="min-w-0 flex-1 px-3 py-2 rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-zinc-50 dark:bg-[#121212] text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
                <button
                  type="submit"
                  disabled={isLoading || !title.trim()}
                  aria-label="Lưu tên nhóm"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40"
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingTitle(false)}
                  aria-label="Huỷ đổi tên"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 transition-colors"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727]">
                <span
                  id={titleInputId}
                  className="min-w-0 break-words text-sm font-semibold text-zinc-900 dark:text-white"
                >
                  {conversation.title || 'Nhóm không tên'}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={startEditTitle}
                    aria-label="Đổi tên nhóm"
                    title="Đổi tên nhóm"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                  >
                    <Edit3 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Mute Notifications */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727]">
          <div className="flex items-center gap-2.5">
            {isMuted ? (
              <BellOff className="h-4 w-4 text-amber-500" />
            ) : (
              <Bell className="h-4 w-4 text-zinc-400" />
            )}
            <div>
              <div className="text-xs font-semibold text-zinc-900 dark:text-white">
                Thông báo cuộc trò chuyện
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {isMuted ? 'Đang tắt thông báo (7 ngày)' : 'Đang bật thông báo'}
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={isLoading}
            onClick={handleToggleMute}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors"
          >
            {isMuted ? 'Bật lại' : 'Tắt thông báo'}
          </button>
        </div>

        {/* Members List (for Groups) */}
        {isGroup && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Thành viên ({memberCount}/{MAX_MEMBERS})
              </span>
              {isAdmin &&
                !showAddMembers &&
                (roomLeft > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAddMembers(true)}
                    className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Thêm thành viên</span>
                  </button>
                ) : (
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    Nhóm đã đủ {MAX_MEMBERS} thành viên.
                  </span>
                ))}
            </div>

            {/* Add members */}
            {showAddMembers && (
              <div className="p-3 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727] space-y-2">
                <UserPicker
                  label={`Thêm tối đa ${roomLeft} người`}
                  max={roomLeft}
                  value={newMembers}
                  onChange={setNewMembers}
                  suggestions={friends}
                  excludeIds={conversation.members.map((m) => m.user_id)}
                  disabled={isLoading}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddMembers(false);
                      setNewMembers([]);
                    }}
                    className="min-h-11 px-3 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    Huỷ
                  </button>
                  <button
                    type="button"
                    disabled={isLoading || newMembers.length === 0}
                    onClick={handleAddMembers}
                    className="min-h-11 px-3 text-xs font-semibold bg-red-700 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-40"
                  >
                    Thêm vào nhóm
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-zinc-100 dark:divide-[#222222] border border-zinc-200 dark:border-[#272727] rounded-xl overflow-hidden">
              {conversation.members.map((member) => {
                const isSelf = member.user_id === currentUserId;
                const name = nameOf(member);
                const canRemove =
                  !isSelf && member.role !== 'OWNER'
                    ? isOwner || (isAdmin && member.role === 'MEMBER')
                    : false;
                const canChangeRole = isOwner && !isSelf && member.role !== 'OWNER';

                return (
                  <div
                    key={member.user_id}
                    className="flex flex-wrap items-center justify-between gap-2 p-3 bg-white dark:bg-[#181818]"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {member.user ? (
                        <Avatar user={member.user} size={32} />
                      ) : (
                        <div className="h-8 w-8 rounded-full bg-zinc-200 dark:bg-zinc-800 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                            {name}
                          </span>
                          {isSelf && (
                            <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
                              (Bạn)
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400">
                          {member.role === 'OWNER' ? (
                            <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400 font-medium">
                              <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Trưởng nhóm
                            </span>
                          ) : member.role === 'ADMIN' ? (
                            <span className="inline-flex items-center gap-0.5 text-blue-700 dark:text-blue-400 font-medium">
                              <Shield className="h-3 w-3" aria-hidden="true" /> Quản trị viên
                            </span>
                          ) : (
                            <span>Thành viên</span>
                          )}
                          {member.state === 'REQUESTED' && (
                            <span className="text-amber-700 dark:text-amber-400 font-medium">
                              • Chờ duyệt
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {canChangeRole && (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() =>
                            handleRoleChange(
                              member.user_id,
                              member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                            )
                          }
                          aria-label={
                            member.role === 'ADMIN'
                              ? `Bỏ quyền quản trị của ${name}`
                              : `Đặt ${name} làm quản trị viên`
                          }
                          className="min-h-11 px-2 text-[11px] font-medium rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
                        >
                          {member.role === 'ADMIN' ? 'Bỏ quản trị' : 'Đặt quản trị'}
                        </button>
                      )}

                      {canRemove && (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleRemoveMember(member)}
                          aria-label={`Xoá ${name} khỏi nhóm`}
                          title={`Xoá ${name} khỏi nhóm`}
                          className="flex h-11 w-11 items-center justify-center rounded text-red-700 hover:bg-red-500/10 dark:text-red-400 transition-colors disabled:opacity-40"
                        >
                          <UserX className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Leave Group / Delete Conversation */}
        <div className="pt-2 border-t border-zinc-100 dark:border-[#242424]">
          <button
            type="button"
            disabled={isLoading}
            onClick={handleLeave}
            className="w-full flex items-center justify-center gap-2 min-h-11 rounded-xl border border-red-500/30 text-xs font-semibold text-red-700 hover:bg-red-500/10 dark:text-red-400 transition-colors disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>{isGroup ? 'Rời khỏi nhóm' : 'Rời cuộc trò chuyện'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
