'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { Play, Plus, Info, Volume2, VolumeX } from 'lucide-react';
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

export interface CinemaHeroProps {
  onOpenDetail: (videoId: string) => void;
  initialVideos?: VideoSummary[];
  initialSortSource?: 'trending' | 'latest';
}

export function CinemaHero({
  onOpenDetail,
  initialVideos,
  initialSortSource = 'trending',
}: CinemaHeroProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos || []);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isFallback, setIsFallback] = useState(initialSortSource === 'latest');
  const [isLoading, setIsLoading] = useState(!initialVideos || initialVideos.length === 0);
  const [isPaused, setIsPaused] = useState(false);

  // Lazy description and playback cache: videoId -> Video
  const [videoCache, setVideoCache] = useState<Record<string, Video>>({});

  // Muted preview state
  const [previewActive, setPreviewActive] = useState(false);
  const [previewFadedIn, setPreviewFadedIn] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

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
    setIsMuted(true);
  }, []);

  // 1. Fetch hero videos on mount if not provided via props
  useEffect(() => {
    if (initialVideos && initialVideos.length > 0) {
      setVideos(initialVideos);
      setIsFallback(initialSortSource === 'latest');
      setIsLoading(false);
      return;
    }

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
  }, [initialVideos, initialSortSource]);

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

  const toggleMute = () => {
    if (!videoElRef.current) return;
    const nextMuted = !isMuted;
    videoElRef.current.muted = nextMuted;
    videoElRef.current.volume = nextMuted ? 0 : 1;
    setIsMuted(nextMuted);
  };

  if (isLoading) {
    return (
      <div
        className="w-full h-[56vw] min-h-[360px] md:h-[70vh] md:min-h-[500px] bg-[#14141A] animate-pulse relative"
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
      aria-roledescription="carousel"
      data-testid="cinema-hero"
      className="relative w-full h-[56vw] min-h-[540px] max-h-[85vh] md:h-[70vh] md:min-h-[560px] overflow-hidden select-none outline-none focus:ring-1 focus:ring-[#FF0033]/50"
    >
      {/* Backdrop image */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        <img
          src={backdropUrl}
          alt={activeVideo.title}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          className="h-full w-full object-cover transform scale-105 transition-transform duration-700 ease-out"
        />

        {/* Muted HLS preview video */}
        {previewActive && (
          <video
            ref={videoElRef}
            muted={isMuted}
            playsInline
            autoPlay
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
              previewFadedIn ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* Gradients to ensure text readability matching Main.dc.html */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0A0A0D] via-[#0A0A0D]/80 to-transparent w-full md:w-3/4 z-10" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0D] via-[#0A0A0D]/60 to-transparent h-full z-10" />
      </div>

      {/* Hero Content Overlay */}
      <div className="absolute inset-0 z-20 flex flex-col justify-end p-6 sm:p-10 md:p-14 max-w-4xl pb-16 sm:pb-20">
        {/* TOP Badge & Trending label */}
        <div className="flex items-center gap-2.5 mb-2">
          <span className="inline-flex items-center justify-center h-[26px] px-2 rounded bg-[#FF0033] text-white text-[13px] font-extrabold tracking-wide">
            TOP {activeIndex + 1}
          </span>
          <span className="text-[15px] font-semibold text-[#F4F4F6]">
            {isFallback ? 'Mới cập nhật' : 'Thịnh hành hôm nay'}
          </span>
        </div>

        {/* Title: 2-line clamp with room for top diacritics and bottom descenders (fixes "Ấ", "Ợ", "dựng", "Streaming") */}
        <h1
          data-testid="cinema-hero-title"
          style={{ textWrap: 'balance', lineHeight: 1.18 }}
          className="text-2xl sm:text-4xl md:text-5xl lg:text-[56px] font-extrabold text-[#F4F4F6] tracking-[-1.5px] line-clamp-2 pt-1 mb-3 drop-shadow-md"
        >
          {activeVideo.title}
        </h1>

        {/* Meta row: channel · duration · views · relative date */}
        <div className="flex items-center gap-2 text-xs sm:text-sm md:text-[15px] text-[#C9C9D1] font-medium flex-wrap mb-3">
          <span className="text-[#F4F4F6] font-semibold">{activeVideo.owner.display_name}</span>
          <span aria-hidden="true" className="text-[#8E8E99]">
            ·
          </span>
          <span>{formatDuration(activeVideo.duration_ms)}</span>
          <span aria-hidden="true" className="text-[#8E8E99]">
            ·
          </span>
          <span>{formatViews(activeVideo.view_count)} lượt xem</span>
          <span aria-hidden="true" className="text-[#8E8E99]">
            ·
          </span>
          <span>{formatRelativeTime(activeVideo.published_at)}</span>
        </div>

        {/* Description (max 3 lines, hidden on mobile per Mobile.dc.html) */}
        {description && (
          <p
            data-testid="cinema-hero-description"
            className="hidden md:block text-xs sm:text-sm md:text-base text-[#D4D4DA] line-clamp-3 mb-6 max-w-2xl font-normal leading-[1.55] drop-shadow"
          >
            {description}
          </p>
        )}

        {/* Action Buttons: Primary white with dark text, ghost, round */}
        <div className="flex items-center gap-2 sm:gap-3 flex-nowrap">
          <Link
            href={watchHref}
            data-testid="cinema-hero-watch-btn"
            className="h-11 sm:h-12 px-3.5 sm:px-6 rounded-lg bg-white hover:bg-[#E4E4E8] text-[#0A0A0D] font-bold text-sm sm:text-base inline-flex items-center justify-center gap-1.5 sm:gap-2.5 shrink-0 transition active:scale-[0.98] shadow-md"
          >
            <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-current ml-0.5" />
            <span className="whitespace-nowrap">{t('watchNow')}</span>
          </Link>

          <button
            type="button"
            onClick={handleWatchLaterClick}
            data-testid="cinema-hero-watch-later-btn"
            className="h-11 sm:h-12 px-3 sm:px-6 rounded-lg bg-[rgba(110,110,125,.42)] hover:bg-[rgba(110,110,125,.6)] text-white font-semibold text-sm sm:text-base backdrop-blur-md inline-flex items-center justify-center gap-1.5 sm:gap-2 shrink-0 transition active:scale-[0.98]"
          >
            <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="whitespace-nowrap">{t('watchLater')}</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenDetail(activeVideo.id)}
            data-testid="cinema-hero-details-btn"
            aria-label={t('details')}
            className="w-11 h-11 sm:w-12 sm:h-12 shrink-0 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
          >
            <Info className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Mute toggle button (bottom right) */}
      {previewActive && (
        <div className="absolute right-6 sm:right-12 bottom-20 sm:bottom-24 z-20 hidden md:flex items-center">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? 'Bật tiếng xem trước' : 'Tắt tiếng xem trước'}
            data-testid="cinema-hero-mute-btn"
            className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition"
          >
            {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
          </button>
        </div>
      )}

      {/* Navigation Dots */}
      {videos.length > 1 && (
        <div
          role="group"
          aria-label="Chọn video nổi bật"
          data-testid="cinema-hero-dots"
          className="absolute left-6 sm:left-10 md:left-14 bottom-6 sm:bottom-8 z-20 flex items-center gap-2"
        >
          {videos.map((vid, idx) => (
            <button
              key={vid.id}
              onClick={() => setActiveIndex(idx)}
              aria-label={`Video nổi bật ${idx + 1} trên ${videos.length}`}
              aria-pressed={idx === activeIndex}
              data-testid={`cinema-hero-dot-${idx}`}
              className={`h-1 rounded-sm transition-all duration-300 ${
                idx === activeIndex ? 'w-10 bg-[#FF0033]' : 'w-4 bg-white/30 hover:bg-white/60'
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
