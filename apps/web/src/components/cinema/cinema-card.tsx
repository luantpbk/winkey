'use client';

import React, { useState, useRef, useCallback } from 'react';
import type { VideoSummary, Video } from '@winkey/api-client';
import { Play, Plus, Info, X } from 'lucide-react';
import { Link, useRouter } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { type WatchSurface, buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

export interface CinemaCardProps {
  video: VideoSummary | Video;
  surface: WatchSurface;
  rank?: number;
  progressPercent?: number; // 0 - 100 for continue watching
  onRemove?: () => void;
  onOpenDetail: (videoId: string) => void;
  isFirst?: boolean;
  isLast?: boolean;
}

export function CinemaCard({
  video,
  surface,
  rank: _rank,
  progressPercent,
  onRemove,
  onOpenDetail,
  isFirst = false,
  isLast = false,
}: CinemaCardProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [isHovered, setIsHovered] = useState(false);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  const watchHref = buildWatchUrl(video.id, surface);
  const thumbnailUrl = getThumbnailUrl(
    'thumbnail_url' in video ? video.thumbnail_url : null,
    'playback' in video ? video.playback?.thumbnail_url : null,
  );

  const handleMouseEnter = useCallback(() => {
    // Only expand after 300ms on desktop
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      hoverTimerRef.current = setTimeout(() => {
        setIsHovered(true);
      }, 300);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(false);
  }, []);

  const handleFocus = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      hoverTimerRef.current = setTimeout(() => {
        setIsHovered(true);
      }, 300);
    }
  }, []);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
      return;
    }
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(false);
  }, []);

  const handleCardClick = (e: React.MouseEvent) => {
    // On touch devices / screens < 768px, card tap opens detail dialog
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      e.preventDefault();
      onOpenDetail(video.id);
    }
  };

  const handleWatchLaterClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await addToWatchLater(video.id, { showToast });
  };

  const handleDetailsClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenDetail(video.id);
  };

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove?.();
  };

  // Inward growth transform-origin
  const originClass = isFirst ? 'origin-left' : isLast ? 'origin-right' : 'origin-center';

  return (
    <div
      data-testid="cinema-card"
      data-video-id={video.id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`group relative shrink-0 snap-start select-none transition-all duration-300 ${originClass} ${
        isHovered ? 'z-30' : 'z-10'
      }`}
      style={{
        width: '100%',
      }}
    >
      <div
        className={`relative transition-transform duration-300 ease-out ${
          isHovered
            ? 'scale-[1.25] shadow-2xl rounded-xl bg-[#14141d] ring-1 ring-white/10'
            : 'scale-100'
        }`}
      >
        {/* Main 16:9 Thumbnail Box */}
        <Link
          href={watchHref}
          onClick={handleCardClick}
          data-testid="cinema-card-link"
          className="block relative aspect-video w-full overflow-hidden rounded-lg bg-[#181822] focus:outline-none focus:ring-2 focus:ring-red-600"
        >
          <img
            src={thumbnailUrl}
            alt={video.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300"
          />

          {/* Duration Badge */}
          <div className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1 py-0.5 text-[10px] font-semibold text-white">
            {formatDuration(video.duration_ms)}
          </div>

          {/* Continue Watching Progress Bar */}
          {progressPercent !== undefined && progressPercent > 0 && (
            <div
              data-testid="cinema-card-progress"
              className="absolute bottom-0 left-0 right-0 h-1 bg-gray-700/80 overflow-hidden"
            >
              <div
                className="h-full bg-red-600 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
              />
            </div>
          )}

          {/* Remove from Continue Watching "x" Button */}
          {onRemove && (
            <button
              type="button"
              onClick={handleRemoveClick}
              aria-label={t('removeFromContinue')}
              title={t('removeFromContinue')}
              data-testid="cinema-card-remove-btn"
              className="absolute top-1.5 right-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 hover:bg-red-600 text-white transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </Link>

        {/* Normal Mode: Title below card (1 line) */}
        {!isHovered && (
          <div className="mt-1.5 px-0.5">
            <h3 className="truncate text-xs sm:text-sm font-medium text-gray-200">{video.title}</h3>
          </div>
        )}

        {/* Hover / Expanded Mode Panel (Desktop only) */}
        {isHovered && (
          <div
            data-testid="cinema-card-expanded-panel"
            className="p-3 bg-[#14141d] rounded-b-xl flex flex-col gap-2"
          >
            {/* Quick Action Buttons */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Link
                  href={watchHref}
                  data-testid="cinema-card-quick-watch"
                  aria-label={t('watchNow')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 hover:bg-red-700 text-white shadow transition-transform active:scale-95"
                >
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </Link>

                <button
                  type="button"
                  onClick={handleWatchLaterClick}
                  data-testid="cinema-card-quick-watch-later"
                  aria-label={t('watchLater')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleDetailsClick}
                data-testid="cinema-card-quick-details"
                aria-label={t('details')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>

            {/* Title & Metadata */}
            <div>
              <h3 className="text-xs font-bold text-white line-clamp-2 leading-snug">
                {video.title}
              </h3>
              <p className="text-[11px] text-gray-400 mt-1 truncate">{video.owner?.display_name}</p>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mt-0.5">
                <span>{formatViews(video.view_count)} lượt xem</span>
                <span>•</span>
                <span>{formatRelativeTime(video.published_at)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
