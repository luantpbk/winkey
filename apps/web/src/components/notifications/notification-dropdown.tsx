'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import type {
  Notification,
  NotificationPage,
  UnreadCount,
  MarkNotificationsReadRequest,
} from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { NotificationItem } from './notification-item';
import { Link } from '../../i18n/routing';

export interface NotificationDropdownProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotificationDropdown({ isOpen, onClose }: NotificationDropdownProps) {
  const t = useTranslations('notifications');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Fetch latest 10 notifications for dropdown
  const { data, isLoading, isError, refetch } = useQuery<NotificationPage>({
    queryKey: ['notifications', 'latest-10'],
    queryFn: async () => {
      const { data, response } = await api.social.GET('/v1/notifications', {
        params: { query: { limit: 10 } },
      });
      if (!response.ok || !data) {
        throw new Error('Failed to load notifications');
      }
      return data;
    },
    enabled: isOpen,
    staleTime: 30000,
  });

  const notifications = data?.items || [];

  // Mutation to mark notifications as read with optimistic updates
  const markReadMutation = useMutation({
    mutationFn: async (payload: { ids?: string[]; up_to?: string }) => {
      const { response } = await api.social.POST('/v1/notifications/read', {
        body: payload as MarkNotificationsReadRequest,
      });
      if (!response.ok) {
        throw new Error('Failed to mark notifications read');
      }
      return true;
    },
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      await queryClient.cancelQueries({ queryKey: ['notifications', 'unread-count'] });

      const prevLatest = queryClient.getQueryData<NotificationPage>(['notifications', 'latest-10']);
      const prevUnreadCount = queryClient.getQueryData<UnreadCount>([
        'notifications',
        'unread-count',
      ]);

      const now = new Date().toISOString();

      if (payload.ids && payload.ids.length > 0) {
        // Optimistic single item mark
        const idSet = new Set(payload.ids);
        if (prevLatest) {
          queryClient.setQueryData<NotificationPage>(['notifications', 'latest-10'], {
            ...prevLatest,
            items: prevLatest.items.map((item) =>
              idSet.has(item.id) && !item.read_at ? { ...item, read_at: now } : item,
            ),
          });
        }
        if (prevUnreadCount && prevUnreadCount.count > 0) {
          queryClient.setQueryData<UnreadCount>(['notifications', 'unread-count'], {
            ...prevUnreadCount,
            count: Math.max(0, prevUnreadCount.count - payload.ids.length),
          });
        }
      } else if (payload.up_to) {
        // Optimistic mark all as read up to created_at
        const upToDate = new Date(payload.up_to).getTime();
        if (prevLatest) {
          queryClient.setQueryData<NotificationPage>(['notifications', 'latest-10'], {
            ...prevLatest,
            items: prevLatest.items.map((item) =>
              new Date(item.created_at).getTime() <= upToDate ? { ...item, read_at: now } : item,
            ),
          });
        }
        if (prevUnreadCount) {
          queryClient.setQueryData<UnreadCount>(['notifications', 'unread-count'], {
            count: 0,
            capped: false,
          });
        }
      }

      return { prevLatest, prevUnreadCount };
    },
    onError: (_err, _payload, context) => {
      // Rollback on error
      if (context?.prevLatest) {
        queryClient.setQueryData(['notifications', 'latest-10'], context.prevLatest);
      }
      if (context?.prevUnreadCount) {
        queryClient.setQueryData(['notifications', 'unread-count'], context.prevUnreadCount);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
    },
  });

  const handleItemClick = (item: Notification) => {
    if (!item.read_at) {
      markReadMutation.mutate({ ids: [item.id] });
    }
    onClose();
  };

  const handleMarkAllRead = () => {
    if (notifications.length === 0) return;
    // Send up_to = created_at of the newest notification shown (NEVER client clock, ADR-023)
    const newestCreatedAt = notifications[0].created_at;
    markReadMutation.mutate({ up_to: newestCreatedAt });
  };

  // Keyboard navigation & click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={dropdownRef}
      role="dialog"
      aria-label={t('title')}
      className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-[#383838] dark:border-[#383838] border-gray-200 bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-white shadow-2xl z-50 overflow-hidden flex flex-col max-h-[500px]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-100 shrink-0">
        <h3 className="font-bold text-sm sm:text-base text-gray-900 dark:text-white">
          {t('title')}
        </h3>
        {notifications.some((n) => !n.read_at) && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={markReadMutation.isPending}
            className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 transition cursor-pointer disabled:opacity-50"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            <span>{t('markAllRead')}</span>
          </button>
        )}
      </div>

      {/* Body: Notification list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-[#272727] p-1">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-3 animate-pulse">
            <div className="h-14 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
            <div className="h-14 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
            <div className="h-14 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
          </div>
        ) : isError ? (
          <div className="p-6 text-center text-xs text-red-500 flex flex-col items-center gap-2">
            <p>{t('errorLoading')}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="text-xs text-blue-500 underline"
            >
              {t('retry')}
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-12 px-4 text-center text-xs sm:text-sm text-gray-500 dark:text-gray-400">
            {t('emptyAll')}
          </div>
        ) : (
          notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} onItemClick={handleItemClick} />
          ))
        )}
      </div>

      {/* Footer: View all */}
      <div className="p-2 border-t border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-100 text-center shrink-0 bg-gray-50/50 dark:bg-[#181818]">
        <Link
          href="/notifications"
          onClick={onClose}
          className="text-xs font-semibold text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 hover:underline inline-block py-1 px-3"
        >
          {t('viewAll')}
        </Link>
      </div>
    </div>
  );
}
