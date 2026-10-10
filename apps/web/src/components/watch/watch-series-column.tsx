'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { VideoSummary, SeriesEpisode, SeriesEpisodeContext } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { Link } from '../../i18n/routing';
import { formatDuration } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { useTranslations } from 'next-intl';
import { Play, Loader2 } from 'lucide-react';

interface HydratedEpisode {
  episode: SeriesEpisode;
  video: VideoSummary;
}

export interface WatchSeriesColumnProps {
  playlistId: string;
  currentVideoId: string;
  context: SeriesEpisodeContext;
  className?: string;
  isMobile?: boolean;
}

export function WatchSeriesEpisodesList({
  playlistId,
  currentVideoId,
  context: _context,
  className = '',
  isMobile = false,
}: WatchSeriesColumnProps) {
  const t = useTranslations('watch');
  const [episodes, setEpisodes] = useState<HydratedEpisode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const activeItemRef = useRef<HTMLAnchorElement>(null);

  // Load first page of episodes
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    async function loadEpisodes() {
      try {
        const epRes = await api.social.GET('/v1/series/{playlist_id}/episodes', {
          params: {
            path: { playlist_id: playlistId },
            query: { limit: 48 },
          },
        });

        if (cancelled) return;
        const rawEpisodes = epRes.data?.items || [];
        setNextCursor(epRes.data?.next_cursor || null);

        if (rawEpisodes.length > 0) {
          const ids = rawEpisodes.map((e) => e.video_id);
          const batchRes = await api.video.GET('/v1/videos/batch', {
            params: { query: { ids } },
            querySerializer: { array: { style: 'form', explode: false } },
          });

          if (cancelled) return;
          const batchVideos = batchRes.data?.items || [];
          const videoMap = new Map(batchVideos.map((v) => [v.id, v]));

          // Drop items omitted by batch
          const hydrated: HydratedEpisode[] = [];
          for (const ep of rawEpisodes) {
            const v = videoMap.get(ep.video_id);
            if (v) {
              hydrated.push({ episode: ep, video: v });
            }
          }
          setEpisodes(hydrated);
        } else {
          setEpisodes([]);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[WatchSeries] Failed to load episodes:', err);
          setEpisodes([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadEpisodes();

    return () => {
      cancelled = true;
    };
  }, [playlistId]);

  // Scroll active item into view when episodes are loaded or currentVideoId changes
  useEffect(() => {
    if (!isLoading && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isLoading, currentVideoId, episodes]);

  // Load more episodes
  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);

    try {
      const epRes = await api.social.GET('/v1/series/{playlist_id}/episodes', {
        params: {
          path: { playlist_id: playlistId },
          query: { cursor: nextCursor, limit: 48 },
        },
      });

      const rawEpisodes = epRes.data?.items || [];
      setNextCursor(epRes.data?.next_cursor || null);

      if (rawEpisodes.length > 0) {
        const ids = rawEpisodes.map((e) => e.video_id);
        const batchRes = await api.video.GET('/v1/videos/batch', {
          params: { query: { ids } },
          querySerializer: { array: { style: 'form', explode: false } },
        });

        const batchVideos = batchRes.data?.items || [];
        const videoMap = new Map(batchVideos.map((v) => [v.id, v]));

        const newHydrated: HydratedEpisode[] = [];
        for (const ep of rawEpisodes) {
          const v = videoMap.get(ep.video_id);
          if (v) {
            newHydrated.push({ episode: ep, video: v });
          }
        }
        setEpisodes((prev) => [...prev, ...newHydrated]);
      }
    } catch (err) {
      console.warn('[WatchSeries] Failed to load more episodes:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-zinc-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        className={`flex flex-col gap-2 ${
          isMobile ? 'max-h-[420px] overflow-y-auto pr-1' : 'flex-1 overflow-y-auto pr-1'
        }`}
      >
        {episodes.map(({ episode, video }) => {
          const isActive = episode.video_id === currentVideoId;
          const href = buildWatchUrl(episode.video_id, 'playlist', { playlist: playlistId });
          const thumbUrl = getThumbnailUrl(video.thumbnail_url);

          return (
            <Link
              key={episode.video_id}
              href={href}
              ref={isActive ? activeItemRef : undefined}
              data-testid={`series-episode-item-${episode.video_id}`}
              data-active={isActive ? 'true' : undefined}
              className={`group flex items-center gap-3 p-2 rounded-xl transition border ${
                isActive
                  ? 'bg-red-950/30 border-red-600/60 shadow-sm'
                  : 'bg-zinc-900/40 border-transparent hover:bg-zinc-800/70 hover:border-zinc-700/50'
              }`}
            >
              {/* Thumbnail 16:9 */}
              <div className="relative aspect-video w-32 sm:w-36 shrink-0 rounded-lg overflow-hidden bg-zinc-800">
                <img
                  src={thumbUrl}
                  alt={video.title}
                  loading="lazy"
                  className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                />
                <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {formatDuration(video.duration_ms)}
                </span>
                {isActive && (
                  <div
                    data-testid="active-series-episode"
                    className="absolute inset-0 bg-black/40 flex items-center justify-center text-red-500"
                  >
                    <Play className="h-5 w-5 fill-current" />
                  </div>
                )}
              </div>

              {/* Episode Info */}
              <div className="flex flex-col flex-1 min-w-0 py-0.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-bold ${
                      isActive ? 'text-red-500' : 'text-zinc-400 group-hover:text-zinc-200'
                    }`}
                  >
                    {t('episodeNumber', { number: episode.episode_number })}
                  </span>
                  {isActive && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-red-600/30 text-red-400 border border-red-500/30">
                      {t('currentEpisode')}
                    </span>
                  )}
                </div>
                <h3 className="text-xs sm:text-sm font-semibold text-zinc-200 line-clamp-2 mt-0.5 group-hover:text-white transition">
                  {video.title}
                </h3>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Pagination "Tải thêm" */}
      {nextCursor && (
        <button
          type="button"
          onClick={handleLoadMore}
          disabled={isLoadingMore}
          data-testid="load-more-episodes-btn"
          className="mt-2 w-full py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 hover:text-white transition flex items-center justify-center gap-1.5"
        >
          {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>Tải thêm</span>
        </button>
      )}
    </div>
  );
}

export function WatchSeriesEpisodeColumn({
  playlistId,
  currentVideoId,
  context,
  className = '',
}: {
  playlistId: string;
  currentVideoId: string;
  context: SeriesEpisodeContext;
  className?: string;
}) {
  return (
    <aside
      data-testid="series-episodes-column"
      aria-label="Danh sách tập phim"
      className={`flex flex-col rounded-2xl bg-zinc-900/70 border border-zinc-800 p-4 max-h-[calc(100vh-100px)] sticky top-20 overflow-hidden shadow-xl backdrop-blur-sm ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-zinc-800 mb-3">
        <div className="flex flex-col min-w-0">
          <h2 className="text-base font-bold text-white truncate">{context.series.title}</h2>
          <span className="text-xs text-zinc-400 font-medium">
            {context.series.episode_count} tập
          </span>
        </div>
      </div>

      {/* Episodes List */}
      <WatchSeriesEpisodesList
        playlistId={playlistId}
        currentVideoId={currentVideoId}
        context={context}
        className="flex-1 overflow-hidden"
      />
    </aside>
  );
}
