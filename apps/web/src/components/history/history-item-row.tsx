'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import type { HistoryItem } from '@winkey/api-client';
import { Link } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { Thumbnail } from '../media/thumbnail';

export interface HistoryItemRowProps {
  item: HistoryItem;
  onRemove: (videoId: string) => void;
  isRemoving?: boolean;
}

export function HistoryItemRow({ item, onRemove, isRemoving }: HistoryItemRowProps) {
  const t = useTranslations('history');
  const { video, watched_at, watched_ms } = item;

  const thumbnailUrl = getThumbnailUrl(video.thumbnail_url);
  const watchHref = buildWatchUrl(video.id, 'other');

  const progressPercent =
    video.duration_ms > 0 ? Math.min(100, Math.round((watched_ms / video.duration_ms) * 100)) : 0;

  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove(video.id);
  };

  return (
    <article
      data-testid={`history-item-${video.id}`}
      className="group relative flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 p-3 rounded-2xl hover:bg-zinc-800/40 transition-colors border border-transparent hover:border-zinc-800/80"
    >
      {/* Thumbnail + Duration + Watch Progress Bar */}
      <div className="relative w-full sm:w-56 md:w-64 lg:w-72 shrink-0 aspect-video rounded-xl overflow-hidden bg-zinc-900">
        <Link
          href={watchHref}
          className="block h-full w-full focus:outline-none focus:ring-2 focus:ring-red-600 rounded-xl"
        >
          <Thumbnail
            src={thumbnailUrl}
            alt={video.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
          {/* Duration Badge */}
          <div className="absolute bottom-2 right-2 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] font-semibold text-white pointer-events-none">
            {formatDuration(video.duration_ms)}
          </div>
          {/* Watched Progress Bar */}
          {progressPercent > 0 && (
            <div className="absolute bottom-0 inset-x-0 h-1 bg-white/20 pointer-events-none">
              <div
                className="h-full bg-red-600 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </Link>
      </div>

      {/* Info & Metadata */}
      <div className="flex-1 min-w-0 pr-12 sm:pr-2">
        <Link
          href={watchHref}
          className="block focus:outline-none focus:ring-2 focus:ring-red-600 rounded"
        >
          <h3 className="text-base sm:text-lg font-semibold text-white line-clamp-2 leading-snug group-hover:text-red-400 transition-colors">
            {video.title}
          </h3>
        </Link>

        {/* Channel Info */}
        <div className="mt-1.5 flex items-center gap-2">
          <Link
            href={`/c/${video.owner.handle}`}
            className="flex items-center gap-2 text-xs sm:text-sm text-gray-400 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 rounded"
          >
            {video.owner.avatar_url && (
              <img
                src={video.owner.avatar_url}
                alt={video.owner.display_name}
                className="h-5 w-5 rounded-full object-cover"
                loading="lazy"
              />
            )}
            <span className="font-medium truncate max-w-[180px] sm:max-w-[240px]">
              {video.owner.display_name}
            </span>
          </Link>
        </div>

        {/* Watch Time & Stats */}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span className="text-zinc-300 font-medium">
            {t('watchedAt', { time: formatRelativeTime(watched_at) })}
          </span>
          {video.view_count !== undefined && (
            <>
              <span className="text-zinc-600">•</span>
              <span>{formatViews(video.view_count)} lượt xem</span>
            </>
          )}
        </div>
      </div>

      {/* Remove Single Video Button (Mobile: absolute top-right touch target, Desktop: flex item) */}
      <div className="absolute top-2 right-2 sm:relative sm:top-auto sm:right-auto shrink-0">
        <button
          type="button"
          onClick={handleRemove}
          disabled={isRemoving}
          data-testid={`remove-history-${video.id}`}
          aria-label={t('remove')}
          title={t('remove')}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-500/10 focus:outline-none focus:ring-2 focus:ring-red-500 focus:text-red-500 transition-colors disabled:opacity-40"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      </div>
    </article>
  );
}
