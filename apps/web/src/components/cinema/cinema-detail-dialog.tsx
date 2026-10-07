'use client';

import React, { useEffect, useState, useRef } from 'react';
import type { Video, VideoSummary } from '@winkey/api-client';
import { Play, Plus, Share2, X, ThumbsUp } from 'lucide-react';
import { api } from '../../lib/api-client';
import { Link, useRouter } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { type WatchSurface, buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

export interface CinemaDetailDialogProps {
  videoId: string | null;
  surface?: WatchSurface;
  onClose: () => void;
  onSelectVideo: (newVideoId: string) => void;
}

export function CinemaDetailDialog({
  videoId,
  surface = 'other',
  onClose,
  onSelectVideo,
}: CinemaDetailDialogProps) {
  const t = useTranslations('cinema');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [video, setVideo] = useState<Video | null>(null);
  const [relatedVideos, setRelatedVideos] = useState<VideoSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Save the opener active element to return focus when closed
  useEffect(() => {
    if (videoId) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
    }
  }, [videoId]);

  // Load video detail and related videos when videoId changes
  useEffect(() => {
    if (!videoId) {
      setVideo(null);
      setRelatedVideos([]);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    Promise.all([
      api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: videoId } },
      }),
      api.video.GET('/v1/videos/{video_id}/related', {
        params: { path: { video_id: videoId }, query: { limit: 12 } },
      }),
    ])
      .then(([detailRes, relatedRes]) => {
        if (!isMounted) return;
        setVideo((detailRes.data as Video) || null);
        setRelatedVideos((relatedRes.data?.items as VideoSummary[]) || []);
        setIsLoading(false);
      })
      .catch((err) => {
        console.warn('[CinemaDetailDialog] Failed to fetch video:', err);
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [videoId]);

  // Focus trap & Escape key handler
  useEffect(() => {
    if (!videoId) return;

    // Focus the dialog container
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
      // Return focus to the opener element
      previousActiveElementRef.current?.focus?.();
    };
  }, [videoId, onClose]);

  if (!videoId) return null;

  const handleShare = async () => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/watch/${videoId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast({ title: t('linkCopied'), type: 'success' });
    } catch {
      showToast({ title: url, type: 'info' });
    }
  };

  const handleWatchLater = async () => {
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    await addToWatchLater(videoId, { showToast });
  };

  const thumbnailUrl = video
    ? getThumbnailUrl(
        'thumbnail_url' in video
          ? (video as { thumbnail_url?: string | null }).thumbnail_url
          : null,
        video.playback?.thumbnail_url || null,
      )
    : '';

  const watchHref = buildWatchUrl(videoId, surface);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-title"
      data-testid="cinema-detail-dialog"
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
        {/* Close Button: 40px circle #0A0A0D */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          data-testid="cinema-detail-close-btn"
          className="absolute top-4 right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-[#0A0A0D] hover:bg-white/20 text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {isLoading && !video ? (
          <div className="p-8 space-y-4">
            <div className="aspect-video w-full rounded-xl bg-[#1D1D25] animate-pulse" />
            <div className="h-6 w-3/4 rounded bg-[#1D1D25] animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-[#1D1D25] animate-pulse" />
          </div>
        ) : video ? (
          <>
            {/* Header Backdrop Banner: 16:9 */}
            <div className="relative aspect-video max-h-[460px] w-full overflow-hidden bg-black">
              <img
                src={thumbnailUrl}
                alt={video.title}
                loading="eager"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#16161D] via-[#16161D]/50 to-transparent" />

              {/* Title & Action Buttons overlay */}
              <div className="absolute bottom-8 left-8 right-8 flex flex-col gap-4">
                <h2
                  id="dlg-title"
                  data-testid="cinema-detail-title"
                  style={{ textWrap: 'balance', lineHeight: 1.08 }}
                  className="text-2xl sm:text-3xl md:text-[44px] font-extrabold text-[#F4F4F6] tracking-[-1px] line-clamp-2 drop-shadow-md"
                >
                  {video.title}
                </h2>

                <div className="flex items-center gap-3 flex-wrap">
                  {/* Primary button: White with dark text */}
                  <Link
                    href={watchHref}
                    data-testid="cinema-detail-watch-btn"
                    className="h-12 px-6 rounded-lg bg-white hover:bg-[#E4E4E8] text-[#0A0A0D] font-bold text-base inline-flex items-center gap-2.5 shadow-md transition active:scale-[0.98]"
                  >
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                    <span>{t('watchNow')}</span>
                  </Link>

                  {/* Watch Later Round Button */}
                  <button
                    type="button"
                    onClick={handleWatchLater}
                    data-testid="cinema-detail-watch-later-btn"
                    aria-label={t('watchLater')}
                    className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  {/* Like Button */}
                  <button
                    type="button"
                    aria-label="Thích"
                    className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
                  >
                    <ThumbsUp className="w-5 h-5" />
                  </button>

                  {/* Share Round Button */}
                  <button
                    type="button"
                    onClick={handleShare}
                    data-testid="cinema-detail-share-btn"
                    aria-label={t('share')}
                    className="w-12 h-12 rounded-full border-[1.5px] border-white/55 bg-[#0A0A0D]/35 hover:bg-white/12 text-white inline-flex items-center justify-center transition active:scale-[0.98]"
                  >
                    <Share2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Dialog Content Grid (2 columns matching Detail.dc.html) */}
            <div className="p-8 sm:p-10 grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Left Column (2fr): Meta + Description */}
              <div className="md:col-span-2 space-y-4">
                <div className="flex items-center gap-2.5 text-sm text-[#C9C9D1] flex-wrap">
                  <span className="text-[#4ADE80] font-bold">Thịnh hành</span>
                  <span aria-hidden="true" className="text-[#8E8E99]">
                    ·
                  </span>
                  <span>{formatDuration(video.duration_ms)}</span>
                  <span aria-hidden="true" className="text-[#8E8E99]">
                    ·
                  </span>
                  <span>{formatViews(video.view_count)} lượt xem</span>
                  <span aria-hidden="true" className="text-[#8E8E99]">
                    ·
                  </span>
                  <span>{formatRelativeTime(video.published_at)}</span>
                  <span className="px-1.5 py-0.5 rounded border border-white/40 text-xs font-bold">
                    1080p
                  </span>
                </div>

                {/* Description: full text with preserved line breaks, plain text links */}
                <div className="text-base text-[#D4D4DA] leading-[1.65] whitespace-pre-line pt-2">
                  {video.description || t('noDescription')}
                </div>
              </div>

              {/* Right Column (1fr): Channel, Date, Info */}
              <div className="space-y-3 text-sm text-[#F4F4F6] border-t md:border-t-0 md:border-l border-white/10 pt-4 md:pt-0 md:pl-6">
                <div>
                  <span className="text-[#8E8E99]">Kênh: </span>
                  <Link
                    href={`/c/${video.owner.handle}`}
                    className="font-semibold text-[#8FB4FF] hover:underline"
                  >
                    {video.owner.display_name}
                  </Link>
                </div>
                <div>
                  <span className="text-[#8E8E99]">Đăng ngày: </span>
                  <span>
                    {video.published_at
                      ? new Date(video.published_at).toLocaleDateString('vi-VN', {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                        })
                      : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Related Videos: "Tương tự" (3-column grid matching Detail.dc.html) */}
            {relatedVideos.length > 0 && (
              <div className="px-8 sm:px-10 pb-10 pt-2 border-t border-white/10">
                <h3 className="text-xl font-bold text-[#F4F4F6] mb-4 pt-4">{t('similarVideos')}</h3>
                <div
                  data-testid="cinema-detail-related-grid"
                  className="grid grid-cols-2 sm:grid-cols-3 gap-4"
                >
                  {relatedVideos.map((item) => {
                    const itemThumb = getThumbnailUrl(
                      'thumbnail_url' in item ? item.thumbnail_url : null,
                    );
                    return (
                      <div
                        key={item.id}
                        onClick={() => onSelectVideo(item.id)}
                        data-testid="cinema-related-card"
                        className="group cursor-pointer rounded-lg overflow-hidden bg-[#1D1D25] hover:bg-[#262630] transition-colors"
                      >
                        <div className="relative aspect-video w-full bg-black/40">
                          <img
                            src={itemThumb}
                            alt={item.title}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                          <div className="absolute bottom-1.5 right-1.5 rounded bg-[#0A0A0D]/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            {formatDuration(item.duration_ms)}
                          </div>
                        </div>
                        <div className="p-3">
                          <h4 className="text-sm font-semibold text-[#F4F4F6] line-clamp-2 leading-snug">
                            {item.title}
                          </h4>
                          <p className="text-xs text-[#A3A3AD] mt-1 truncate">
                            {item.owner.display_name} · {formatViews(item.view_count)} lượt xem
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
