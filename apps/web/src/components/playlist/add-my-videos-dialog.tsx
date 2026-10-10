'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { StudioVideo } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { useTranslations } from 'next-intl';
import { formatDuration } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { X, Search, Loader2, AlertCircle, ArrowUpDown } from 'lucide-react';

export interface AddMyVideosDialogProps {
  playlistId: string;
  isSeries?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  existingVideoIds?: Set<string>;
}

export function AddMyVideosDialog({
  playlistId,
  isSeries: _isSeries = false,
  isOpen,
  onClose,
  onSuccess,
  existingVideoIds = new Set(),
}: AddMyVideosDialogProps) {
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const t = useTranslations('library');

  const [videos, setVideos] = useState<StudioVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc'); // Default oldest -> newest (created_at)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addingProgress, setAddingProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load caller's studio videos
  useEffect(() => {
    if (!isOpen || !isAuthenticated) return;

    let cancelled = false;
    setLoading(true);
    setSearchTerm('');
    setSelectedVideoIds(new Set());
    setSubmitErrors([]);
    setAddingProgress(null);

    api.video
      .GET('/v1/studio/videos', {
        params: { query: { limit: 50 } },
      })
      .then((res) => {
        if (cancelled) return;
        const allItems = res.data?.items || [];
        // Only READY videos
        const readyVideos = allItems.filter((v) => v.status === 'READY');
        setVideos(readyVideos);
        setNextCursor(res.data?.next_cursor || null);
      })
      .catch((err) => {
        console.error('Failed to load studio videos:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, isAuthenticated]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  // Load more videos
  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const res = await api.video.GET('/v1/studio/videos', {
        params: { query: { limit: 50, cursor: nextCursor } },
      });
      const newItems = res.data?.items || [];
      const newReady = newItems.filter((v) => v.status === 'READY');
      setVideos((prev) => [...prev, ...newReady]);
      setNextCursor(res.data?.next_cursor || null);
    } catch (err) {
      console.error('Failed to load more studio videos:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Sort videos by created_at: default asc (oldest -> newest), toggleable to desc (newest -> oldest)
  const sortedVideos = useMemo(() => {
    return [...videos].sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      return sortDirection === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }, [videos, sortDirection]);

  // Filtered videos by search query
  const filteredVideos = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return sortedVideos;
    return sortedVideos.filter((v) => v.title.toLowerCase().includes(q));
  }, [sortedVideos, searchTerm]);

  if (!isOpen) return null;

  const toggleSelect = (videoId: string) => {
    if (isSubmitting) return;
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (isSubmitting) return;
    const visibleUnadded = filteredVideos.filter((v) => !existingVideoIds.has(v.id));
    if (selectedVideoIds.size >= visibleUnadded.length) {
      setSelectedVideoIds(new Set());
    } else {
      setSelectedVideoIds(new Set(visibleUnadded.map((v) => v.id)));
    }
  };

  const handleAddVideos = async () => {
    if (selectedVideoIds.size === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitErrors([]);

    // Preserve the order of videos strictly as sorted (oldest -> newest or newest -> oldest)
    const orderedToInsert = sortedVideos.filter((v) => selectedVideoIds.has(v.id));
    const errors: string[] = [];
    let successCount = 0;

    // Sequential: add one by one, no parallel workers, updating progress live
    for (let i = 0; i < orderedToInsert.length; i++) {
      const video = orderedToInsert[i];
      setAddingProgress({ current: i + 1, total: orderedToInsert.length });

      try {
        const res = await api.social.POST('/v1/playlists/{playlist_id}/items', {
          params: { path: { playlist_id: playlistId } },
          body: { video_id: video.id },
        });

        if (res.error) {
          const errData = res.error as { code?: string; title?: string } | undefined;
          if (errData?.code === 'SERIES_FOREIGN_ITEM') {
            errors.push(`"${video.title}": Bộ phim chỉ chứa video của chính kênh bạn.`);
          } else if (errData?.code === 'PLAYLIST_FULL') {
            errors.push(`"${video.title}": Danh sách phát đã đầy (tối đa 5.000 video).`);
          } else {
            errors.push(`"${video.title}": ${errData?.title || 'Không thể thêm video.'}`);
          }
        } else {
          successCount++;
        }
      } catch {
        errors.push(`"${video.title}": Lỗi kết nối khi thêm.`);
      }
    }

    setIsSubmitting(false);
    setAddingProgress(null);

    if (errors.length > 0) {
      setSubmitErrors(errors);
      errors.forEach((msg) => {
        showToast({ title: msg, type: 'error' });
      });
    }

    if (successCount > 0) {
      showToast({
        title: `Đã thêm thành công ${successCount} video vào danh sách phát`,
        type: 'success',
      });
      onSuccess();
      if (errors.length === 0) {
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-my-videos-title"
      data-testid="add-my-videos-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in"
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl text-white overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <div>
            <h2 id="add-my-videos-title" className="text-lg font-bold text-white">
              {t('selectMyVideos')}
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Chọn các video sẵn sàng (READY) từ kênh của bạn để thêm vào danh sách.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Đóng"
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search bar, sort toggle & quick select */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 p-4 border-b border-zinc-800/80 bg-zinc-950/40">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              disabled={isSubmitting}
              data-testid="video-picker-search-input"
              placeholder={t('searchVideosPlaceholder')}
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-zinc-800/80 border border-zinc-700/80 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition disabled:opacity-50"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              disabled={isSubmitting}
              data-testid="toggle-sort-direction"
              title={sortDirection === 'asc' ? t('sortOldestFirst') : t('sortNewestFirst')}
              className="shrink-0 flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition"
            >
              <ArrowUpDown className="h-3.5 w-3.5 text-zinc-400" />
              <span>{sortDirection === 'asc' ? t('sortOldestFirst') : t('sortNewestFirst')}</span>
            </button>

            {filteredVideos.length > 0 && (
              <button
                type="button"
                onClick={handleSelectAll}
                disabled={isSubmitting}
                className="shrink-0 text-xs text-zinc-300 hover:text-white px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition"
              >
                {selectedVideoIds.size >= filteredVideos.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
              </button>
            )}
          </div>
        </div>

        {/* Error notification if any */}
        {submitErrors.length > 0 && (
          <div className="p-3 bg-red-950/70 border-b border-red-800 text-xs text-red-300 flex flex-col gap-1 max-h-32 overflow-y-auto">
            <div className="flex items-center gap-1.5 font-bold text-red-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Có {submitErrors.length} video không thể thêm:</span>
            </div>
            {submitErrors.map((err, idx) => (
              <span key={idx} className="pl-5">
                • {err}
              </span>
            ))}
          </div>
        )}

        {/* Videos list */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 min-h-[300px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-400 gap-2">
              <Loader2 className="h-7 w-7 animate-spin text-red-500" />
              <span className="text-xs">Đang tải video của bạn...</span>
            </div>
          ) : filteredVideos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center text-zinc-500">
              <p className="text-sm font-medium">{t('noVideosFound')}</p>
              {searchTerm && (
                <p className="text-xs text-zinc-600 mt-1">Thử tìm kiếm với từ khóa khác.</p>
              )}
            </div>
          ) : (
            filteredVideos.map((video) => {
              const isSelected = selectedVideoIds.has(video.id);
              const isAlreadyIn = existingVideoIds.has(video.id);
              const thumbUrl = getThumbnailUrl(video.thumbnail_url);

              return (
                <div
                  key={video.id}
                  data-testid={`video-picker-item-${video.id}`}
                  onClick={() => !isAlreadyIn && !isSubmitting && toggleSelect(video.id)}
                  className={`flex items-center gap-3 p-2.5 rounded-xl border transition cursor-pointer ${
                    isAlreadyIn
                      ? 'bg-zinc-950/40 border-zinc-800/40 opacity-50 cursor-not-allowed'
                      : isSelected
                        ? 'bg-red-950/30 border-red-600/70 shadow-sm'
                        : 'bg-zinc-800/40 border-zinc-700/40 hover:bg-zinc-800/70 hover:border-zinc-600/60'
                  }`}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isAlreadyIn || isSubmitting}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => !isAlreadyIn && !isSubmitting && toggleSelect(video.id)}
                    aria-label={`Chọn video ${video.title}`}
                    className="h-4 w-4 rounded border-zinc-600 bg-zinc-700 text-red-600 focus:ring-red-500 cursor-pointer disabled:cursor-not-allowed shrink-0"
                  />

                  {/* Thumbnail */}
                  <div className="relative aspect-video w-24 shrink-0 rounded-lg overflow-hidden bg-zinc-800">
                    <img
                      src={thumbUrl}
                      alt={video.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[9px] font-semibold text-white">
                      {formatDuration(video.duration_ms)}
                    </span>
                  </div>

                  {/* Video Info */}
                  <div className="flex flex-col flex-1 min-w-0">
                    <h3 className="text-xs sm:text-sm font-semibold text-zinc-200 line-clamp-1">
                      {video.title}
                    </h3>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-zinc-400">
                      {video.duration_ms ? <span>{formatDuration(video.duration_ms)}</span> : null}
                      {isAlreadyIn && (
                        <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 text-[10px]">
                          Đã có trong danh sách
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Load More Button */}
          {nextCursor && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore || isSubmitting}
              className="mt-2 w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 hover:text-white transition flex items-center justify-center gap-2"
            >
              {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{t('loadMore')}</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-zinc-800 bg-zinc-950/60">
          <div className="text-xs text-zinc-400">
            Đã chọn: <span className="font-bold text-white">{selectedVideoIds.size}</span> video
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold transition disabled:opacity-50"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={handleAddVideos}
              disabled={isSubmitting || selectedVideoIds.size === 0}
              data-testid="video-picker-submit-btn"
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-red-600 text-white text-xs font-semibold shadow-lg transition"
            >
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isSubmitting && addingProgress ? (
                <span data-testid="adding-progress-text">
                  {t('addingProgress', {
                    current: addingProgress.current,
                    total: addingProgress.total,
                  })}
                </span>
              ) : (
                <span>
                  {selectedVideoIds.size > 0
                    ? t('addNVideos', { count: selectedVideoIds.size })
                    : 'Thêm video'}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
