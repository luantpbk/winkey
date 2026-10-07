'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { VideoSummary } from '@winkey/api-client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from '../../i18n/routing';
import { CinemaCard } from './cinema-card';
import type { WatchSurface } from '../../lib/video/watch-url';
import { useTranslations } from 'next-intl';

export interface CinemaRowProps {
  title: string;
  surface: WatchSurface;
  fetchVideos?: () => Promise<VideoSummary[]>;
  initialVideos?: VideoSummary[];
  progressMap?: Record<string, number>; // videoId -> progress percentage (0-100)
  onRemoveItem?: (videoId: string) => void;
  onOpenDetail: (videoId: string) => void;
  viewAllHref?: string;
  isTop10?: boolean;
  minVideos?: number;
  testId?: string;
}

export function CinemaRow({
  title,
  surface,
  fetchVideos,
  initialVideos,
  progressMap,
  onRemoveItem,
  onOpenDetail,
  viewAllHref,
  isTop10 = false,
  minVideos = 1,
  testId,
}: CinemaRowProps) {
  const t = useTranslations('cinema');
  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos || []);
  const [isLoading, setIsLoading] = useState(!initialVideos && !!fetchVideos);
  const [hasLoaded, setHasLoaded] = useState(!!initialVideos);
  const [hasError, setHasError] = useState(false);

  const rowRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Sync initialVideos if passed
  useEffect(() => {
    if (initialVideos) {
      setVideos(initialVideos);
      setIsLoading(false);
      setHasLoaded(true);
    }
  }, [initialVideos]);

  // Lazy load row data when within 400px of viewport
  useEffect(() => {
    if (hasLoaded || !fetchVideos) return;

    let isMounted = true;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          observer.disconnect();
          setIsLoading(true);
          fetchVideos()
            .then((data) => {
              if (isMounted) {
                setVideos(data.slice(0, 20));
                setHasLoaded(true);
                setIsLoading(false);
              }
            })
            .catch((err) => {
              console.warn(`[CinemaRow] Failed to load "${title}":`, err);
              if (isMounted) {
                setHasError(true);
                setIsLoading(false);
              }
            });
        }
      },
      { rootMargin: '400px' },
    );

    if (rowRef.current) {
      observer.observe(rowRef.current);
    }

    return () => {
      isMounted = false;
      observer.disconnect();
    };
  }, [fetchVideos, hasLoaded, title]);

  // Check scroll buttons visibility
  const updateScrollButtons = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  useEffect(() => {
    updateScrollButtons();
    const el = scrollContainerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollButtons, { passive: true });
    window.addEventListener('resize', updateScrollButtons);
    return () => {
      el.removeEventListener('scroll', updateScrollButtons);
      window.removeEventListener('resize', updateScrollButtons);
    };
  }, [videos, updateScrollButtons]);

  const handleScroll = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.8;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  // If load failed, or loaded and fewer than minVideos: hide row completely
  if (hasError) return null;
  if (hasLoaded && videos.length < minVideos) return null;

  return (
    <section
      ref={rowRef}
      aria-label={title}
      data-testid={testId || 'cinema-row'}
      className="relative my-6 px-4 sm:px-8 group/row"
    >
      {/* Row Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-white tracking-tight">
          {title}
        </h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="text-xs sm:text-sm text-red-500 hover:text-red-400 font-semibold transition-colors flex items-center gap-1"
          >
            <span>{t('viewAll')}</span>
            <ChevronRight className="h-4 w-4" />
          </Link>
        )}
      </div>

      {/* Row Container with Scroll Buttons */}
      <div className="relative">
        {/* Left Scroll Button (Desktop) */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => handleScroll('left')}
            aria-label="Scroll left"
            className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 z-20 h-10 w-10 -ml-4 items-center justify-center rounded-full bg-black/80 hover:bg-black text-white shadow-xl transition-all"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Horizontal Scroller */}
        <div
          ref={scrollContainerRef}
          data-testid="cinema-row-scroller"
          className="flex gap-3 overflow-x-auto scroll-smooth snap-x snap-mandatory scrollbar-none py-4 px-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {isLoading
            ? Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="shrink-0 snap-start w-[calc((100vw-48px)/2.2)] md:w-[calc((100vw-96px)/3.5)] lg:w-[calc((100vw-120px)/5.5)]"
                >
                  <div className="aspect-video w-full rounded-lg bg-[#181822] animate-pulse" />
                  <div className="h-3 w-3/4 rounded bg-gray-800 animate-pulse mt-2" />
                </div>
              ))
            : videos.map((video, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === videos.length - 1;
                const progress = progressMap?.[video.id];

                return (
                  <div
                    key={video.id}
                    className="shrink-0 snap-start flex items-center w-[calc((100vw-48px)/2.2)] md:w-[calc((100vw-96px)/3.5)] lg:w-[calc((100vw-120px)/5.5)]"
                  >
                    {/* Top 10 Outlined Numeral */}
                    {isTop10 && (
                      <span
                        data-testid="cinema-top10-rank"
                        className="text-5xl sm:text-6xl lg:text-7xl font-black text-transparent select-none shrink-0 -mr-3 sm:-mr-4 z-0 [text-shadow:_0_0_1px_rgba(255,255,255,0.4)] [-webkit-text-stroke:2px_rgba(255,255,255,0.4)]"
                      >
                        {idx + 1}
                      </span>
                    )}

                    <div className="flex-1 w-full">
                      <CinemaCard
                        video={video}
                        surface={surface}
                        rank={isTop10 ? idx + 1 : undefined}
                        progressPercent={progress}
                        onRemove={onRemoveItem ? () => onRemoveItem(video.id) : undefined}
                        onOpenDetail={onOpenDetail}
                        isFirst={isFirst}
                        isLast={isLast}
                      />
                    </div>
                  </div>
                );
              })}
        </div>

        {/* Right Scroll Button (Desktop) */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => handleScroll('right')}
            aria-label="Scroll right"
            className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 z-20 h-10 w-10 -mr-4 items-center justify-center rounded-full bg-black/80 hover:bg-black text-white shadow-xl transition-all"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </section>
  );
}
