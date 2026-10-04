'use client';

import React, { useEffect, useRef } from 'react';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { VideoCard } from './video-card';
import { VideoSkeleton } from './video-skeleton';
import type { VideoPage, VideoSummary } from '@winkey/api-client';

export interface VideoFeedProps {
  queryKey: QueryKey;
  fetchPage: (cursor: string | null) => Promise<VideoPage>;
  staleTime?: number;
  renderItem?: (video: VideoSummary, index: number) => React.ReactNode;
  emptySlot?: React.ReactNode;
  headerSlot?: React.ReactNode;
  gridClassName?: string;
  loadMoreText?: string;
  errorMessage?: string;
}

export function VideoFeed({
  queryKey,
  fetchPage,
  staleTime,
  renderItem,
  emptySlot,
  headerSlot,
  gridClassName,
  loadMoreText,
  errorMessage,
}: VideoFeedProps) {
  const t = useTranslations('home');
  const sentinelRef = useRef<HTMLDivElement>(null);

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      return fetchPage(pageParam);
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime,
  });

  // Infinite scroll trigger via IntersectionObserver
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Defensive deduplication across pages
  const seenIds = new Set<string>();
  const allVideos = (data?.pages.flatMap((page) => page.items) || []).filter((video) => {
    if (!video?.id) return false;
    if (seenIds.has(video.id)) return false;
    seenIds.add(video.id);
    return true;
  });

  return (
    <div className="w-full">
      {headerSlot}

      {/* Loading Skeletons */}
      {isLoading && (
        <div
          data-testid="feed-loading-skeletons"
          className={
            gridClassName ||
            'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8'
          }
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <VideoSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div role="alert" className="flex flex-col items-center justify-center p-12 text-center">
          <p className="text-red-500 font-medium mb-4">
            {errorMessage ||
              (t ? t('fetchError') : `Lỗi khi tải danh sách video: ${error?.message}`)}
          </p>
          <button
            type="button"
            data-testid="feed-retry-btn"
            onClick={() => refetch()}
            className="rounded-full bg-red-600 hover:bg-red-700 text-white px-5 py-2 text-sm font-semibold transition"
          >
            {t ? t('retry') : 'Thử lại'}
          </button>
        </div>
      )}

      {/* Video Grid */}
      {!isLoading && allVideos.length > 0 && (
        <div
          data-testid="video-feed-grid"
          className={
            gridClassName ||
            'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8'
          }
        >
          {allVideos.map((video, index) =>
            renderItem ? renderItem(video, index) : <VideoCard key={video.id} video={video} />,
          )}

          {/* Skeletons while loading more */}
          {isFetchingNextPage &&
            Array.from({ length: 4 }).map((_, i) => <VideoSkeleton key={`more-${i}`} />)}
        </div>
      )}

      {/* Empty State */}
      {!isLoading &&
        !isError &&
        allVideos.length === 0 &&
        (emptySlot ? (
          <div data-testid="feed-empty-slot">{emptySlot}</div>
        ) : (
          <div
            data-testid="feed-default-empty"
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <p className="text-gray-500 dark:text-gray-400 text-base">{t('noVideos')}</p>
          </div>
        ))}

      {/* Sentinel and fallback button for infinite scroll */}
      {!isLoading && allVideos.length > 0 && (
        <>
          <div
            ref={sentinelRef}
            data-testid="feed-sentinel"
            className="h-10 w-full"
            aria-hidden="true"
          />

          {hasNextPage && !isFetchingNextPage && (
            <div className="flex justify-center mt-6">
              <button
                type="button"
                onClick={() => fetchNextPage()}
                className="rounded-full bg-gray-100 dark:bg-[#272727] hover:bg-gray-200 dark:hover:bg-[#383838] px-6 py-2 text-sm font-semibold text-gray-800 dark:text-gray-200 transition"
              >
                {loadMoreText || t('loadingMore') || 'Tải thêm video'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
