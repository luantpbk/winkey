'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/api-client';
import { useToast } from '../ui/toast';
import { Link } from '../../i18n/routing';
import { formatRelativeTime } from '../../lib/format';
import {
  Film,
  Search,
  EyeOff,
  RotateCw,
  Trash2,
  AlertCircle,
  Clock,
  User as UserIcon,
  Loader2,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import type { AdminVideo, VideoStatus, Visibility } from '@winkey/api-client';
import { HideVideoDialog } from './hide-video-dialog';
import { DeleteVideoDialog } from './delete-video-dialog';

type ModerationFilter = 'ALL' | 'VISIBLE' | 'HIDDEN';

function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function AdminVideosViewer() {
  const { showToast } = useToast();

  const [videos, setVideos] = useState<AdminVideo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search & Filter state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<VideoStatus | 'ALL'>('ALL');
  const [visibilityFilter, setVisibilityFilter] = useState<Visibility | 'ALL'>('ALL');
  const [moderationFilter, setModerationFilter] = useState<ModerationFilter>('ALL');

  // Dialog targets
  const [hidingVideo, setHidingVideo] = useState<AdminVideo | null>(null);
  const [deletingVideo, setDeletingVideo] = useState<AdminVideo | null>(null);

  // Debounce search input (300ms)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(val.trim());
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Fetch initial videos when filters change
  const fetchVideos = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const queryParams: Record<string, string> = {
        limit: '20',
      };

      if (debouncedQuery.length >= 2) {
        queryParams.q = debouncedQuery;
      }
      if (statusFilter !== 'ALL') {
        queryParams.status = statusFilter;
      }
      if (visibilityFilter !== 'ALL') {
        queryParams.visibility = visibilityFilter;
      }
      if (moderationFilter !== 'ALL') {
        queryParams.moderation_state = moderationFilter;
      }

      const {
        data,
        error: apiErr,
        response,
      } = await api.video.GET('/v1/studio/admin/videos', {
        params: { query: queryParams as any },
      });

      if (!response.ok || apiErr) {
        setError(apiErr?.detail || 'Không thể tải danh sách video.');
        setVideos([]);
        setNextCursor(null);
      } else if (data) {
        setVideos(data.items || []);
        setNextCursor(data.next_cursor ?? null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi kết nối khi tải danh sách video.';
      setError(msg);
      setVideos([]);
      setNextCursor(null);
    } finally {
      setIsLoading(false);
    }
  }, [debouncedQuery, statusFilter, visibilityFilter, moderationFilter]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  // Load more with cursor
  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;

    try {
      setIsLoadingMore(true);

      const queryParams: Record<string, string> = {
        limit: '20',
        cursor: nextCursor,
      };

      if (debouncedQuery.length >= 2) {
        queryParams.q = debouncedQuery;
      }
      if (statusFilter !== 'ALL') {
        queryParams.status = statusFilter;
      }
      if (visibilityFilter !== 'ALL') {
        queryParams.visibility = visibilityFilter;
      }
      if (moderationFilter !== 'ALL') {
        queryParams.moderation_state = moderationFilter;
      }

      const {
        data,
        error: apiErr,
        response,
      } = await api.video.GET('/v1/studio/admin/videos', {
        params: { query: queryParams as any },
      });

      if (!response.ok || apiErr) {
        showToast({
          title: 'Không thể tải thêm video',
          description: apiErr?.detail || 'Lỗi hệ thống',
          type: 'error',
        });
      } else if (data) {
        setVideos((prev) => [...prev, ...(data.items || [])]);
        setNextCursor(data.next_cursor ?? null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi kết nối khi tải thêm video.';
      showToast({ title: 'Không thể tải thêm video', description: msg, type: 'error' });
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Action: Hide video with reason (Optimistic update with rollback)
  const handleHideConfirm = async (reason: string) => {
    if (!hidingVideo) return;
    const targetVideo = hidingVideo;
    const prevVideos = [...videos];

    // Optimistic update
    setVideos((prev) =>
      prev.map((v) =>
        v.id === targetVideo.id
          ? {
              ...v,
              moderation: {
                state: 'HIDDEN',
                reason,
                moderated_at: new Date().toISOString(),
              },
            }
          : v,
      ),
    );

    try {
      const { error: apiErr, response } = await api.video.PUT('/v1/videos/{video_id}/moderation', {
        params: { path: { video_id: targetVideo.id } },
        body: { state: 'HIDDEN', reason },
      });

      if (!response.ok || apiErr) {
        setVideos(prevVideos);
        showToast({
          title: 'Không thể ẩn video',
          description: apiErr?.detail || 'Lỗi hệ thống',
          type: 'error',
        });
      } else {
        showToast({ title: 'Đã ẩn video thành công', type: 'success' });
      }
    } catch (err: unknown) {
      setVideos(prevVideos);
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra khi ẩn video.';
      showToast({ title: 'Không thể ẩn video', description: msg, type: 'error' });
    }
  };

  // Action: Restore video (Optimistic update with rollback)
  const handleRestoreVideo = async (targetVideo: AdminVideo) => {
    const prevVideos = [...videos];

    // Optimistic update
    setVideos((prev) =>
      prev.map((v) =>
        v.id === targetVideo.id
          ? {
              ...v,
              moderation: {
                state: 'VISIBLE',
                reason: null,
                moderated_at: new Date().toISOString(),
              },
            }
          : v,
      ),
    );

    try {
      const { error: apiErr, response } = await api.video.PUT('/v1/videos/{video_id}/moderation', {
        params: { path: { video_id: targetVideo.id } },
        body: { state: 'VISIBLE' },
      });

      if (!response.ok || apiErr) {
        setVideos(prevVideos);
        showToast({
          title: 'Không thể hiện lại video',
          description: apiErr?.detail || 'Lỗi hệ thống',
          type: 'error',
        });
      } else {
        showToast({ title: 'Đã khôi phục hiển thị video', type: 'success' });
      }
    } catch (err: unknown) {
      setVideos(prevVideos);
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra khi hiện lại video.';
      showToast({ title: 'Không thể hiện lại video', description: msg, type: 'error' });
    }
  };

  // Action: Delete video (Optimistic removal with rollback)
  const handleDeleteConfirm = async () => {
    if (!deletingVideo) return;
    const targetVideo = deletingVideo;
    const prevVideos = [...videos];

    // Optimistic removal
    setVideos((prev) => prev.filter((v) => v.id !== targetVideo.id));

    try {
      const { error: apiErr, response } = await api.video.DELETE('/v1/videos/{video_id}', {
        params: { path: { video_id: targetVideo.id } },
      });

      if (!response.ok || apiErr) {
        setVideos(prevVideos);
        showToast({
          title: 'Không thể xóa video',
          description: apiErr?.detail || 'Lỗi hệ thống',
          type: 'error',
        });
      } else {
        showToast({ title: 'Đã xóa video vĩnh viễn', type: 'success' });
      }
    } catch (err: unknown) {
      setVideos(prevVideos);
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra khi xóa video.';
      showToast({ title: 'Không thể xóa video', description: msg, type: 'error' });
    }
  };

  return (
    <div className="space-y-6" data-testid="admin-videos-viewer">
      {/* Search & Filter Bar */}
      <div className="flex flex-col gap-4 bg-[#1f1f1f] border border-[#2e2e2e] p-4 rounded-2xl shadow-sm">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Tìm theo tiêu đề (tối thiểu 2 ký tự)..."
              data-testid="admin-videos-search-input"
              className="w-full h-10 pl-10 pr-4 rounded-xl border border-[#383838] bg-[#141414] text-xs text-white placeholder-gray-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Status Filter */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="status-filter" className="text-xs text-gray-400 whitespace-nowrap">
                Trạng thái:
              </label>
              <select
                id="status-filter"
                aria-label="Lọc theo trạng thái video"
                data-testid="admin-videos-status-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as VideoStatus | 'ALL')}
                className="h-9 rounded-xl border border-[#383838] bg-[#141414] px-3 text-xs text-white focus:border-red-500 focus:outline-none transition cursor-pointer"
              >
                <option value="ALL">Tất cả</option>
                <option value="READY">Sẵn sàng</option>
                <option value="PROCESSING">Đang xử lý</option>
                <option value="UPLOADING">Đang tải lên</option>
                <option value="FAILED">Thất bại</option>
              </select>
            </div>

            {/* Visibility Filter */}
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="visibility-filter"
                className="text-xs text-gray-400 whitespace-nowrap"
              >
                Hiển thị:
              </label>
              <select
                id="visibility-filter"
                aria-label="Lọc theo chế độ hiển thị"
                data-testid="admin-videos-visibility-filter"
                value={visibilityFilter}
                onChange={(e) => setVisibilityFilter(e.target.value as Visibility | 'ALL')}
                className="h-9 rounded-xl border border-[#383838] bg-[#141414] px-3 text-xs text-white focus:border-red-500 focus:outline-none transition cursor-pointer"
              >
                <option value="ALL">Tất cả</option>
                <option value="PUBLIC">Công khai</option>
                <option value="UNLISTED">Không công khai</option>
                <option value="PRIVATE">Riêng tư</option>
              </select>
            </div>

            {/* Moderation Filter */}
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="moderation-filter"
                className="text-xs text-gray-400 whitespace-nowrap"
              >
                Kiểm duyệt:
              </label>
              <select
                id="moderation-filter"
                aria-label="Lọc theo trạng thái kiểm duyệt"
                data-testid="admin-videos-moderation-filter"
                value={moderationFilter}
                onChange={(e) => setModerationFilter(e.target.value as ModerationFilter)}
                className="h-9 rounded-xl border border-[#383838] bg-[#141414] px-3 text-xs text-white focus:border-red-500 focus:outline-none transition cursor-pointer"
              >
                <option value="ALL">Tất cả</option>
                <option value="VISIBLE">Đang hiện</option>
                <option value="HIDDEN">Đã ẩn</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-2xl bg-red-500/10 border border-red-500/30 p-4 text-xs text-red-400">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading Skeleton */}
      {isLoading ? (
        <div data-testid="admin-videos-loading-skeleton" className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 rounded-2xl border border-[#272727] bg-[#141414] p-4 animate-pulse"
            >
              <div className="h-20 w-36 shrink-0 rounded-xl bg-zinc-800/80" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 rounded bg-zinc-800" />
                <div className="h-3 w-1/3 rounded bg-zinc-800/60" />
                <div className="flex gap-2">
                  <div className="h-5 w-16 rounded bg-zinc-800/50" />
                  <div className="h-5 w-16 rounded bg-zinc-800/50" />
                </div>
              </div>
              <div className="h-9 w-24 rounded-xl bg-zinc-800/60" />
            </div>
          ))}
        </div>
      ) : videos.length === 0 ? (
        /* Empty State */
        <div
          data-testid="admin-videos-empty-state"
          className="flex flex-col items-center justify-center p-12 text-center rounded-2xl border border-dashed border-[#333] bg-[#141414]"
        >
          <Film className="h-12 w-12 text-gray-500 mb-3" />
          <h3 className="text-sm font-bold text-white mb-1">Không tìm thấy video nào</h3>
          <p className="text-xs text-gray-400 max-w-sm">
            {debouncedQuery.length >= 2 ||
            statusFilter !== 'ALL' ||
            visibilityFilter !== 'ALL' ||
            moderationFilter !== 'ALL'
              ? 'Thử thay đổi từ khóa tìm kiếm hoặc điều chỉnh các bộ lọc bên trên.'
              : 'Hiện chưa có video nào trên hệ thống.'}
          </p>
        </div>
      ) : (
        /* Video List Table/Rows */
        <div className="space-y-3">
          {videos.map((video) => {
            const isHidden = video.moderation?.state === 'HIDDEN';
            const durationSecs = video.duration_ms ? Math.round(video.duration_ms / 1000) : 0;

            return (
              <div
                key={video.id}
                data-testid={`admin-video-row-${video.id}`}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-[#272727] bg-[#141414] p-4 hover:border-[#383838] transition shadow-sm"
              >
                {/* Thumbnail & Title/Info */}
                <div className="flex items-start gap-4 min-w-0 flex-1">
                  {/* Thumbnail Container */}
                  <div className="relative h-20 w-36 shrink-0 overflow-hidden rounded-xl bg-zinc-900 border border-[#2c2c2c]">
                    {video.thumbnail_url ? (
                      <img
                        src={video.thumbnail_url}
                        alt={video.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-gray-600">
                        <Film className="h-6 w-6" />
                      </div>
                    )}
                    {durationSecs > 0 && (
                      <div className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] font-mono font-medium text-white">
                        {formatDuration(durationSecs)}
                      </div>
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                    {/* Title */}
                    <Link
                      href={`/watch/${video.id}`}
                      target="_blank"
                      data-testid={`admin-video-title-link-${video.id}`}
                      className="font-semibold text-sm text-white hover:text-red-400 transition truncate flex items-center gap-1.5 group"
                    >
                      <span className="truncate">{video.title}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-gray-500 group-hover:text-red-400 shrink-0" />
                    </Link>

                    {/* Owner & Date */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                      {video.owner_active === false ? (
                        <span
                          data-testid="admin-video-owner-inactive"
                          className="font-semibold text-amber-500 bg-amber-950/30 border border-amber-800/40 px-2 py-0.5 rounded-md"
                        >
                          Tài khoản đã khóa/xóa
                        </span>
                      ) : (
                        <Link
                          href={`/c/${video.owner.handle}`}
                          target="_blank"
                          className="font-medium text-gray-300 hover:text-white transition flex items-center gap-1"
                        >
                          <UserIcon className="h-3 w-3 text-gray-500" />
                          <span>@{video.owner.handle}</span>
                        </Link>
                      )}
                      <span>•</span>
                      <span className="flex items-center gap-1 text-gray-500">
                        <Clock className="h-3 w-3" />
                        <span>{formatRelativeTime(video.created_at)}</span>
                      </span>
                    </div>

                    {/* Badges */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {/* Moderation Badge */}
                      {isHidden ? (
                        <span
                          data-testid={`admin-video-mod-badge-${video.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-950/60 text-red-400 border border-red-800/50"
                        >
                          <ShieldAlert className="h-3 w-3 text-red-500" />
                          <span>Đã ẩn</span>
                        </span>
                      ) : (
                        <span
                          data-testid={`admin-video-mod-badge-${video.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/40 text-emerald-400 border border-emerald-800/30"
                        >
                          <span>Đang hiện</span>
                        </span>
                      )}

                      {/* Visibility Badge */}
                      {video.visibility === 'PUBLIC' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-950/40 text-blue-400 border border-blue-800/30">
                          Công khai
                        </span>
                      )}
                      {video.visibility === 'UNLISTED' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                          Không công khai
                        </span>
                      )}
                      {video.visibility === 'PRIVATE' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-950/40 text-purple-400 border border-purple-800/30">
                          Riêng tư
                        </span>
                      )}

                      {/* Status Badge */}
                      {video.status === 'READY' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-950/30 text-emerald-400 border border-emerald-800/20">
                          Sẵn sàng
                        </span>
                      )}
                      {video.status === 'PROCESSING' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-950/30 text-amber-400 border border-amber-800/20">
                          Đang xử lý
                        </span>
                      )}
                      {video.status === 'UPLOADING' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-950/30 text-sky-400 border border-sky-800/20">
                          Đang tải lên
                        </span>
                      )}
                      {video.status === 'FAILED' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-950/30 text-red-400 border border-red-800/20">
                          Thất bại
                        </span>
                      )}

                      {/* Hidden reason display if hidden */}
                      {isHidden && video.moderation?.reason && (
                        <span className="text-[11px] text-red-300/80 italic ml-1 truncate max-w-xs">
                          Lý do: {video.moderation.reason}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex sm:flex-col lg:flex-row items-center gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-[#242424]">
                  {isHidden ? (
                    <button
                      type="button"
                      data-testid={`admin-video-restore-btn-${video.id}`}
                      onClick={() => handleRestoreVideo(video)}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-700/50 bg-emerald-950/30 hover:bg-emerald-900/40 px-3.5 py-2 text-xs font-semibold text-emerald-300 transition"
                    >
                      <RotateCw className="h-4 w-4" />
                      <span>Hiện lại</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`admin-video-hide-btn-${video.id}`}
                      onClick={() => setHidingVideo(video)}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-amber-700/50 bg-amber-950/30 hover:bg-amber-900/40 px-3.5 py-2 text-xs font-semibold text-amber-300 transition"
                    >
                      <EyeOff className="h-4 w-4" />
                      <span>Ẩn video</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid={`admin-video-delete-btn-${video.id}`}
                    onClick={() => setDeletingVideo(video)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-red-800/40 bg-red-950/30 hover:bg-red-900/40 px-3.5 py-2 text-xs font-semibold text-red-400 hover:text-red-300 transition"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Xóa</span>
                  </button>
                </div>
              </div>
            );
          })}

          {/* Load More Button */}
          {nextCursor && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                data-testid="admin-videos-load-more-btn"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#383838] bg-[#1a1a1a] hover:bg-[#252525] px-6 py-2.5 text-xs font-semibold text-white transition disabled:opacity-50"
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-red-500" />
                    <span>Đang tải thêm...</span>
                  </>
                ) : (
                  <span>Tải thêm video</span>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Hide Dialog */}
      <HideVideoDialog
        isOpen={!!hidingVideo}
        videoTitle={hidingVideo?.title || ''}
        onClose={() => setHidingVideo(null)}
        onConfirm={handleHideConfirm}
      />

      {/* Delete Dialog */}
      <DeleteVideoDialog
        isOpen={!!deletingVideo}
        videoTitle={deletingVideo?.title || ''}
        onClose={() => setDeletingVideo(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
