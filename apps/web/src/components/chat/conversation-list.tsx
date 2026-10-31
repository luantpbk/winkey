'use client';

import React, { useMemo, useState } from 'react';
import { Search, Plus, Users, User, BellOff, MessageSquare } from 'lucide-react';
import type { Conversation } from '@winkey/api-client';
import { useConversationPreviews } from '../../lib/chat/conversation-previews';
import { foldText, formatListTime } from '../../lib/chat/format';

interface ConversationListProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  activeTab: 'ACTIVE' | 'REQUESTED';
  onTabChange: (tab: 'ACTIVE' | 'REQUESTED') => void;
  onSelectConversation: (conversation: Conversation) => void;
  onOpenNewChat: () => void;
  currentUserId: string;
  requestsCount?: number;
  isLoading?: boolean;
  /** Bumped by the page on chat hints: previews that waited for a key are tried again. */
  version?: number;
}

function conversationTitle(c: Conversation, me: string): string {
  if (c.kind === 'GROUP') return c.title || 'Nhóm không tên';
  const peer = c.members.find((m) => m.user_id !== me);
  return peer?.user?.display_name || peer?.user?.handle || 'Người dùng Winkey';
}

function matches(c: Conversation, me: string, query: string): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  const names = [c.title ?? ''];
  for (const m of c.members) {
    if (m.user_id === me) continue;
    names.push(m.user?.display_name ?? '', m.user?.handle ?? '');
  }
  return names.some((n) => foldText(n).includes(q));
}

