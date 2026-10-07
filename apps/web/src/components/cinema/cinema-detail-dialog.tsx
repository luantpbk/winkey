'use client';

import React, { useEffect, useState, useRef } from 'react';
import type { Video, VideoSummary } from '@winkey/api-client';
import { Play, Plus, Share2, X } from 'lucide-react';
import { api } from '../../lib/api-client';
import { Link, useRouter } from '../../i18n/routing';
import { formatDuration, formatViews, formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { buildWatchUrl } from '../../lib/video/watch-url';
import { addToWatchLater } from '../../lib/playlist/playlist-utils';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';

export interface CinemaDetailDialogProps {
  videoId: string | null;
  onClose: () => void;
  onSelectVideo: (newVideoId: string) => void;
}

export function CinemaDetailDialog({ videoId, onClose, onSelectVideo }: CinemaDetailDialogProps) {
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
  const watchHref = buildWatchUrl(videoId, 'other');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cinema-detail-title"
      data-testid="cinema-detail-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl bg-[#12121a] text-gray-100 shadow-2xl border border-white/10 outline-none"
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          data-testid="cinema-detail-close-btn"
          className="absolute top-4 right-4 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-black/70 hover:bg-white/20 text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {isLoading && !video ? (
          <div className="p-8 space-y-4">
            <div className="aspect-video w-full rounded-xl bg-gray-800 animate-pulse" />
            <div className="h-6 w-3/4 rounded bg-gray-800 animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-gray-800 animate-pulse" />
          </div>
        ) : video ? (
          <>
            {/* Header Backdrop Banner */}
            <div className="relative aspect-video max-h-[420px] w-full overflow-hidden bg-black">
              <img
                src={thumbnailUrl}
                alt={video.title}
                loading="eager"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#12121a] via-[#12121a]/40 to-transparent" />

              {/* Quick Watch Over Banner */}
              <div className="absolute bottom-6 left-6 right-6 flex items-end justify-between gap-4">
                <div className="space-y-2">
                  <h2
                    id="cinema-detail-title"
                    data-testid="cinema-detail-title"
                    className="text-xl sm:text-2xl md:text-3xl font-black text-white line-clamp-2 drop-shadow"
                  >
                    {video.title}
                  </h2>
                  <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-300 flex-wrap">
                    <Link
                      href={`/c/${video.owner.handle}`}
                      className="font-semibold text-white hover:underline flex items-center gap-2"
                    >
                      {video.owner.avatar_url && (
                        <img
                          src={video.owner.avatar_url}
                          alt={video.owner.display_name}
                          className="h-5 w-5 rounded-full object-cover"
                        />
                      )}
                      <span>{video.owner.display_name}</span>
                    </Link>
                    <span>•</span>
                    <span>{formatDuration(video.duration_ms)}</span>
                    <span>•</span>
                    <span>{formatViews(video.view_count)} lượt xem</span>
                    <span>•</span>
                    <span>{formatRelativeTime(video.published_at)}</span>
                  </div>
                </div>

                <Link
                  href={watchHref}
                  data-testid="cinema-detail-watch-btn"
                  className="flex shrink-0 items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm sm:text-base shadow-lg transition-transform active:scale-95"
                >
                  <Play className="h-5 w-5 fill-current" />
                  <span>{t('watchNow')}</span>
                </Link>
              </div>
            </div>

            {/* Dialog Content */}
            <div className="p-6 sm:p-8 space-y-6">
              {/* Action Buttons Row */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleWatchLater}
                  data-testid="cinema-detail-watch-later-btn"
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium text-sm transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  <span>{t('watchLater')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleShare}
                  data-testid="cinema-detail-share-btn"
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium text-sm transition-colors"
                >
                  <Share2 className="h-4 w-4" />
                  <span>{t('share')}</span>
                </button>
              </div>

              {/* Description */}
              <div className="text-sm sm:text-base text-gray-300 leading-relaxed whitespace-pre-line border-t border-white/10 pt-4">
                {video.description || t('noDescription')}
              </div>

              {/* Related Videos: "Tương tự" */}
              {relatedVideos.length > 0 && (
                <div className="border-t border-white/10 pt-6">
                  <h3 className="text-lg font-bold text-white mb-4">{t('similarVideos')}</h3>
                  <div
                    data-testid="cinema-detail-related-grid"
                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
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
                          className="group cursor-pointer rounded-lg overflow-hidden bg-[#181824] hover:ring-2 hover:ring-red-600 transition-all"
                        >
                          <div className="relative aspect-video w-full bg-black/40">
                            <img
                              src={itemThumb}
                              alt={item.title}
                              loading="lazy"
                              className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                            />
                            <div className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] text-white">
                              {formatDuration(item.duration_ms)}
                            </div>
                          </div>
                          <div className="p-2">
                            <h4 className="text-xs font-semibold text-white line-clamp-1 group-hover:text-red-400">
                              {item.title}
                            </h4>
                            <p className="text-[10px] text-gray-400 truncate mt-0.5">
                              {item.owner.display_name}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
