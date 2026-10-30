'use client';

import React, { useState } from 'react';
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
import { api } from '../../lib/api-client';
import type { Conversation } from '@winkey/api-client';

interface GroupSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: Conversation;
  currentUserId: string;
  onUpdated: (conversation: Conversation) => void;
  onLeft: () => void;
}

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
  const [newMemberIds, setNewMemberIds] = useState('');
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const chatService = getChatService();
  const isOwner = conversation.my_role === 'OWNER';
  const isAdmin = conversation.my_role === 'ADMIN' || isOwner;

  const handleUpdateTitle = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const updated = await chatService.updateGroupTitle(conversation.id, trimmed);
      onUpdated(updated);
      setIsEditingTitle(false);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể cập nhật tên nhóm.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddMembers = async () => {
    const ids = newMemberIds
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return;

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const updated = await chatService.addMembers(conversation.id, ids);
      onUpdated(updated);
      setNewMemberIds('');
      setShowAddMembers(false);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể thêm thành viên.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveMember = async (userId: string, isSelf = false) => {
    const confirmMsg = isSelf
      ? 'Bạn có chắc chắn muốn rời nhóm này?'
      : 'Bạn có chắc chắn muốn xoá thành viên này khỏi nhóm?';
    if (!window.confirm(confirmMsg)) return;

    setIsLoading(true);
    setErrorMessage(null);
    try {
      await chatService.leaveOrRemoveMember(conversation.id, userId);
      if (isSelf) {
        onLeft();
        onClose();
      } else {
        const updated = await chatService.getConversation(conversation.id);
        onUpdated(updated);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể thực hiện thao tác.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: 'ADMIN' | 'MEMBER') => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { data, error } = await api.chat.PATCH(
        '/v1/chat/conversations/{conversation_id}/members/{user_id}',
        {
          params: {
            path: {
              conversation_id: conversation.id,
              user_id: userId,
            },
          },
          body: { role: newRole },
        },
      );
      if (error || !data) {
        throw new Error(error?.detail || 'Không thể thay đổi vai trò.');
      }
      onUpdated(data);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể thay đổi vai trò.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleMute = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    const isCurrentlyMuted =
      conversation.muted_until && new Date(conversation.muted_until).getTime() > Date.now();

    try {
      const nextMutedUntil = isCurrentlyMuted
        ? null
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await api.chat.PATCH(
        '/v1/chat/conversations/{conversation_id}/members/{user_id}',
        {
          params: {
            path: {
              conversation_id: conversation.id,
              user_id: currentUserId,
            },
          },
          body: { muted_until: nextMutedUntil },
        },
      );
      if (error || !data) {
        throw new Error(error?.detail || 'Không thể cập nhật thông báo.');
      }
      onUpdated(data);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể cập nhật thông báo.');
    } finally {
      setIsLoading(false);
    }
  };

  const isMuted =
    conversation.muted_until && new Date(conversation.muted_until).getTime() > Date.now();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-[#181818] border border-zinc-200 dark:border-[#272727] p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-100 dark:border-[#242424]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                Cài đặt cuộc trò chuyện
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {conversation.kind === 'GROUP'
                  ? `Nhóm • ${conversation.members.length} thành viên`
                  : 'Trò chuyện trực tiếp'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500 leading-relaxed">
            {errorMessage}
          </div>
        )}

        {/* Group Title Section */}
        {conversation.kind === 'GROUP' && (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Tên nhóm
            </label>
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  maxLength={80}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-zinc-50 dark:bg-[#121212] text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                />
                <button
                  type="button"
                  onClick={handleUpdateTitle}
                  disabled={isLoading}
                  className="p-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingTitle(false)}
                  className="p-2 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-300 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727]">
                <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                  {conversation.title || 'Nhóm không tên'}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setIsEditingTitle(true)}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
                    title="Đổi tên nhóm"
                  >
                    <Edit3 className="h-4 w-4" />
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
        {conversation.kind === 'GROUP' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Thành viên ({conversation.members.length}/50)
              </span>
              {isAdmin && !showAddMembers && (
                <button
                  type="button"
                  onClick={() => setShowAddMembers(true)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-400 transition-colors"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  <span>Thêm thành viên</span>
                </button>
              )}
            </div>

            {/* Add member form */}
            {showAddMembers && (
              <div className="p-3 rounded-xl bg-zinc-50 dark:bg-[#121212] border border-zinc-200 dark:border-[#272727] space-y-2">
                <input
                  type="text"
                  placeholder="Nhập ID thành viên..."
                  value={newMemberIds}
                  onChange={(e) => setNewMemberIds(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2c2c2c] bg-white dark:bg-[#181818] text-xs text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-red-500"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddMembers(false)}
                    className="px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    Huỷ
                  </button>
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={handleAddMembers}
                    className="px-3 py-1 text-xs font-semibold bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                  >
                    Thêm
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-zinc-100 dark:divide-[#222222] border border-zinc-200 dark:border-[#272727] rounded-xl overflow-hidden">
              {conversation.members.map((member) => {
                const isSelf = member.user_id === currentUserId;
                const canRemove = !isSelf && (isOwner || (isAdmin && member.role === 'MEMBER'));

                return (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between p-3 bg-white dark:bg-[#181818]"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-8 w-8 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center font-bold text-xs text-zinc-700 dark:text-zinc-300 shrink-0">
                        {member.user?.display_name?.slice(0, 1) || 'U'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                            {member.user?.display_name || member.user_id.slice(0, 8)}
                          </span>
                          {isSelf && <span className="text-[10px] text-zinc-400">(Bạn)</span>}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                          {member.role === 'OWNER' ? (
                            <span className="inline-flex items-center gap-0.5 text-amber-500 font-medium">
                              <ShieldCheck className="h-3 w-3" /> Trưởng nhóm
                            </span>
                          ) : member.role === 'ADMIN' ? (
                            <span className="inline-flex items-center gap-0.5 text-blue-500 font-medium">
                              <Shield className="h-3 w-3" /> Quản trị viên
                            </span>
                          ) : (
                            <span>Thành viên</span>
                          )}
                          {member.state === 'REQUESTED' && (
                            <span className="text-amber-500 font-medium">• Chờ duyệt</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isOwner && !isSelf && (
                        <button
                          type="button"
                          onClick={() =>
                            handleRoleChange(
                              member.user_id,
                              member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                            )
                          }
                          className="px-2 py-1 text-[11px] rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          {member.role === 'ADMIN' ? 'Hạ quyền' : 'Thăng QTV'}
                        </button>
                      )}

                      {canRemove && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(member.user_id, false)}
                          className="p-1 rounded text-red-500 hover:bg-red-500/10 transition-colors"
                          title="Xoá khỏi nhóm"
                        >
                          <UserX className="h-4 w-4" />
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
            onClick={() => handleRemoveMember(currentUserId, true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-red-500/20 text-xs font-semibold text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            <span>{conversation.kind === 'GROUP' ? 'Rời khỏi nhóm' : 'Rời cuộc trò chuyện'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
