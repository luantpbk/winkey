'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { SeriesSummary, SeriesEpisode, VideoSummary } from '@winkey/api-client';
import { Play, Plus, Share2, X, Loader2 } from 'lucide-react';
import { api } from '../../lib/api-client';
import { Link, useRouter } from '../../i18n/routing';
import { formatDuration } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

export interface CinemaSeriesDialogProps {
  playlistId: string | null;
  onClose: () => void;
}

interface HydratedEpisode {
  episode: SeriesEpisode;
  video: VideoSummary | null;
}

export function CinemaSeriesDialog({ playlistId, onClose }: CinemaSeriesDialogProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [series, setSeries] = useState<SeriesSummary | null>(null);
  const [coverVideo, setCoverVideo] = useState<VideoSummary | null>(null);
  const [episodes, setEpisodes] = useState<HydratedEpisode[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Save the opener active element to return focus when closed
  useEffect(() => {
    if (playlistId) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
    }
  }, [playlistId]);

  // Load first page of series episodes and hydrate with one batch call
  useEffect(() => {
    if (!playlistId) {
      setSeries(null);
      setCoverVideo(null);
      setEpisodes([]);
      setNextCursor(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    async function loadInitial() {
      try {
        const epRes = await api.social.GET('/v1/series/{playlist_id}/episodes', {
          params: { path: { playlist_id: playlistId! }, query: { limit: 20 } },
        });

        if (!isMounted) return;

        if (!epRes.data) {
          setIsLoading(false);
          return;
        }

        const seriesData = epRes.data.series;
        const rawEpisodes = epRes.data.items || [];
        const next = epRes.data.next_cursor || null;

        setSeries(seriesData);
        setNextCursor(next);

        if (rawEpisodes.length > 0) {
          // ONE batchGetVideos call for the first page
          const ids = rawEpisodes.map((e) => e.video_id);
          // Also ensure first_video_id is included for cover if needed
          if (seriesData.first_video_id && !ids.includes(seriesData.first_video_id)) {
            ids.push(seriesData.first_video_id);
          }

          const batchRes = await api.video.GET('/v1/videos/batch', {
            params: { query: { ids } },
            querySerializer: { array: { style: 'form', explode: false } },
          });

          if (!isMounted) return;

          const batchVideos = batchRes.data?.items || [];
          const videoMap = new Map(batchVideos.map((v) => [v.id, v]));

          if (seriesData.first_video_id) {
            setCoverVideo(videoMap.get(seriesData.first_video_id) || null);
          }

          const hydrated: HydratedEpisode[] = rawEpisodes.map((ep) => ({
            episode: ep,
            video: videoMap.get(ep.video_id) || null,
          }));

          setEpisodes(hydrated);
        } else {
          setEpisodes([]);
        }
      } catch (err) {
        console.warn('[CinemaSeriesDialog] Failed to load series episodes:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadInitial();

    return () => {
      isMounted = false;
    };
  }, [playlistId]);

  // Load more episodes pagination
  const handleLoadMore = useCallback(async () => {
    if (!playlistId || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);

    try {
      const epRes = await api.social.GET('/v1/series/{playlist_id}/episodes', {
        params: {
          path: { playlist_id: playlistId },
          query: { cursor: nextCursor, limit: 20 },
        },
      });

      const rawEpisodes = epRes.data?.items || [];
      const next = epRes.data?.next_cursor || null;
      setNextCursor(next);

      if (rawEpisodes.length > 0) {
        const ids = rawEpisodes.map((e) => e.video_id);
        const batchRes = await api.video.GET('/v1/videos/batch', {
          params: { query: { ids } },
          querySerializer: { array: { style: 'form', explode: false } },
        });

        const batchVideos = batchRes.data?.items || [];
        const videoMap = new Map(batchVideos.map((v) => [v.id, v]));

        const newHydrated: HydratedEpisode[] = rawEpisodes.map((ep) => ({
          episode: ep,
          video: videoMap.get(ep.video_id) || null,
        }));

        setEpisodes((prev) => [...prev, ...newHydrated]);
      }
    } catch (err) {
      console.warn('[CinemaSeriesDialog] Failed to load more episodes:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [playlistId, nextCursor, isLoadingMore]);

  // Focus trap & Escape key handler
  useEffect(() => {
    if (!playlistId) return;

    dialogRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable || focusable.length === 0) return;

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousActiveElementRef.current?.focus?.();
    };
  }, [playlistId, onClose]);

  if (!playlistId) return null;

  const handleShare = async () => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/?series=${encodeURIComponent(playlistId)}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast({ title: t('linkCopied'), type: 'success' });
    } catch {
      showToast({ title: url, type: 'info' });
    }
  };

  const handleWatchLater = async () => {
    if (!series) return;
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await addToWatchLater(series.first_video_id, { showToast });
  };

  const coverThumbnailUrl = getThumbnailUrl(
    coverVideo?.thumbnail_url || null,
    coverVideo && 'playback' in coverVideo ? (coverVideo as { playback?: { thumbnail_url?: string } }).playback?.thumbnail_url : null,
  );

  const watchFirstEpisodeHref = series
    ? `${buildWatchUrl(series.first_video_id, 'playlist')}&playlist=${encodeURIComponent(series.playlist_id)}`
    : '#';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="series-dlg-title"
      data-testid="cinema-series-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/70 backdrop-blur-sm overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-[880px] max-h-[92vh] overflow-y-auto rounded-xl bg-[#16161D] text-[#F4F4F6] shadow-[0_30px_80px_rgba(0,0,0,0.7)] border border-white/10 outline-none"
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          data-testid="cinema-series-close-btn"
          className="absolute top-4 right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-[#0A0A0D] hover:bg-white/20 text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {isLoading && !series ? (
          <div className="p-8 space-y-4">
            <div className="aspect-video w-full rounded-xl bg-[#1D1D25] animate-pulse" />
            <div className="h-6 w-3/4 rounded bg-[#1D1D25] animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-[#1D1D25] animate-pulse" />
          </div>
        ) : series ? (
          <>
            {/* Header Backdrop Banner: 16:9 */}
            <div className="relative aspect-video max-h-[460px] w-full overflow-hidden bg-black">
              <img
                src={coverThumbnailUrl}
                alt={series.title}
                loading="eager"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#16161D] via-[#16161D]/50 to-transparent" />

              {/* Title & Action Buttons overlay */}
              <div className="absolute bottom-8 left-8 right-8 flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <span
                    data-testid="series-dialog-badge"
                    className="px-2.5 py-0.5 rounded-full bg-red-600 text-xs font-bold text-white uppercase tracking-wider"
                  >
                    {t('seriesBadge')}
                  </span>
                  <span className="text-sm font-semibold text-[#C9C9D1]">
                    {t('episodeCountBadge', { count: series.episode_count })}
                  </span>
                </div>

                <h2
                  id="series-dlg-title"
                  data-testid="cinema-series-title"
                  style={{ textWrap: 'balance', lineHeight: 1.08 }}
                  className="text-2xl sm:text-3xl md:text-[44px] font-extrabold text-[#F4F4F6] tracking-[-1px] line-clamp-2 drop-shadow-md"
                >
                  {series.title}
                </h2>

                <div className="flex items-center gap-3 flex-wrap">
                  {/* Primary button: "Xem ngay" opens episode 1 */}
                  <Link
                    href={watchFirstEpisodeHref}
                    data-testid="cinema-series-watch-btn"
                    className="h-12 px-6 rounded-lg bg-white hover:bg-[#E4E4E8] text-[#0A0A0D] font-bold text-base inline-flex items-center gap-2.5 shadow-md transition active:scale-[0.98]"
                  >
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                    <span>{t('watchNow')}</span>
                  </Link>

                  {/* Watch Later Round Button */}
                  <button
                    type="button"
                    onClick={handleWatchLater}
                    data-testid="cinema-series-watch-later-btn"
                    aria-label={t('watchLater')}
                    className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  {/* Share Round Button */}
                  <button
                    type="button"
                    onClick={handleShare}
                    data-testid="cinema-series-share-btn"
                    aria-label={t('share')}
                    className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
                  >
                    <Share2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Dialog Info Grid */}
            <div className="p-8 sm:p-10 grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Left Column (2fr): Description */}
              <div className="md:col-span-2 space-y-4">
                <div className="text-base text-[#D4D4DA] leading-[1.65] whitespace-pre-line">
                  {series.description || t('noDescription')}
                </div>
              </div>

              {/* Right Column (1fr): Channel & Stats */}
              <div className="space-y-3 text-sm text-[#F4F4F6] border-t md:border-t-0 md:border-l border-white/10 pt-4 md:pt-0 md:pl-6">
                <div>
                  <span className="text-[#8E8E99]">Kênh: </span>
                  <Link
                    href={`/c/${series.owner.handle}`}
                    className="font-semibold text-[#8FB4FF] hover:underline"
                  >
                    {series.owner.display_name}
                  </Link>
                </div>
                <div>
                  <span className="text-[#8E8E99]">Số tập: </span>
                  <span className="font-semibold text-white">
                    {t('episodeCountBadge', { count: series.episode_count })}
                  </span>
                </div>
              </div>
            </div>

            {/* Episode List */}
            <div className="px-8 sm:px-10 pb-10 pt-2 border-t border-white/10">
              <h3 className="text-xl font-bold text-[#F4F4F6] mb-4 pt-4">
                {t('episodesList')}
              </h3>

              <div
                data-testid="cinema-series-episodes-list"
                className="flex flex-col gap-3"
              >
                {episodes.map(({ episode, video }) => {
                  const epThumb = getThumbnailUrl(
                    video?.thumbnail_url || null,
                    video && 'playback' in video ? (video as { playback?: { thumbnail_url?: string } }).playback?.thumbnail_url : null,
                  );
                  const epHref = `${buildWatchUrl(episode.video_id, 'playlist')}&playlist=${encodeURIComponent(series.playlist_id)}`;

                  return (
                    <Link
                      key={episode.video_id}
                      href={epHref}
                      data-testid={`series-episode-item-${episode.episode_number}`}
                      className="group flex items-center gap-4 p-3 rounded-xl bg-[#1D1D25] hover:bg-[#262630] transition-colors"
                    >
                      {/* Episode Number */}
                      <span className="w-8 text-center text-sm font-bold text-[#A3A3AD] group-hover:text-white transition-colors">
                        {episode.episode_number}
                      </span>

                      {/* Thumbnail */}
                      <div className="relative aspect-video w-32 sm:w-40 shrink-0 rounded-lg overflow-hidden bg-black/40">
                        <img
                          src={epThumb}
                          alt={video?.title || t('episode', { number: episode.episode_number })}
                          loading="lazy"
                          className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                        />
                        {video?.duration_ms && (
                          <div className="absolute bottom-1 right-1 rounded bg-[#0A0A0D]/80 px-1 py-0.5 text-[10px] font-semibold text-white">
                            {formatDuration(video.duration_ms)}
                          </div>
                        )}
                      </div>

                      {/* Info: Title & Duration */}
                      <div className="flex flex-col min-w-0 flex-1">
                        <h4 className="text-sm font-semibold text-[#F4F4F6] line-clamp-2 leading-snug group-hover:text-[#8FB4FF] transition-colors">
                          {video?.title || t('episode', { number: episode.episode_number })}
                        </h4>
                        <p className="text-xs text-[#A3A3AD] mt-1">
                          {t('episode', { number: episode.episode_number })}
                        </p>
                      </div>

                      {/* Play action icon */}
                      <div className="p-2 rounded-full text-white/50 group-hover:text-white group-hover:bg-white/10 transition">
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      </div>
                    </Link>
                  );
                })}
              </div>

              {/* Load More Episodes Button */}
              {nextCursor && (
                <div className="pt-6 text-center">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={isLoadingMore}
                    data-testid="series-load-more-btn"
                    className="px-6 py-2 rounded-full bg-white/10 hover:bg-white/20 text-xs font-semibold text-white transition disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <span>{t('loadMoreEpisodes')}</span>
                  </button>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
