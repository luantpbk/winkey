'use client';

import React, { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api-client';
import { VideoCard } from '../../components/video/video-card';
import { VideoSkeleton } from '../../components/video/video-skeleton';
import type { VideoPage } from '@winkey/api-client';

export default function HomePage() {
  const t = useTranslations('home');
  const sentinelRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['videos', 'feed'],
      initialPageParam: null as string | null,
      queryFn: async ({ pageParam }) => {
        const {
          data: page,
          error: apiErr,
          response,
        } = await api.video.GET('/v1/videos', {
          params: {
            query: {
              cursor: pageParam || undefined,
              limit: 12,
            },
          },
        });

        if (!response.ok || !page) {
          throw new Error(apiErr?.detail || 'Failed to fetch video feed');
        }

        return page as VideoPage;
      },
      getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    });

  // Infinite scroll trigger via IntersectionObserver
  useEffect(() => {
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

  const allVideos = data?.pages.flatMap((page) => page.items) || [];

  return (
    <div className="w-full max-w-[2000px] mx-auto">
      {/* Category Pills (YouTube-like) */}
      <div className="flex gap-3 overflow-x-auto pb-4 mb-4 scrollbar-none text-xs font-semibold">
        {[
          'Tất cả',
          'Công nghệ',
          'Lập trình',
          'Gaming',
          'Âm nhạc',
          'Trực tiếp',
          'Kiến trúc máy tính',
          'HLS',
        ].map((cat, idx) => (
          <button
            key={cat}
            className={`rounded-lg px-3 py-1.5 whitespace-nowrap transition ${
              idx === 0
                ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                : 'bg-gray-100 dark:bg-[#272727] text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-[#383838]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Loading Skeletons */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <VideoSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="flex flex-col items-center justify-center p-12 text-center">
          <p className="text-red-500 font-medium">Lỗi khi tải danh sách video: {error?.message}</p>
        </div>
      )}

      {/* Video Grid */}
      {!isLoading && allVideos.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8">
          {allVideos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}

          {/* Skeletons while loading more */}
          {isFetchingNextPage &&
            Array.from({ length: 4 }).map((_, i) => <VideoSkeleton key={`more-${i}`} />)}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && allVideos.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-gray-500 dark:text-gray-400 text-base">{t('noVideos')}</p>
        </div>
      )}

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-10 w-full" aria-hidden="true" />

      {/* Accessibility fallback button */}
      {hasNextPage && !isFetchingNextPage && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => fetchNextPage()}
            className="rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-6 py-2 text-sm font-semibold text-gray-200 transition"
          >
            Tải thêm video
          </button>
        </div>
      )}
    </div>
  );
}
