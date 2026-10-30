'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from '../../i18n/routing';
import { MessageSquare } from 'lucide-react';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useRealtimeRoom } from '../../lib/realtime/realtime-context';

export function ChatBadgeButton() {
  const { isAuthenticated, user } = useAuth();
  const [unreadTotal, setUnreadTotal] = useState<number>(0);

  const fetchUnreadTotal = useCallback(async () => {
    if (!isAuthenticated) {
      setUnreadTotal(0);
      return;
    }

    try {
      const { data, response } = await api.chat.GET('/v1/chat/conversations', {
        params: {
          query: {
            state: 'ACTIVE',
            limit: 30,
          },
        },
      });

      if (response.ok && data?.items) {
        const sum = data.items.reduce((acc, conv) => acc + (conv.unread_count || 0), 0);
        setUnreadTotal(sum);
      }
    } catch {
      // Ignore background fetch error
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchUnreadTotal();
  }, [fetchUnreadTotal]);

  // Realtime update when chat hints arrive
  const userRoom = user?.id ? `user:${user.id}` : null;
  useRealtimeRoom(
    userRoom,
    useCallback(
      (evt) => {
        if (evt.event === 'chat.hint') {
          fetchUnreadTotal();
        }
      },
      [fetchUnreadTotal],
    ),
    fetchUnreadTotal,
  );

  if (!isAuthenticated) {
    return null;
  }

  return (
    <Link
      href="/tin-nhan"
      className="relative rounded-full min-w-11 min-h-11 shrink-0 flex items-center justify-center p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition"
      title="Tin nhắn (E2EE)"
      aria-label="Tin nhắn"
    >
      <MessageSquare className="h-5 w-5" />
      {unreadTotal > 0 && (
        <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
          {unreadTotal > 99 ? '99+' : unreadTotal}
        </span>
      )}
    </Link>
  );
}
