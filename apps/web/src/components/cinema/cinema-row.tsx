'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { VideoSummary, SeriesSummary } from '@winkey/api-client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from '../../i18n/routing';
import { CinemaCard } from './cinema-card';
import { CinemaSeriesCard } from './cinema-series-card';
import type { WatchSurface } from '../../lib/video/watch-url';
import { useTranslations } from 'next-intl';

export type CinemaRowItem =
  | { kind: 'video'; video: VideoSummary }
  | { kind: 'series'; series: SeriesSummary; coverVideo?: VideoSummary | null };

export interface CinemaRowProps {
  title: string;
  surface: WatchSurface;
  fetchVideos?: () => Promise<VideoSummary[]>;
  initialVideos?: VideoSummary[];
  fetchItems?: () => Promise<CinemaRowItem[]>;
  initialItems?: CinemaRowItem[];
  progressMap?: Record<string, number>; // videoId -> progress percentage (0-100)
  onRemoveItem?: (videoId: string) => void;
  onOpenDetail: (videoId: string) => void;
  onOpenSeries?: (playlistId: string) => void;
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
  fetchItems,
  initialItems,
  progressMap,
  onRemoveItem,
  onOpenDetail,
  onOpenSeries,
  viewAllHref,
  isTop10 = false,
  minVideos = 1,
  testId,
}: CinemaRowProps) {
  const t = useTranslations('cinema');
  const [items, setItems] = useState<CinemaRowItem[]>(() => {
    if (initialItems) return initialItems;
    if (initialVideos) return initialVideos.map((v) => ({ kind: 'video' as const, video: v }));
    return [];
  });
  const [isLoading, setIsLoading] = useState(
    !initialItems && !initialVideos && (!!fetchItems || !!fetchVideos),
  );
  const [hasLoaded, setHasLoaded] = useState(!!initialItems || !!initialVideos);
  const [hasError, setHasError] = useState(false);

  const rowRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Sync initialItems / initialVideos if passed
  useEffect(() => {
    if (initialItems) {
      setItems(initialItems);
      setIsLoading(false);
      setHasLoaded(true);
    } else if (initialVideos) {
      setItems(initialVideos.map((v) => ({ kind: 'video' as const, video: v })));
      setIsLoading(false);
      setHasLoaded(true);
    }
  }, [initialItems, initialVideos]);

  // Lazy load row data when within 400px of viewport
  useEffect(() => {
    if (hasLoaded || (!fetchItems && !fetchVideos)) return;

    let isMounted = true;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          observer.disconnect();
          setIsLoading(true);
          const fetchPromise = fetchItems
            ? fetchItems()
            : fetchVideos!().then((vids) =>
                vids.map((v) => ({ kind: 'video' as const, video: v })),
              );

          fetchPromise
            .then((data) => {
              if (isMounted) {
                setItems(data.slice(0, 20));
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
  }, [fetchItems, fetchVideos, hasLoaded, title]);

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
  }, [items, updateScrollButtons]);

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
  if (hasLoaded && items.length < minVideos) return null;

  const isEditorial = surface === 'playlist';

  return (
    <section
      ref={rowRef}
      aria-label={title}
      data-testid={testId || 'cinema-row'}
      className={`relative group/row ${
        isEditorial
          ? 'mx-4 sm:mx-8 md:mx-12 my-3 p-6 sm:p-8 rounded-2xl bg-[#14141A]'
          : 'my-6 px-4 sm:px-8 md:px-12'
      }`}
    >
      {/* Row Header */}
      <div className="flex items-baseline justify-between mb-3 px-1">
        <div className="flex items-baseline gap-3.5">
          <h2 className="text-lg sm:text-xl md:text-[22px] font-bold text-[#F4F4F6] tracking-tight">
            {title}
          </h2>
          {viewAllHref && (
            <Link
              href={viewAllHref}
              className="text-xs sm:text-sm text-[#8FB4FF] hover:text-[#B8CEFF] font-semibold transition-colors flex items-center gap-0.5"
            >
              <span>{t('viewAll')}</span>
              <span>›</span>
            </Link>
          )}
        </div>
      </div>

      {/* Row Container with Scroll Buttons */}
      <div className="relative">
        {/* Left Scroll Button (Desktop) */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => handleScroll('left')}
            aria-label="Cuộn sang trái"
            className="hidden md:flex absolute left-0 top-0 bottom-0 z-30 w-12 items-center justify-center bg-[#0A0A0D]/60 hover:bg-[#0A0A0D]/85 text-white transition-opacity"
          >
            <ChevronLeft className="h-7 w-7" />
          </button>
        )}

        {/* Horizontal Scroller */}
        <div
          ref={scrollContainerRef}
          data-testid="cinema-row-scroller"
          className={`flex overflow-x-auto scroll-smooth snap-x snap-mandatory scrollbar-none py-3 px-1 ${
            isTop10 ? 'gap-5' : 'gap-3'
          }`}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {isLoading
            ? Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="shrink-0 snap-start w-[calc((100vw-48px)/2.2)] sm:w-[calc((100vw-72px)/3.5)] lg:w-[calc((100vw-120px)/5.5)] max-w-[280px]"
                >
                  <div className="aspect-video w-full rounded-[6px] bg-[#1A1A21] animate-pulse" />
                  <div className="h-3 w-3/4 rounded bg-[#24242D] animate-pulse mt-2.5" />
                </div>
              ))
            : items.map((entry, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === items.length - 1;

                if (entry.kind === 'series') {
                  return (
                    <div
                      key={entry.series.playlist_id}
                      className="shrink-0 snap-start w-[calc((100vw-48px)/2.2)] sm:w-[calc((100vw-72px)/3.5)] lg:w-[calc((100vw-120px)/5.5)] max-w-[280px]"
                    >
                      <CinemaSeriesCard
                        series={entry.series}
                        coverVideo={entry.coverVideo}
                        onOpenSeries={onOpenSeries || (() => {})}
                        isFirst={isFirst}
                        isLast={isLast}
                      />
                    </div>
                  );
                }

                const video = entry.video;
                const progress = progressMap?.[video.id];

                if (isTop10) {
                  return (
                    <div
                      key={video.id}
                      className="shrink-0 snap-start flex items-end w-[240px] sm:w-[280px] md:w-[312px]"
                    >
                      {/* Top 10 168px Outlined Numeral matching Main.dc.html */}
                      <span
                        data-testid="cinema-top10-rank"
                        aria-hidden="true"
                        style={{
                          fontSize: 'clamp(110px, 12vw, 168px)',
                          lineHeight: 0.8,
                          fontWeight: 800,
                          fontFamily:
                            "var(--font-be-vietnam-pro), 'Be Vietnam Pro', system-ui, sans-serif",
                          color: '#0A0A0D',
                          WebkitTextStroke: '3px #5C5C68',
                          letterSpacing: '-12px',
                          marginRight: '-18px',
                          flex: '0 0 auto',
                          position: 'relative',
                          zIndex: 0,
                          userSelect: 'none',
                        }}
                      >
                        {idx + 1}
                      </span>

                      <div
                        style={{
                          position: 'relative',
                          zIndex: 1,
                          flex: '1 1 auto',
                          minWidth: 0,
                        }}
                      >
                        <CinemaCard
                          video={video}
                          surface={surface}
                          rank={idx + 1}
                          progressPercent={progress}
                          onRemove={onRemoveItem ? () => onRemoveItem(video.id) : undefined}
                          onOpenDetail={onOpenDetail}
                          isFirst={isFirst}
                          isLast={isLast}
                        />
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={video.id}
                    className="shrink-0 snap-start w-[calc((100vw-48px)/2.2)] sm:w-[calc((100vw-72px)/3.5)] lg:w-[calc((100vw-120px)/5.5)] max-w-[280px]"
                  >
                    <CinemaCard
                      video={video}
                      surface={surface}
                      progressPercent={progress}
                      onRemove={onRemoveItem ? () => onRemoveItem(video.id) : undefined}
                      onOpenDetail={onOpenDetail}
                      isFirst={isFirst}
                      isLast={isLast}
                    />
                  </div>
                );
              })}
        </div>

        {/* Right Scroll Button (Desktop) */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => handleScroll('right')}
            aria-label="Cuộn sang phải"
            className="hidden md:flex absolute right-0 top-0 bottom-0 z-30 w-12 items-center justify-center bg-[#0A0A0D]/60 hover:bg-[#0A0A0D]/85 text-white transition-opacity"
          >
            <ChevronRight className="h-7 w-7" />
          </button>
        )}
      </div>
    </section>
  );
}