export function ConversationList({
  conversations,
  activeConversationId,
  activeTab,
  onTabChange,
  onSelectConversation,
  onOpenNewChat,
  currentUserId,
  requestsCount = 0,
  isLoading = false,
  version = 0,
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const previews = useConversationPreviews(conversations, currentUserId, version);

  const filtered = useMemo(
    () => conversations.filter((c) => matches(c, currentUserId, searchQuery)),
    [conversations, currentUserId, searchQuery],
  );

  const tabClass = (selected: boolean) =>
    `flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
      selected
        ? 'bg-white dark:bg-[#242424] text-zinc-900 dark:text-white shadow-sm'
        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#121212] border-r border-zinc-200 dark:border-[#272727]">
      {/* Top Header */}
      <div className="p-4 border-b border-zinc-100 dark:border-[#1f1f1f] space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-red-500" aria-hidden="true" />
            <span>Tin nhắn</span>
          </h1>
          <button
            type="button"
            onClick={onOpenNewChat}
            title="Tạo tin nhắn mới"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Tin mới</span>
          </button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Hộp thư"
          className="flex rounded-xl bg-zinc-100 dark:bg-[#181818] p-1 border border-zinc-200 dark:border-[#272727]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ACTIVE'}
            onClick={() => onTabChange('ACTIVE')}
            className={tabClass(activeTab === 'ACTIVE')}
          >
            <span>Hộp thư</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'REQUESTED'}
            onClick={() => onTabChange('REQUESTED')}
            className={tabClass(activeTab === 'REQUESTED')}
          >
            <span>Lời mời</span>
            {requestsCount > 0 && (
              <span
                aria-label={`${requestsCount} lời mời`}
                className="px-1.5 rounded-full bg-red-600 text-white text-[10px] font-bold leading-4"
              >
                {requestsCount > 99 ? '99+' : requestsCount}
              </span>
            )}
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500"
            aria-hidden="true"
          />
          <input
            type="search"
            data-embedded-field
            aria-label="Tìm cuộc trò chuyện"
            placeholder="Tìm theo tên người hoặc nhóm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-zinc-200 dark:border-[#272727] bg-zinc-50 dark:bg-[#181818] text-xs text-zinc-900 dark:text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-red-500"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y divide-zinc-100 dark:divide-[#1c1c1c]">
        {isLoading && conversations.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div
              role="status"
              aria-label="Đang tải"
              className="h-6 w-6 animate-spin rounded-full border-2 border-red-500 border-t-transparent"
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 px-4 space-y-2">
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {searchQuery.trim()
                ? `Không tìm thấy cuộc trò chuyện nào cho “${searchQuery.trim()}”.`
                : activeTab === 'ACTIVE'
                  ? 'Không có cuộc trò chuyện nào.'
                  : 'Không có lời mời nhắn tin nào.'}
            </p>
            {activeTab === 'ACTIVE' && !searchQuery.trim() && (
              <button
                type="button"
                onClick={onOpenNewChat}
                className="text-xs font-semibold text-red-600 hover:text-red-500 dark:text-red-400"
              >
                Bắt đầu trò chuyện ngay
              </button>
            )}
          </div>
        ) : (
          filtered.map((conv) => {
            const isSelected = conv.id === activeConversationId;
            const title = conversationTitle(conv, currentUserId);
            const peer =
              conv.kind === 'GROUP' ? null : conv.members.find((m) => m.user_id !== currentUserId);
            const avatarUrl = peer?.user?.avatar_url ?? null;
            const isMuted = Boolean(
              conv.muted_until && new Date(conv.muted_until).getTime() > Date.now(),
            );
            const unread = conv.unread_count;
            const preview = previews.get(conv.id);
            const sender =
              preview && !preview.fromMe && conv.kind === 'GROUP'
                ? conv.members.find((m) => m.user_id === preview.senderId)?.user?.display_name
                : null;
            const previewLine = preview
              ? `${preview.fromMe ? 'Bạn: ' : sender ? `${sender}: ` : ''}${preview.text}`
              : conv.my_state === 'REQUESTED'
                ? 'Lời mời tin nhắn'
                : conv.last_seq > 0
                  ? 'Tin nhắn mã hoá đầu cuối'
                  : conv.kind === 'GROUP'
                    ? `${conv.members.length} thành viên`
                    : 'Chưa có tin nhắn';
            const time = conv.last_message_at ? formatListTime(conv.last_message_at) : '';

            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => onSelectConversation(conv)}
                aria-current={isSelected ? 'true' : undefined}
                className={`w-full text-left p-3.5 flex items-center gap-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500 ${
                  isSelected
                    ? 'bg-zinc-100 dark:bg-[#1e1e1e]'
                    : 'hover:bg-zinc-50 dark:hover:bg-[#161616]'
                }`}
              >
                {/* Avatar */}
                <div className="shrink-0">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="h-11 w-11 rounded-full object-cover border border-zinc-200 dark:border-zinc-800"
                    />
                  ) : (
                    <div className="h-11 w-11 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300">
                      {conv.kind === 'GROUP' ? (
                        <Users className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <User className="h-5 w-5" aria-hidden="true" />
                      )}
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm truncate text-zinc-900 dark:text-white ${
                        unread > 0 ? 'font-bold' : 'font-semibold'
                      }`}
                    >
                      {title}
                    </span>
                    {time && (
                      <span
                        className={`text-[11px] shrink-0 ${
                          unread > 0
                            ? 'font-semibold text-red-600 dark:text-red-400'
                            : 'text-zinc-500 dark:text-zinc-400'
                        }`}
                      >
                        {time}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span
                      data-testid="conversation-preview"
                      className={`text-xs truncate ${
                        unread > 0
                          ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                          : preview?.waiting
                            ? 'italic text-zinc-500 dark:text-zinc-400'
                            : 'text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      {previewLine}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {isMuted && (
                        <BellOff
                          className="h-3.5 w-3.5 text-zinc-500"
                          aria-label="Đã tắt thông báo"
                        />
                      )}
                      {unread > 0 && (
                        <span
                          aria-label={`${unread} tin chưa đọc`}
                          className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${
                            isMuted ? 'bg-zinc-500' : 'bg-red-600'
                          }`}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
