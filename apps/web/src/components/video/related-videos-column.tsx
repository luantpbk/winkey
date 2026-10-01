'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations, useLocale } from 'next-intl';
import type { VideoSummary } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { Link } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';

export interface RelatedVideosColumnProps {
  videoId: string;
  className?: string;
}

export function RelatedVideoSkeleton() {
  return (
    <div
      data-testid="related-video-skeleton"
      className="flex gap-3 animate-pulse"
      aria-hidden="true"
    >
      <div className="aspect-video w-40 shrink-0 rounded-xl bg-[#272727] dark:bg-[#272727] bg-gray-200" />
      <div className="flex flex-col flex-1 gap-2 py-1">
        <div className="h-3.5 w-full rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
        <div className="h-3.5 w-3/4 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
        <div className="h-3 w-1/2 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200 mt-1" />
        <div className="h-2.5 w-1/3 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
      </div>
    </div>
  );
}

export function RelatedVideoCard({ video, locale }: { video: VideoSummary; locale: string }) {
  const t = useTranslations('watch');
  const thumbnailUrl =
    video.thumbnail_url ||
    'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80';
  const publishedAt = video.published_at || '';

  return (
    <div
      data-testid="related-video-card"
      data-video-id={video.id}
      className="group relative flex gap-3 rounded-xl focus-within:ring-2 focus-within:ring-red-600"
    >
      {/* Thumbnail + Duration badge */}
      <Link
        href={`/watch/${video.id}`}
        tabIndex={-1}
        aria-hidden="true"
        className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-[#222222]"
      >
        <img
          src={thumbnailUrl}
          alt={video.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
        <div className="absolute bottom-1.5 right-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {formatDuration(video.duration_ms)}
        </div>
      </Link>

      {/* Info: Title, Channel, Views & Relative Date */}
      <div className="flex flex-col min-w-0 flex-1 justify-center">
        <Link
          href={`/watch/${video.id}`}
          className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white line-clamp-2 leading-snug group-hover:text-red-500 transition-colors focus:outline-none"
          title={video.title}
        >
          {video.title}
        </Link>

        <Link
          href={`/c/${video.owner.handle}`}
          className="mt-1 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white truncate transition-colors"
          title={video.owner.display_name}
        >
          {video.owner.display_name}
        </Link>

        <div className="flex items-center gap-1 text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          <span>
            {formatViews(video.view_count)} {t('viewsSuffix')}
          </span>
          <span>•</span>
          <span>{formatRelativeTime(publishedAt, locale)}</span>
        </div>
      </div>
    </div>
  );
}

export function RelatedVideosColumn({ videoId, className = '' }: RelatedVideosColumnProps) {
  const t = useTranslations('watch');
  const locale = useLocale();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['related', videoId],
    queryFn: async () => {
      const res = await api.video.GET('/v1/videos/{video_id}/related', {
        params: {
          path: { video_id: videoId },
          query: { limit: 12 },
        },
      });

      if (!res.response.ok || res.error) {
        throw Object.assign(new Error(`Related videos fetch failed: ${res.response.status}`), {
          status: res.response.status,
        });
      }
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 min
    refetchOnWindowFocus: false,
    retry: false, // no retry loop on error
  });

  // Loading state: 6 skeleton rows
  if (isLoading) {
    return (
      <aside
        aria-label={t('upNext')}
        className={`flex flex-col gap-4 ${className}`}
        data-testid="related-videos-column"
      >
        <h2 className="text-base font-bold text-gray-900 dark:text-white">{t('upNext')}</h2>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <RelatedVideoSkeleton key={i} />
          ))}
        </div>
      </aside>
    );
  }

  // Error state (404, 500, network, etc.): hide the column silently without toast or error log
  if (isError) {
    return null;
  }

  // Filter out current video defensively
  const items = (data?.items || []).filter((item) => item.id !== videoId);

  // Empty state: hide the column (no empty box)
  if (items.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label={t('upNext')}
      className={`flex flex-col gap-4 ${className}`}
      data-testid="related-videos-column"
    >
      <h2 className="text-base font-bold text-gray-900 dark:text-white">{t('upNext')}</h2>
      <div className="flex flex-col gap-3" data-testid="related-videos-list">
        {items.map((item) => (
          <RelatedVideoCard key={item.id} video={item} locale={locale} />
        ))}
      </div>
    </aside>
  );
}
