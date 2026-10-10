'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Video, SeriesEpisodeContext } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { VideoPlayer } from '../video/video-player';
import { RelatedVideosColumn } from '../video/related-videos-column';
import { WatchClientSection } from '../../app/[locale]/watch/[id]/watch-client';
import {
  WatchSeriesEpisodeColumn,
  WatchSeriesEpisodesList,
} from './watch-series-column';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface WatchLayoutProps {
  video: Video;
  initialPlaylistId?: string;
  commentsSlot?: React.ReactNode;
}

export function WatchLayout({ video, initialPlaylistId, commentsSlot }: WatchLayoutProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('watch');

  const playlistId = searchParams.get('playlist') || initialPlaylistId || null;

  const [seriesContext, setSeriesContext] = useState<SeriesEpisodeContext | null>(null);
  const [isSeriesActive, setIsSeriesActive] = useState<boolean>(false);

  // Fetch series episode context when playlistId or video.id changes
  useEffect(() => {
    const pid = playlistId;
    if (!pid) {
      setSeriesContext(null);
      setIsSeriesActive(false);
      return;
    }

    let cancelled = false;

    async function checkSeriesContext(activePlaylistId: string) {
      try {
        const res = await api.social.GET('/v1/series/{playlist_id}/episodes/{video_id}', {
          params: {
            path: { playlist_id: activePlaylistId, video_id: video.id },
          },
        });

        if (cancelled) return;

        // On 404: play normally without series UI and strip playlist from URL with replaceState
        if (res.response.status === 404 || res.error) {
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.has('playlist')) {
              url.searchParams.delete('playlist');
              const search = url.searchParams.toString();
              const newUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
              window.history.replaceState(window.history.state, '', newUrl);
            }
          }
          setSeriesContext(null);
          setIsSeriesActive(false);
          return;
        }

        if (res.data) {
          setSeriesContext(res.data);
          setIsSeriesActive(true);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[WatchLayout] Series context check failed:', err);
          // On network/error 404, fallback to normal video
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.has('playlist')) {
              url.searchParams.delete('playlist');
              const search = url.searchParams.toString();
              const newUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
              window.history.replaceState(window.history.state, '', newUrl);
            }
          }
          setSeriesContext(null);
          setIsSeriesActive(false);
        }
      }
    }

    void checkSeriesContext(pid);

    return () => {
      cancelled = true;
    };
  }, [playlistId, video.id]);

  // Navigate to previous episode
  const handlePrev = useCallback(() => {
    if (seriesContext?.previous_video_id && playlistId) {
      router.push(
        buildWatchUrl(seriesContext.previous_video_id, 'playlist', {
          playlist: playlistId,
        }),
      );
    }
  }, [seriesContext?.previous_video_id, playlistId, router]);

  // Navigate to next episode
  const handleNext = useCallback(() => {
    if (seriesContext?.next_video_id && playlistId) {
      router.push(
        buildWatchUrl(seriesContext.next_video_id, 'playlist', {
          playlist: playlistId,
        }),
      );
    }
  }, [seriesContext?.next_video_id, playlistId, router]);

  // Keyboard navigation shortcuts: N (next) and P (previous)
  useEffect(() => {
    if (!isSeriesActive || !seriesContext) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const key = e.key?.toLowerCase();
      const code = e.code;

      if (key === 'n' || code === 'KeyN') {
        if (seriesContext.next_video_id) {
          e.preventDefault();
          handleNext();
        }
      } else if (key === 'p' || code === 'KeyP') {
        if (seriesContext.previous_video_id) {
          e.preventDefault();
          handlePrev();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSeriesActive, seriesContext, handleNext, handlePrev]);

  return (
    <div className="w-full max-w-[1800px] mx-auto grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {/* Main player + Video Info + Mobile episodes + Comments */}
      <div className="lg:col-span-2 xl:col-span-3 flex flex-col gap-4">
        {/* Player with Poster - key ensures unmount & session cleanup on episode change */}
        <VideoPlayer
          key={video.id}
          videoId={video.id}
          durationMs={video.duration_ms}
          src={video.playback?.hls_url}
          poster={video.playback?.thumbnail_url}
          title={video.title}
          renditions={video.playback?.renditions}
          subtitles={video.playback?.subtitles}
          storyboardUrl={video.playback?.storyboard_url}
          expiresAt={video.playback?.expires_at}
          surface={isSeriesActive ? 'playlist' : undefined}
        />

        {/* Series Navigation Bar (under player, when series is active) */}
        {isSeriesActive && seriesContext && (
          <div
            data-testid="series-navigation-bar"
            className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 border border-zinc-800 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-gray-900 dark:text-white truncate text-sm sm:text-base">
                {seriesContext.series.title}
              </span>
              <span className="shrink-0 px-2 py-0.5 rounded-md bg-zinc-800 text-xs font-semibold text-zinc-300">
                {t('episodeNumber', { number: seriesContext.episode_number })} /{' '}
                {seriesContext.series.episode_count}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handlePrev}
                disabled={!seriesContext.previous_video_id}
                data-testid="series-prev-episode-btn"
                aria-label={t('previousEpisode')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-xs font-semibold text-white transition cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{t('previousEpisode')}</span>
              </button>

              <button
                type="button"
                onClick={handleNext}
                disabled={!seriesContext.next_video_id}
                data-testid="series-next-episode-btn"
                aria-label={t('nextEpisode')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-xs font-semibold text-white transition cursor-pointer disabled:cursor-not-allowed"
              >
                <span className="hidden sm:inline">{t('nextEpisode')}</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Video Title */}
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white leading-tight">
          {video.title}
        </h1>

        {/* Client Interactive Section (Owner info, Subscribe, Like, Description) */}
        <WatchClientSection video={video} />

        {/* Mobile Episode List (under player and description, on screens < lg) */}
        {isSeriesActive && seriesContext && playlistId && (
          <div
            data-testid="series-mobile-episodes-list"
            className="lg:hidden flex flex-col gap-3 rounded-2xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 border border-zinc-800 p-4"
          >
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">
                {t('episodesList')} ({seriesContext.series.episode_count})
              </h2>
            </div>
            <WatchSeriesEpisodesList
              playlistId={playlistId}
              currentVideoId={video.id}
              context={seriesContext}
              isMobile
            />
          </div>
        )}

        {/* Comments Section */}
        {commentsSlot}
      </div>

      {/* Desktop Column:
          - If series is active: Series Episode Column on the right in place of "Xem tiếp"
          - If series is not active: Related Videos Column ("Xem tiếp")
      */}
      <div className="lg:col-span-1 xl:col-span-1 lg:row-span-2">
        {isSeriesActive && seriesContext && playlistId ? (
          <WatchSeriesEpisodeColumn
            playlistId={playlistId}
            currentVideoId={video.id}
            context={seriesContext}
            className="hidden lg:flex"
          />
        ) : (
          <RelatedVideosColumn videoId={video.id} />
        )}
      </div>
    </div>
  );
}
