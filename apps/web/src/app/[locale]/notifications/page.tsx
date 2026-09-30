'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import type {
  Notification,
  NotificationPage,
  UnreadCount,
  MarkNotificationsReadRequest,
} from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../lib/auth/auth-context';
import { useRouter } from '../../../i18n/routing';
import { NotificationItem } from '../../../components/notifications/notification-item';

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const router = useRouter();
  const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'all' | 'unread'>('all');
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Route guard
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.push('/login?return_to=/notifications');
    }
  }, [isAuthLoading, isAuthenticated, router]);

  const isUnreadOnly = activeTab === 'unread';

  // Infinite query for notifications
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useInfiniteQuery<NotificationPage>({
      queryKey: ['notifications', 'page', { unread: isUnreadOnly }],
      queryFn: async ({ pageParam }) => {
        const { data, response } = await api.social.GET('/v1/notifications', {
          params: {
            query: {
              unread: isUnreadOnly || undefined,
              cursor: (pageParam as string) || undefined,
              limit: 20,
            },
          },
        });
        if (!response.ok || !data) {
          throw new Error('Failed to fetch notifications');
        }
        return data;
      },
      getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
      initialPageParam: null as string | null,
      enabled: isAuthenticated,
    });

  // IntersectionObserver for infinite scrolling
  useEffect(() => {
    if (!sentinelRef.current || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1, rootMargin: '100px' },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Mutation to mark notifications read
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

      const prevPageData = queryClient.getQueryData([
        'notifications',
        'page',
        { unread: isUnreadOnly },
      ]);
      const prevUnreadCount = queryClient.getQueryData<UnreadCount>([
        'notifications',
        'unread-count',
      ]);

      const now = new Date().toISOString();

      if (payload.ids && payload.ids.length > 0) {
        const idSet = new Set(payload.ids);
        if (prevPageData) {
          queryClient.setQueryData(
            ['notifications', 'page', { unread: isUnreadOnly }],
            (old: any) => {
              if (!old?.pages) return old;
              return {
                ...old,
                pages: old.pages.map((p: any) => ({
                  ...p,
                  items: p.items.map((item: any) =>
                    idSet.has(item.id) && !item.read_at ? { ...item, read_at: now } : item,
                  ),
                })),
              };
            },
          );
        }
        if (prevUnreadCount && prevUnreadCount.count > 0) {
          queryClient.setQueryData<UnreadCount>(['notifications', 'unread-count'], {
            ...prevUnreadCount,
            count: Math.max(0, prevUnreadCount.count - payload.ids.length),
          });
        }
      } else if (payload.up_to) {
        const upToDate = new Date(payload.up_to).getTime();
        if (prevPageData) {
          queryClient.setQueryData(
            ['notifications', 'page', { unread: isUnreadOnly }],
            (old: any) => {
              if (!old?.pages) return old;
              return {
                ...old,
                pages: old.pages.map((p: any) => ({
                  ...p,
                  items: p.items.map((item: any) =>
                    new Date(item.created_at).getTime() <= upToDate && !item.read_at
                      ? { ...item, read_at: now }
                      : item,
                  ),
                })),
              };
            },
          );
        }
        if (prevUnreadCount) {
          queryClient.setQueryData<UnreadCount>(['notifications', 'unread-count'], {
            count: 0,
            capped: false,
          });
        }
      }

      return { prevPageData, prevUnreadCount };
    },
    onError: (_err, _payload, context) => {
      if (context?.prevPageData) {
        queryClient.setQueryData(
          ['notifications', 'page', { unread: isUnreadOnly }],
          context.prevPageData,
        );
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

  const allItems = data?.pages.flatMap((page) => page.items) || [];

  const handleItemClick = (item: Notification) => {
    if (!item.read_at) {
      markReadMutation.mutate({ ids: [item.id] });
    }
  };

  const handleMarkAllRead = () => {
    if (allItems.length === 0) return;
    const newestCreatedAt = allItems[0].created_at;
    markReadMutation.mutate({ up_to: newestCreatedAt });
  };

  if (isAuthLoading || (!isAuthenticated && !user)) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto py-4 sm:py-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-gray-200 dark:border-[#272727]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400">
            <Bell className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">
              {t('title')}
            </h1>
          </div>
        </div>

        {allItems.some((n) => !n.read_at) && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={markReadMutation.isPending}
            className="flex items-center gap-2 self-start sm:self-auto rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] dark:hover:bg-[#383838] hover:bg-gray-200 px-4 py-2 text-xs font-semibold text-gray-900 dark:text-white transition cursor-pointer disabled:opacity-50"
          >
            <CheckCheck className="h-4 w-4 text-blue-500" />
            <span>{t('markAllRead')}</span>
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-6">
        <button
          type="button"
          onClick={() => setActiveTab('all')}
          data-testid="notifications-tab-all"
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
            activeTab === 'all'
              ? 'bg-red-600 text-white shadow'
              : 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-gray-700 dark:text-gray-300 hover:bg-[#383838] dark:hover:bg-[#383838] hover:bg-gray-200'
          }`}
        >
          {t('all')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('unread')}
          data-testid="notifications-tab-unread"
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
            activeTab === 'unread'
              ? 'bg-red-600 text-white shadow'
              : 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-gray-700 dark:text-gray-300 hover:bg-[#383838] dark:hover:bg-[#383838] hover:bg-gray-200'
          }`}
        >
          {t('unread')}
        </button>
      </div>

      {/* Notification List */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="flex flex-col gap-3 animate-pulse">
            <div className="h-16 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
            <div className="h-16 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
            <div className="h-16 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
          </div>
        ) : isError ? (
          <div className="py-12 text-center text-sm text-red-500 flex flex-col items-center gap-3">
            <p>{t('errorLoading')}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-full bg-red-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-red-700 transition"
            >
              {t('retry')}
            </button>
          </div>
        ) : allItems.length === 0 ? (
          <div className="py-20 text-center text-sm text-gray-500 dark:text-gray-400">
            {activeTab === 'all' ? t('emptyAll') : t('emptyUnread')}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-[#272727] rounded-2xl border border-gray-200 dark:border-[#272727] bg-[#1a1a1a]/40 dark:bg-[#1a1a1a]/40 bg-white overflow-hidden p-1">
            {allItems.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onItemClick={handleItemClick}
              />
            ))}
          </div>
        )}

        {/* Infinite Scroll Sentinel */}
        {hasNextPage && (
          <div ref={sentinelRef} className="py-6 flex justify-center">
            <button
              type="button"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              className="rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] dark:hover:bg-[#383838] px-5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
            >
              {isFetchingNextPage ? 'Đang tải...' : 'Xem thêm'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
