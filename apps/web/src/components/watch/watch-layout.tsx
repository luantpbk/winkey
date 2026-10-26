'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { Video, SeriesEpisodeContext } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { VideoPlayer } from '../video/video-player';
import { RelatedVideosColumn } from '../video/related-videos-column';
import { WatchClientSection } from '../../app/[locale]/watch/[id]/watch-client';
import { WatchSeriesEpisodeColumn, WatchSeriesEpisodesList } from './watch-series-column';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { ChevronLeft, ChevronRight, ChevronDown, Play } from 'lucide-react';

export interface WatchLayoutProps {
  video: Video;
  initialPlaylistId?: string;
  commentsSlot?: React.ReactNode;
}

export function WatchLayout({ video, initialPlaylistId, commentsSlot }: WatchLayoutProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('watch');

  // Sync / live refresh video from client cache or API
  const { data: currentVideo = video } = useQuery<Video>({
    queryKey: ['video', video.id],
    queryFn: async () => {
      const res = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: video.id } },
      });
      return (res.data as Video) || video;
    },
    initialData: video,
    initialDataUpdatedAt: 0,
  });

  const playlistParam = searchParams.get('playlist') || initialPlaylistId || null;

  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(playlistParam);
  const [seriesContext, setSeriesContext] = useState<SeriesEpisodeContext | null>(null);
  const [isSeriesActive, setIsSeriesActive] = useState<boolean>(false);
  const [isMobileListOpen, setIsMobileListOpen] = useState<boolean>(true);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);

  // Fetch or automatically resolve series context when playlistParam or video.id changes
  useEffect(() => {
    let cancelled = false;

    // Reset countdown when video or playlist changes
    setAutoplayCountdown(null);

    async function resolveAndLoad() {
      let pid = playlistParam;

      if (!pid) {
        // CIN3 (ADR-045): No ?playlist= in URL. Try resolving public series for this video
        try {
          const res = await api.social.GET('/v1/series', {
            params: {
              query: { video_id: video.id },
            },
          });

          if (cancelled) return;

          const items = res.data?.items;
          if (items && items.length > 0 && items[0].playlist_id) {
            pid = items[0].playlist_id;
            setActivePlaylistId(pid);

            // Add ?playlist= to address bar via replaceState (no new history entry)
            if (typeof window !== 'undefined') {
              const url = new URL(window.location.href);
              url.searchParams.set('playlist', pid);
              const search = url.searchParams.toString();
              const newUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
              window.history.replaceState(window.history.state, '', newUrl);
            }
          } else {
            // No series found -> keep related videos column
            setActivePlaylistId(null);
            setSeriesContext(null);
            setIsSeriesActive(false);
            return;
          }
        } catch (err) {
          if (!cancelled) {
            console.warn('[WatchLayout] Failed to query series for video:', err);
            setActivePlaylistId(null);
            setSeriesContext(null);
            setIsSeriesActive(false);
          }
          return;
        }
      } else {
        setActivePlaylistId(pid);
      }

      // Now fetch series episode context for pid
      try {
        const res = await api.social.GET('/v1/series/{playlist_id}/episodes/{video_id}', {
          params: {
            path: { playlist_id: pid, video_id: video.id },
          },
        });

        if (cancelled) return;

        // Only strip playlist from URL when API explicitly returns 404
        if (res.response?.status === 404) {
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.has('playlist')) {
              url.searchParams.delete('playlist');
              const search = url.searchParams.toString();
              const newUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
              window.history.replaceState(window.history.state, '', newUrl);
            }
          }
          setActivePlaylistId(null);
          setSeriesContext(null);
          setIsSeriesActive(false);
          return;
        }

        if (res.data) {
          setSeriesContext(res.data);
          setIsSeriesActive(true);
        } else {
          // 5xx or non-404 error: fallback to normal playback, hide series UI, but keep ?playlist= in URL
          setActivePlaylistId(null);
          setSeriesContext(null);
          setIsSeriesActive(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[WatchLayout] Series context check failed:', err);
          setActivePlaylistId(null);
          setSeriesContext(null);
          setIsSeriesActive(false);
        }
      }
    }

    void resolveAndLoad();

    return () => {
      cancelled = true;
    };
  }, [playlistParam, video.id]);

  // Navigate to previous episode
  const handlePrev = useCallback(() => {
    if (seriesContext?.previous_video_id && activePlaylistId) {
      router.push(
        buildWatchUrl(seriesContext.previous_video_id, 'playlist', {
          playlist: activePlaylistId,
        }),
      );
    }
  }, [seriesContext?.previous_video_id, activePlaylistId, router]);

  // Navigate to next episode
  const handleNext = useCallback(() => {
    if (seriesContext?.next_video_id && activePlaylistId) {
      router.push(
        buildWatchUrl(seriesContext.next_video_id, 'playlist', {
          playlist: activePlaylistId,
        }),
      );
    }
  }, [seriesContext?.next_video_id, activePlaylistId, router]);

  // Autoplay next episode trigger (ADR-045, CIN3)
  const handleEpisodeEnded = useCallback(() => {
    if (!isSeriesActive || !seriesContext?.next_video_id) return;
    try {
      const optOut = localStorage.getItem('winkey.autoplay_next_episode');
      if (optOut === 'false') return;
    } catch {
      // ignore localStorage errors (e.g. private browsing or restricted quota)
    }
    setAutoplayCountdown(5);
  }, [isSeriesActive, seriesContext?.next_video_id]);

  const handleCancelAutoplay = useCallback(() => {
    setAutoplayCountdown(null);
  }, []);

  const handlePlayNextNow = useCallback(() => {
    setAutoplayCountdown(null);
    handleNext();
  }, [handleNext]);

  // Autoplay countdown timer
  useEffect(() => {
    if (autoplayCountdown === null) return;
    if (autoplayCountdown <= 0) {
      setAutoplayCountdown(null);
      handleNext();
      return;
    }

    const timer = setTimeout(() => {
      setAutoplayCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);

    return () => clearTimeout(timer);
  }, [autoplayCountdown, handleNext]);

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

  // Mobile collapsible episode list slot (ADR-045, CIN3)
  const mobileEpisodesSlot =
    isSeriesActive && seriesContext && activePlaylistId ? (
      <div
        data-testid="series-mobile-episodes-list"
        className="lg:hidden flex flex-col rounded-2xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 border border-zinc-800 p-4"
      >
        <button
          type="button"
          onClick={() => setIsMobileListOpen((open) => !open)}
          data-testid="series-mobile-episodes-toggle"
          aria-expanded={isMobileListOpen}
          className="flex items-center justify-between w-full text-left cursor-pointer group"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-gray-900 dark:text-white truncate">
              {t('episodesList')} • {t('episodeNumber', { number: seriesContext.episode_number })} /{' '}
              {seriesContext.series.episode_count}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-xs text-zinc-400">
            <span>{isMobileListOpen ? t('collapse') : t('expand')}</span>
            <ChevronDown
              className={`h-4 w-4 text-zinc-400 transition-transform duration-200 shrink-0 ${
                isMobileListOpen ? 'rotate-180' : ''
              }`}
            />
          </div>
        </button>

        {isMobileListOpen && (
          <div className="pt-3 mt-2 border-t border-zinc-800">
            <WatchSeriesEpisodesList
              playlistId={activePlaylistId}
              currentVideoId={video.id}
              context={seriesContext}
              isMobile
            />
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="w-full max-w-[1800px] mx-auto grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {/* Main player + Video Info + Mobile episodes + Comments */}
      <div className="lg:col-span-2 xl:col-span-3 flex flex-col gap-4">
        {/* Player with Poster - key ensures unmount & session cleanup on episode change */}
        <div className="relative rounded-2xl overflow-hidden bg-black">
          <VideoPlayer
            key={video.id}
            videoId={video.id}
            durationMs={video.duration_ms}
            src={video.playback?.hls_url}
            hlsAv1Url={video.playback?.hls_av1_url}
            poster={video.playback?.thumbnail_url}
            title={video.title}
            renditions={video.playback?.renditions}
            subtitles={video.playback?.subtitles}
            audioTracks={video.playback?.audio_tracks}
            storyboardUrl={video.playback?.storyboard_url}
            expiresAt={video.playback?.expires_at}
            surface={isSeriesActive ? 'playlist' : undefined}
            onEnded={handleEpisodeEnded}
          />

          {/* Autoplay Next Episode Countdown Overlay (ADR-045, CIN3) */}
          {autoplayCountdown !== null && seriesContext?.next_video_id && (
            <div
              data-testid="autoplay-next-countdown-overlay"
              className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm p-6 text-white text-center"
            >
              <p className="text-sm sm:text-base text-zinc-300 font-medium mb-1">
                {t('nextEpisodeIn')}
              </p>
              <div
                data-testid="autoplay-countdown-seconds"
                className="text-4xl sm:text-5xl font-extrabold mb-5 font-mono text-red-500"
              >
                {autoplayCountdown}s
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCancelAutoplay}
                  data-testid="cancel-autoplay-btn"
                  className="min-h-11 px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-sm font-semibold text-white transition cursor-pointer"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={handlePlayNextNow}
                  data-testid="play-next-now-btn"
                  className="min-h-11 px-5 py-2 rounded-full bg-red-600 hover:bg-red-700 text-sm font-semibold text-white transition flex items-center gap-2 cursor-pointer"
                >
                  <Play className="h-4 w-4 fill-current" />
                  <span>{t('playNow')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

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
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-xs font-semibold text-white transition cursor-pointer disabled:cursor-not-allowed"
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
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-xs font-semibold text-white transition cursor-pointer disabled:cursor-not-allowed"
              >
                <span className="hidden sm:inline">{t('nextEpisode')}</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Video Title */}
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white leading-tight">
          {currentVideo.title}
        </h1>

        {/* Client Interactive Section (Owner info, Subscribe, Like, Action Row, Mobile Episodes Slot, Description) */}
        <WatchClientSection video={currentVideo} mobileEpisodesSlot={mobileEpisodesSlot} />

        {/* Comments Section */}
        {commentsSlot}
      </div>

      {/* Desktop Column:
          - If series is active: Series Episode Column on the right in place of "Xem tiếp"
          - If series is not active: Related Videos Column ("Xem tiếp")
      */}
      <div className="lg:col-span-1 xl:col-span-1 lg:row-span-2">
        {isSeriesActive && seriesContext && activePlaylistId ? (
          <WatchSeriesEpisodeColumn
            playlistId={activePlaylistId}
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
