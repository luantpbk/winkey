'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { History, Trash2, Loader2, AlertCircle } from 'lucide-react';
import type { HistoryPage } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { HistoryItemRow } from './history-item-row';
import { ClearHistoryDialog } from './clear-history-dialog';
import { HistoryEmptyState } from './history-empty-state';
import { HistoryLoginPrompt } from './history-login-prompt';

export const HISTORY_QUERY_KEY = ['history', 'me'] as const;

export function HistoryView() {
  const t = useTranslations('history');
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 1. Data fetching
  const { data, isLoading, isError, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery<HistoryPage>({
      queryKey: HISTORY_QUERY_KEY,
      queryFn: async ({ pageParam }) => {
        const { data, response } = await api.video.GET('/v1/me/history', {
          params: {
            query: {
              cursor: (pageParam as string) || undefined,
              limit: 20,
            },
          },
        });

        if (!response.ok || !data) {
          throw new Error('Failed to fetch watch history');
        }

        return data;
      },
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
      enabled: isAuthenticated,
    });

  // 2. Remove single video mutation (with Optimistic Update)
  const removeMutation = useMutation({
    mutationFn: async (videoId: string) => {
      setRemovingId(videoId);
      const { response } = await api.video.DELETE('/v1/me/history/{video_id}', {
        params: {
          path: { video_id: videoId },
        },
      });
      if (!response.ok) {
        throw new Error('Failed to delete history item');
      }
    },
    onMutate: async (videoId: string) => {
      await queryClient.cancelQueries({ queryKey: HISTORY_QUERY_KEY });
      const previousData = queryClient.getQueryData<InfiniteData<HistoryPage>>(HISTORY_QUERY_KEY);

      if (previousData) {
        queryClient.setQueryData<InfiniteData<HistoryPage>>(HISTORY_QUERY_KEY, {
          ...previousData,
          pages: previousData.pages.map((p) => ({
            ...p,
            items: p.items.filter((item) => item.video.id !== videoId),
          })),
        });
      }

      return { previousData };
    },
    onError: (_err, _videoId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(HISTORY_QUERY_KEY, context.previousData);
      }
      showToast({ title: 'Không thể xoá video. Vui lòng thử lại.', type: 'error' });
    },
    onSuccess: () => {
      showToast({ title: t('itemRemoved'), type: 'success' });
    },
    onSettled: () => {
      setRemovingId(null);
    },
  });

  // 3. Clear all watch history mutation (with Optimistic Update)
  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const { response } = await api.video.DELETE('/v1/me/history');
      if (!response.ok) {
        throw new Error('Failed to clear watch history');
      }
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: HISTORY_QUERY_KEY });
      const previousData = queryClient.getQueryData<InfiniteData<HistoryPage>>(HISTORY_QUERY_KEY);

      queryClient.setQueryData<InfiniteData<HistoryPage>>(HISTORY_QUERY_KEY, {
        pages: [{ items: [], next_cursor: null }],
        pageParams: [null],
      });

      return { previousData };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(HISTORY_QUERY_KEY, context.previousData);
      }
      showToast({ title: 'Không thể xoá toàn bộ lịch sử. Vui lòng thử lại.', type: 'error' });
    },
    onSuccess: () => {
      setIsClearDialogOpen(false);
      showToast({ title: t('allCleared'), type: 'success' });
    },
  });

  // 4. Infinite scroll observer
  useEffect(() => {
    if (!sentinelRef.current || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Auth Loading state
  if (isAuthLoading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-red-500" />
      </div>
    );
  }

  // Guest state: Show login prompt
  if (!isAuthenticated) {
    return (
      <div className="w-full max-w-5xl mx-auto px-4 py-8">
        <HistoryLoginPrompt />
      </div>
    );
  }

  const allItems = data?.pages.flatMap((page) => page.items) ?? [];
  const hasItems = allItems.length > 0;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6 sm:py-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 pb-4 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
            <History className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              {t('title')}
            </h1>
          </div>
        </div>

        {/* Clear All Button */}
        {hasItems && (
          <button
            type="button"
            data-testid="clear-all-history-btn"
            onClick={() => setIsClearDialogOpen(true)}
            className="inline-flex items-center gap-2 self-start sm:self-auto px-4 py-2 rounded-full text-sm font-medium text-zinc-300 hover:text-white hover:bg-zinc-800/80 active:scale-95 transition-all focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <Trash2 className="h-4 w-4 text-red-500" />
            <span className="hidden sm:inline">{t('clearAll')}</span>
            <span className="sm:hidden">{t('clearAllShort')}</span>
          </button>
        )}
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="space-y-4 animate-pulse" data-testid="history-loading-skeleton">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col sm:flex-row gap-4 p-3 rounded-2xl bg-zinc-900/40">
              <div className="w-full sm:w-56 md:w-64 lg:w-72 aspect-video rounded-xl bg-zinc-800" />
              <div className="flex-1 space-y-3 py-1">
                <div className="h-4 bg-zinc-800 rounded w-3/4" />
                <div className="h-3 bg-zinc-800 rounded w-1/3" />
                <div className="h-3 bg-zinc-800 rounded w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div
          data-testid="history-error-state"
          className="flex flex-col items-center justify-center py-16 text-center"
        >
          <AlertCircle className="h-10 w-10 text-red-500 mb-3" />
          <p className="text-gray-300 mb-4 text-sm sm:text-base">
            Không thể tải lịch sử xem. Vui lòng thử lại.
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            Thử lại
          </button>
        </div>
      ) : !hasItems ? (
        <HistoryEmptyState />
      ) : (
        <div className="space-y-2">
          {allItems.map((item) => (
            <HistoryItemRow
              key={item.video.id}
              item={item}
              onRemove={(id) => removeMutation.mutate(id)}
              isRemoving={removingId === item.video.id}
            />
          ))}

          {/* Sentinel for infinite scrolling */}
          <div ref={sentinelRef} className="py-4 flex justify-center">
            {isFetchingNextPage && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin text-red-500" />
                <span>{t('loading')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      <ClearHistoryDialog
        isOpen={isClearDialogOpen}
        isClearing={clearAllMutation.isPending}
        onClose={() => setIsClearDialogOpen(false)}
        onConfirm={() => clearAllMutation.mutate()}
      />
    </div>
  );
}
