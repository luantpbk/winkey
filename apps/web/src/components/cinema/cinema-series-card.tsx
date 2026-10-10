'use client';

import React, { useState, useRef, useCallback } from 'react';
import type { SeriesSummary, VideoSummary } from '@winkey/api-client';
import { Play, Plus, Info } from 'lucide-react';
import { Link, useRouter } from '../../i18n/routing';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

export interface CinemaSeriesCardProps {
  series: SeriesSummary;
  coverVideo?: VideoSummary | null;
  onOpenSeries: (playlistId: string) => void;
  isFirst?: boolean;
  isLast?: boolean;
}

export function CinemaSeriesCard({
  series,
  coverVideo,
  onOpenSeries,
  isFirst = false,
  isLast = false,
}: CinemaSeriesCardProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [isHovered, setIsHovered] = useState(false);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  const watchFirstEpisodeHref = `${buildWatchUrl(series.first_video_id, 'playlist')}&playlist=${encodeURIComponent(series.playlist_id)}`;
  const thumbnailUrl = getThumbnailUrl(
    coverVideo?.thumbnail_url || null,
    coverVideo && 'playback' in coverVideo ? (coverVideo as { playback?: { thumbnail_url?: string } }).playback?.thumbnail_url : null,
  );

  const handleMouseEnter = useCallback(() => {
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
    e.preventDefault();
    onOpenSeries(series.playlist_id);
  };

  const handleWatchLaterClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await addToWatchLater(series.first_video_id, { showToast });
  };

  const handleDetailsClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenSeries(series.playlist_id);
  };

  const originClass = isFirst ? 'origin-left' : isLast ? 'origin-right' : 'origin-center';

  return (
    <div
      data-testid="cinema-series-card"
      data-series-id={series.playlist_id}
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
            ? 'scale-[1.25] shadow-2xl rounded-[10px] bg-[#1D1D25] ring-1 ring-white/10'
            : 'scale-100'
        }`}
      >
        {/* Main 16:9 Thumbnail Box */}
        <button
          type="button"
          onClick={handleCardClick}
          data-testid="cinema-series-card-link"
          className="block relative aspect-video w-full overflow-hidden rounded-[6px] bg-[#181822] focus:outline-none focus:ring-2 focus:ring-white text-left"
        >
          <img
            src={thumbnailUrl}
            alt={series.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300"
          />

          {/* Episode Count Badge: "N tập" */}
          <div
            data-testid="series-card-episodes-badge"
            className="absolute bottom-1.5 right-1.5 rounded bg-[#0A0A0D]/85 px-1.5 py-0.5 text-[11px] font-semibold text-white tracking-wide"
          >
            {t('episodeCountBadge', { count: series.episode_count })}
          </div>
        </button>

        {/* Normal Mode: Title and channel below card */}
        {!isHovered && (
          <div className="pt-2 px-0.5">
            <h3 className="truncate text-sm font-semibold text-[#F4F4F6]">{series.title}</h3>
            <p className="text-xs text-[#A3A3AD] mt-0.5 truncate">
              {coverVideo?.owner?.display_name || series.owner?.display_name || ''}
            </p>
          </div>
        )}

        {/* Hover / Expanded Mode Panel (Desktop only) */}
        {isHovered && (
          <div
            data-testid="cinema-series-card-expanded-panel"
            className="p-3 bg-[#1D1D25] rounded-b-[10px] flex flex-col gap-2"
          >
            {/* Quick Action Buttons */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {/* Watch button: White circle with dark text - goes to Episode 1 */}
                <Link
                  href={watchFirstEpisodeHref}
                  data-testid="cinema-series-quick-watch"
                  aria-label={t('watchNow')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white hover:bg-[#E4E4E8] text-[#0A0A0D] shadow transition-transform active:scale-95"
                >
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </Link>

                {/* Watch later button: adds Episode 1 to watch later */}
                <button
                  type="button"
                  onClick={handleWatchLaterClick}
                  data-testid="cinema-series-quick-watch-later"
                  aria-label={t('watchLater')}
                  className="flex h-8 w-8 items-center justify-center rounded-full border-[1.5px] border-white/55 bg-transparent hover:bg-white/10 text-white transition-colors"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {/* Detail button: opens series dialog */}
              <button
                type="button"
                onClick={handleDetailsClick}
                data-testid="cinema-series-quick-details"
                aria-label={t('details')}
                className="flex h-8 w-8 items-center justify-center rounded-full border-[1.5px] border-white/55 bg-transparent hover:bg-white/10 text-white transition-colors"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>

            {/* Title & Metadata */}
            <div>
              <h3 className="text-xs font-bold text-[#F4F4F6] line-clamp-2 leading-snug">
                {series.title}
              </h3>
              <p className="text-[11px] text-[#C9C9D1] mt-1 truncate">
                {t('episodeCountBadge', { count: series.episode_count })} · {coverVideo?.owner?.display_name || series.owner?.display_name || ''}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
