'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { Play, Plus, Info } from 'lucide-react';
import type { VideoSummary, Video } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { Link, useRouter } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

interface CinemaHeroProps {
  onOpenDetail: (videoId: string) => void;
}

export function CinemaHero({ onOpenDetail }: CinemaHeroProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFallback, setIsFallback] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(false);

  // Lazy description and playback cache: videoId -> Video
  const [videoCache, setVideoCache] = useState<Record<string, Video>>({});

  // Muted preview state
  const [previewActive, setPreviewActive] = useState(false);
  const [previewFadedIn, setPreviewFadedIn] = useState(false);

  const heroRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const previewTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isHeroVisibleRef = useRef(true);

  // Stop muted preview
  const stopPreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (videoElRef.current) {
      videoElRef.current.pause();
      videoElRef.current.src = '';
    }
    setPreviewActive(false);
    setPreviewFadedIn(false);
  }, []);

  // 1. Fetch hero videos: sort=trending&limit=5, fallback to sort=newest&limit=5
  useEffect(() => {
    let isMounted = true;
    async function loadHeroVideos() {
      setIsLoading(true);
      try {
        const res = await api.video.GET('/v1/videos', {
          params: { query: { sort: 'trending', limit: 5 } },
        });
        const items = res.data?.items || [];
        if (items.length > 0) {
          if (isMounted) {
            setVideos(items);
            setIsFallback(false);
            setIsLoading(false);
          }
          return;
        }

        // Fallback to newest if trending is empty
        const fallbackRes = await api.video.GET('/v1/videos', {
          params: { query: { sort: 'newest', limit: 5 } },
        });
        const fallbackItems = fallbackRes.data?.items || [];
        if (isMounted) {
          setVideos(fallbackItems);
          setIsFallback(true);
          setIsLoading(false);
        }
      } catch (err) {
        console.warn('[CinemaHero] Failed to load hero videos:', err);
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    loadHeroVideos();
    return () => {
      isMounted = false;
    };
  }, []);

  const activeVideo: VideoSummary | undefined = videos[activeIndex];

  // 2. Fetch full video details lazily for the active slide (description & playback)
  useEffect(() => {
    if (!activeVideo?.id) return;
    const currentId = activeVideo.id;
    if (videoCache[currentId]) return;

    let isMounted = true;
    api.video
      .GET('/v1/videos/{video_id}', {
        params: { path: { video_id: currentId } },
      })
      .then((res) => {
        if (res.data && isMounted) {
          setVideoCache((prev) => ({ ...prev, [currentId]: res.data as Video }));
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [activeVideo?.id, videoCache]);

  // 3. Auto-advance every 8 s, pauses on hover / focus
  useEffect(() => {
    if (videos.length <= 1 || isPaused) return;

    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % videos.length);
    }, 8000);

    return () => clearInterval(interval);
  }, [videos.length, isPaused]);

  // 4. Muted preview trigger: after active slide is idle for 3s
  useEffect(() => {
    stopPreview();
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (!activeVideo?.id) return;
    const currentId = activeVideo.id;

    idleTimerRef.current = setTimeout(() => {
      // Check constraints:
      // Never play on screens < 768 px
      if (typeof window !== 'undefined' && window.innerWidth < 768) return;

      // Never play with prefers-reduced-motion: reduce
      if (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }

      // Never play with navigator.connection.saveData
      if (
        typeof navigator !== 'undefined' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).connection?.saveData === true
      ) {
        return;
      }

      // Check hero visibility in viewport and tab visibility
      if (!isHeroVisibleRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      // Find hls_url
      const cached = videoCache[currentId];
      if (cached?.playback?.hls_url) {
        startHlsPreview(cached.playback.hls_url);
      } else {
        // Fetch then start
        api.video
          .GET('/v1/videos/{video_id}', {
            params: { path: { video_id: currentId } },
          })
          .then((res) => {
            if (res.data?.playback?.hls_url && activeVideo.id === currentId) {
              setVideoCache((prev) => ({ ...prev, [currentId]: res.data as Video }));
              startHlsPreview(res.data.playback.hls_url);
            }
          })
          .catch(() => {});
      }
    }, 3000);

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      stopPreview();
    };
  }, [activeIndex, activeVideo?.id, stopPreview, videoCache]);

  const startHlsPreview = useCallback(
    (hlsUrl: string) => {
      setPreviewActive(true);
      // Wait for next tick so video element is rendered
      setTimeout(() => {
        const videoEl = videoElRef.current;
        if (!videoEl) return;

        videoEl.muted = true;
        videoEl.volume = 0;

        if (Hls.isSupported()) {
          const hls = new Hls({
            autoStartLoad: true,
            maxBufferLength: 10,
          });
          hlsRef.current = hls;
          hls.loadSource(hlsUrl);
          hls.attachMedia(videoEl);

          hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            // Select lowest rendition
            if (data.levels && data.levels.length > 0) {
              let minIdx = 0;
              let minBitrate = Infinity;
              data.levels.forEach((lvl, idx) => {
                const br = lvl.bitrate || lvl.height || 0;
                if (br < minBitrate) {
                  minBitrate = br;
                  minIdx = idx;
                }
              });
              hls.currentLevel = minIdx;
            }
            videoEl
              .play()
              .then(() => {
                setPreviewFadedIn(true);
              })
              .catch(() => {});
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = hlsUrl;
          videoEl
            .play()
            .then(() => {
              setPreviewFadedIn(true);
            })
            .catch(() => {});
        }

        // Stop preview after 30s
        previewTimerRef.current = setTimeout(() => {
          stopPreview();
        }, 30000);
      }, 50);
    },
    [stopPreview],
  );

  // 5. Visibility and Viewport observers
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopPreview();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        isHeroVisibleRef.current = entry?.isIntersecting ?? true;
        if (!entry?.isIntersecting) {
          stopPreview();
        }
      },
      { threshold: 0.1 },
    );

    if (heroRef.current) {
      observer.observe(heroRef.current);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer.disconnect();
    };
  }, [stopPreview]);

  // Handle keyboard arrow navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (videos.length <= 1) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + videos.length) % videos.length);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % videos.length);
    }
  };

  const handleWatchLaterClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!activeVideo) return;
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await addToWatchLater(activeVideo.id, { showToast });
  };

  if (isLoading) {
    return (
      <div
        className="w-full h-[56vw] min-h-[360px] md:h-[70vh] md:min-h-[500px] bg-[#121218] animate-pulse relative"
        data-testid="cinema-hero-skeleton"
      />
    );
  }

  if (!activeVideo) {
    return null;
  }

  const backdropUrl = getThumbnailUrl(
    'thumbnail_url' in activeVideo ? activeVideo.thumbnail_url : null,
  );
  const watchSurface = isFallback ? 'latest' : 'trending';
  const watchHref = buildWatchUrl(activeVideo.id, watchSurface);
  const activeDetail = videoCache[activeVideo.id];
  const description = activeDetail?.description || '';

  return (
    <section
      ref={heroRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      aria-label="Cinema Featured Hero"
      data-testid="cinema-hero"
      className="relative w-full h-[56vw] min-h-[360px] max-h-[85vh] md:h-[70vh] md:min-h-[500px] overflow-hidden select-none outline-none focus:ring-1 focus:ring-red-600/50"
    >
      {/* Backdrop image */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        <img
          src={backdropUrl}
          alt={activeVideo.title}
          loading="eager"
          decoding="async"
          className="h-full w-full object-cover transform scale-105 transition-transform duration-700 ease-out"
        />

        {/* Muted HLS preview video */}
        {previewActive && (
          <video
            ref={videoElRef}
            muted
            playsInline
            autoPlay
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
              previewFadedIn ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* Gradients to ensure text readability */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0b0b0f] via-[#0b0b0f]/80 to-transparent w-full md:w-3/4 z-10" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0f] via-[#0b0b0f]/60 to-transparent h-full z-10" />
      </div>

      {/* Hero Content Overlay */}
      <div className="absolute inset-0 z-20 flex flex-col justify-end p-6 sm:p-10 md:p-16 max-w-4xl">
        {/* Title */}
        <h1
          data-testid="cinema-hero-title"
          className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-white tracking-tight line-clamp-2 drop-shadow-md mb-3"
        >
          {activeVideo.title}
        </h1>

        {/* Meta row: channel · duration · views · relative date */}
        <div className="flex items-center gap-2 text-xs sm:text-sm md:text-base text-gray-300 font-medium flex-wrap mb-3">
          <span className="text-white font-semibold">{activeVideo.owner.display_name}</span>
          <span className="text-gray-500">•</span>
          <span>{formatDuration(activeVideo.duration_ms)}</span>
          <span className="text-gray-500">•</span>
          <span>{formatViews(activeVideo.view_count)} lượt xem</span>
          <span className="text-gray-500">•</span>
          <span>{formatRelativeTime(activeVideo.published_at)}</span>
        </div>

        {/* Description (max 3 lines, fetched lazily) */}
        {description && (
          <p
            data-testid="cinema-hero-description"
            className="text-xs sm:text-sm md:text-base text-gray-300/90 line-clamp-3 mb-6 max-w-2xl font-normal leading-relaxed drop-shadow"
          >
            {description}
          </p>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={watchHref}
            data-testid="cinema-hero-watch-btn"
            className="flex items-center gap-2 px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm sm:text-base shadow-lg transition-transform active:scale-95"
          >
            <Play className="h-5 w-5 fill-current" />
            <span>{t('watchNow')}</span>
          </Link>

          <button
            type="button"
            onClick={handleWatchLaterClick}
            data-testid="cinema-hero-watch-later-btn"
            className="flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/20 hover:bg-white/30 text-white font-medium text-sm sm:text-base backdrop-blur-md transition-all active:scale-95"
          >
            <Plus className="h-5 w-5" />
            <span>{t('watchLater')}</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenDetail(activeVideo.id)}
            data-testid="cinema-hero-details-btn"
            className="flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium text-sm sm:text-base backdrop-blur-md transition-all active:scale-95"
          >
            <Info className="h-5 w-5" />
            <span>{t('details')}</span>
          </button>
        </div>
      </div>

      {/* Navigation Dots */}
      {videos.length > 1 && (
        <div
          data-testid="cinema-hero-dots"
          className="absolute bottom-4 right-6 sm:right-10 md:right-16 z-20 flex items-center gap-2"
        >
          {videos.map((vid, idx) => (
            <button
              key={vid.id}
              onClick={() => setActiveIndex(idx)}
              aria-label={`Slide ${idx + 1}`}
              data-testid={`cinema-hero-dot-${idx}`}
              className={`h-2 transition-all rounded-full ${
                idx === activeIndex
                  ? 'w-7 bg-red-600 shadow-md'
                  : 'w-2 bg-white/40 hover:bg-white/70'
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
