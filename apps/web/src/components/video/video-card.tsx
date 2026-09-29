'use client';

import React from 'react';
import type { VideoSummary, Video } from '@winkey/api-client';
import { Link } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';

export function VideoCard({ video }: { video: VideoSummary | Video }) {
  const thumbnailUrl =
    'thumbnail_url' in video && video.thumbnail_url
      ? video.thumbnail_url
      : 'playback' in video && video.playback?.thumbnail_url
      ? video.playback.thumbnail_url
      : 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80';

  const publishedAt =
    'published_at' in video && video.published_at
      ? video.published_at
      : 'created_at' in video
      ? video.created_at
      : '';

  return (
    <div className="group flex flex-col gap-3">
      {/* Thumbnail + Duration */}
      <Link
        href={`/watch/${video.id}`}
        className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#222222] focus:outline-none focus:ring-2 focus:ring-red-600"
      >
        <img
          src={thumbnailUrl}
          alt={video.title}
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          loading="lazy"
        />
        <div className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {formatDuration(video.duration_ms)}
        </div>
      </Link>

      {/* Info Row: Avatar + Title/Channel */}
      <div className="flex gap-3">
        <Link
          href={`/c/${video.owner.handle}`}
          className="shrink-0 focus:outline-none focus:ring-2 focus:ring-red-600 rounded-full"
        >
          {video.owner.avatar_url ? (
            <img
              src={video.owner.avatar_url}
              alt={video.owner.display_name}
              className="h-9 w-9 rounded-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white font-bold text-xs">
              {video.owner.display_name.charAt(0)}
            </div>
          )}
        </Link>

        <div className="flex flex-col min-w-0 flex-1">
          <Link
            href={`/watch/${video.id}`}
            className="text-sm font-semibold text-gray-900 dark:text-white line-clamp-2 leading-snug group-hover:text-red-500 transition-colors"
            title={video.title}
          >
            {video.title}
          </Link>

          <Link
            href={`/c/${video.owner.handle}`}
            className="mt-1 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white truncate transition-colors"
          >
            {video.owner.display_name}
          </Link>

          <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <span>{formatViews(video.view_count)} lượt xem</span>
            <span>•</span>
            <span>{formatRelativeTime(publishedAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
