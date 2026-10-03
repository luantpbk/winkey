'use client';

import React from 'react';
import type { VideoSummary, Video } from '@winkey/api-client';
import { Link } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { Clock } from 'lucide-react';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useToast } from '../ui/toast';
import { useAuth } from '../../lib/auth/auth-context';

export interface VideoCardProps {
  video: VideoSummary | Video;
  rank?: number;
}

export function VideoCard({ video, rank }: VideoCardProps) {
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const handleWatchLater = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      showToast({ title: 'Vui lòng đăng nhập để lưu vào Xem sau', type: 'info' });
      return;
    }
    await addToWatchLater(video.id, { showToast });
  };

  const thumbnailUrl = getThumbnailUrl(
    'thumbnail_url' in video ? video.thumbnail_url : null,
    'playback' in video ? video.playback?.thumbnail_url : null,
  );

  const publishedAt =
    'published_at' in video && video.published_at
      ? video.published_at
      : 'created_at' in video
        ? video.created_at
        : '';

  return (
    <div className="group flex flex-col gap-3">
      {/* Thumbnail + Duration + Rank + Watch Later */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#222222]">
        <Link
          href={`/watch/${video.id}`}
          className="block h-full w-full focus:outline-none focus:ring-2 focus:ring-red-600"
        >
          <img
            src={thumbnailUrl}
            alt={video.title}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
          {rank !== undefined && (
            <div
              data-testid={`rank-badge-${rank}`}
              aria-label={`Rank ${rank}`}
              className="absolute top-2 left-2 z-10 flex h-7 min-w-[28px] items-center justify-center rounded-lg bg-red-600 px-2 text-xs font-black text-white shadow-md"
            >
              {rank}
            </div>
          )}
          <div className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {formatDuration(video.duration_ms)}
          </div>
        </Link>

        {/* Watch Later Quick Action on Hover */}
        <button
          type="button"
          onClick={handleWatchLater}
          aria-label="Xem sau"
          title="Xem sau"
          data-testid="watch-later-btn"
          className="absolute top-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg bg-black/80 hover:bg-red-600 text-white opacity-0 group-hover:opacity-100 transition-all shadow-md focus:opacity-100"
        >
          <Clock className="h-4 w-4" />
        </button>
      </div>

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
