'use client';

import React, { useState } from 'react';
import { Search, Plus, Users, User, BellOff, MessageSquare } from 'lucide-react';
import type { Conversation } from '@winkey/api-client';

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
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredConversations = conversations.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (c.kind === 'GROUP') {
      return c.title?.toLowerCase().includes(q);
    }
    const peer = c.members.find((m) => m.user_id !== currentUserId);
    return (
      peer?.user?.display_name?.toLowerCase().includes(q) ||
      peer?.user?.handle?.toLowerCase().includes(q)
    );
  });

  const getConversationTitle = (c: Conversation) => {
    if (c.kind === 'GROUP') {
      return c.title || 'Nhóm không tên';
    }
    const peer = c.members.find((m) => m.user_id !== currentUserId);
    return peer?.user?.display_name || peer?.user?.handle || 'Người dùng Winkey';
  };

  const getPeerAvatar = (c: Conversation) => {
    if (c.kind === 'GROUP') return null;
    const peer = c.members.find((m) => m.user_id !== currentUserId);
    return peer?.user?.avatar_url || null;
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#121212] border-r border-zinc-200 dark:border-[#272727]">
      {/* Top Header */}
      <div className="p-4 border-b border-zinc-100 dark:border-[#1f1f1f] space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-red-500" />
            <span>Tin nhắn</span>
          </h1>
          <button
            type="button"
            onClick={onOpenNewChat}
            title="Tạo tin nhắn mới"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>Tin mới</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex rounded-xl bg-zinc-100 dark:bg-[#181818] p-1 border border-zinc-200 dark:border-[#272727]">
          <button
            type="button"
            onClick={() => onTabChange('ACTIVE')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'ACTIVE'
                ? 'bg-white dark:bg-[#242424] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <span>Hộp thư</span>
          </button>
          <button
            type="button"
            onClick={() => onTabChange('REQUESTED')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              activeTab === 'REQUESTED'
                ? 'bg-white dark:bg-[#242424] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <span>Lời mời</span>
            {requestsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-bold">
                {requestsCount > 99 ? '99+' : requestsCount}
              </span>
            )}
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Tìm kiếm trò chuyện..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-zinc-200 dark:border-[#272727] bg-zinc-50 dark:bg-[#181818] text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-red-500"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y divide-zinc-100 dark:divide-[#1c1c1c]">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="text-center py-12 px-4 space-y-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {activeTab === 'ACTIVE'
                ? 'Không có cuộc trò chuyện nào.'
                : 'Không có lời mời nhắn tin nào.'}
            </p>
            {activeTab === 'ACTIVE' && (
              <button
                type="button"
                onClick={onOpenNewChat}
                className="text-xs font-semibold text-red-500 hover:text-red-400"
              >
                Bắt đầu trò chuyện ngay
              </button>
            )}
          </div>
        ) : (
          filteredConversations.map((conv) => {
            const isSelected = conv.id === activeConversationId;
            const title = getConversationTitle(conv);
            const avatarUrl = getPeerAvatar(conv);
            const isMuted = conv.muted_until && new Date(conv.muted_until).getTime() > Date.now();
            const dateStr = conv.last_message_at
              ? new Date(conv.last_message_at).toLocaleDateString('vi-VN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';

            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => onSelectConversation(conv)}
                className={`w-full text-left p-3.5 flex items-start gap-3 transition-colors ${
                  isSelected
                    ? 'bg-zinc-100 dark:bg-[#1e1e1e]'
                    : 'hover:bg-zinc-50 dark:hover:bg-[#161616]'
                }`}
              >
                {/* Avatar */}
                <div className="relative shrink-0">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={title}
                      className="h-10 w-10 rounded-full object-cover border border-zinc-200 dark:border-zinc-800"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 font-bold text-sm">
                      {conv.kind === 'GROUP' ? (
                        <Users className="h-5 w-5" />
                      ) : (
                        <User className="h-5 w-5" />
                      )}
                    </div>
                  )}
                  {conv.unread_count > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
                      {conv.unread_count > 99 ? '99+' : conv.unread_count}
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                      {title}
                    </span>
                    {dateStr && (
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">
                        {dateStr}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {conv.kind === 'GROUP'
                        ? `${conv.members.length} thành viên`
                        : conv.my_state === 'REQUESTED'
                          ? 'Lời mời tin nhắn'
                          : 'Mã hoá đầu cuối (E2EE)'}
                    </span>
                    {isMuted && <BellOff className="h-3 w-3 text-zinc-400 shrink-0" />}
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
