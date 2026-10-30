'use client';

import React, { useState } from 'react';
import { X, UserPlus, Users, MessageSquarePlus } from 'lucide-react';
import { getChatService } from '../../lib/e2ee/chat-service';
import type { Conversation } from '@winkey/api-client';
import { UserPicker, type PickedUser } from '../social/user-picker';

interface NewChatDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}

export function NewChatDialog({ isOpen, onClose, onCreated }: NewChatDialogProps) {
  const [mode, setMode] = useState<'DIRECT' | 'GROUP'>('DIRECT');
  const [directUser, setDirectUser] = useState<PickedUser[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupUsers, setGroupUsers] = useState<PickedUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);

    const chatService = getChatService();

    try {
      if (mode === 'DIRECT') {
        const target = directUser[0];
        if (!target) {
          setErrorMessage('Vui lòng chọn người bạn muốn nhắn tin.');
          setIsLoading(false);
          return;
        }

        const conv = await chatService.createConversation({
          kind: 'DIRECT',
          userIds: [target.id],
        });
        onCreated(conv);
        onClose();
      } else {
        const titleTrimmed = groupTitle.trim();
        if (!titleTrimmed) {
          setErrorMessage('Vui lòng nhập tên nhóm (tối đa 80 ký tự).');
          setIsLoading(false);
          return;
        }

        const ids = groupUsers.map((u) => u.id);

        if (ids.length === 0) {
          setErrorMessage('Vui lòng chọn ít nhất 1 thành viên cho nhóm.');
          setIsLoading(false);
          return;
        }

        if (ids.length > 49) {
          setErrorMessage('Một nhóm chỉ được chứa tối đa 49 thành viên khác.');
          setIsLoading(false);
          return;
        }

        const conv = await chatService.createConversation({
          kind: 'GROUP',
          title: titleTrimmed,
          userIds: ids,
        });
        onCreated(conv);
        onClose();
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể tạo cuộc trò chuyện.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) onClose();
        }}
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-[#181818] border border-zinc-200 dark:border-[#272727] p-6 shadow-2xl space-y-5"
      >
        <div className="flex items-center justify-between pb-3 border-b border-zinc-100 dark:border-[#242424]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-red-500/10 text-red-500 border border-red-500/20">
              <MessageSquarePlus className="h-5 w-5" />
            </div>
            <div>
              <h3
                id="new-chat-title"
                className="text-base font-semibold text-zinc-900 dark:text-white"
              >
                Bắt đầu trò chuyện mới
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Tin nhắn được mã hoá đầu cuối (E2EE)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex rounded-xl bg-zinc-100 dark:bg-[#121212] p-1 border border-zinc-200 dark:border-[#272727]">
          <button
            type="button"
            onClick={() => {
              setMode('DIRECT');
              setErrorMessage(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-lg transition-colors ${
              mode === 'DIRECT'
                ? 'bg-white dark:bg-[#202020] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <UserPlus className="h-4 w-4" />
            <span>Trực tiếp (1 - 1)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('GROUP');
              setErrorMessage(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-lg transition-colors ${
              mode === 'GROUP'
                ? 'bg-white dark:bg-[#202020] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Tạo nhóm</span>
          </button>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500 leading-relaxed">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'DIRECT' ? (
            <div className="space-y-1.5">
              <UserPicker
                label="Người nhận"
                max={1}
                value={directUser}
                onChange={setDirectUser}
                disabled={isLoading}
              />
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                Nếu đối phương chưa theo dõi bạn, tin nhắn sẽ hiển thị ở mục &quot;Lời mời&quot;.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="group-title"
                  className="block text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Tên nhóm
                </label>
                <input
                  id="group-title"
                  type="text"
                  maxLength={80}
                  placeholder="Ví dụ: Nhóm trao đổi công việc"
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-zinc-50 dark:bg-[#121212] text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <UserPicker
                label="Thành viên (tối đa 49)"
                max={49}
                value={groupUsers}
                onChange={setGroupUsers}
                disabled={isLoading}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Huỷ
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {isLoading && (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              <span>Tạo trò chuyện</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
