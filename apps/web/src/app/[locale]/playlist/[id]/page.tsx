'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Link } from '../../../../i18n/routing';
import type { Playlist, PlaylistItem, VideoSummary, Visibility } from '@winkey/api-client';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../lib/auth/auth-context';
import { useToast } from '../../../../components/ui/toast';
import {
  setCachedWatchLaterId,
  computeBeforeVideoId,
  computeDropBeforeVideoId,
} from '../../../../lib/playlist/playlist-utils';
import { formatDuration, formatViews, formatRelativeTime } from '../../../../lib/format';
import { getThumbnailUrl } from '../../../../lib/constants';
import { buildWatchUrl } from '../../../../lib/video/watch-url';
import {
  Play,
  Trash2,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Lock,
  Globe,
  EyeOff,
  Edit2,
  Clock,
  AlertTriangle,
  Loader2,
  X,
} from 'lucide-react';

interface MergedItem {
  item: PlaylistItem;
  video: VideoSummary | null;
}

export default function PlaylistPage() {
  const params = useParams();
  const rawId = params?.id as string;
  const router = useRouter();

  const { user, isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Items and batch videos
  const [mergedItems, setMergedItems] = useState<MergedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Edit playlist modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editVisibility, setEditVisibility] = useState<Visibility>('PUBLIC');
  const [editIsSeries, setEditIsSeries] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete playlist confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Drag and drop state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const isOwner = Boolean(isAuthenticated && user && playlist && user.id === playlist.owner.id);

  // Load playlist metadata
  const loadPlaylist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let pl: Playlist;
      if (rawId === 'watch-later') {
        const res = await api.social.GET('/v1/me/watch-later');
        if (!res.data) {
          setError('Không thể tải danh sách Xem sau');
          setLoading(false);
          return;
        }
        pl = res.data;
        setCachedWatchLaterId(pl.id);
      } else {
        const res = await api.social.GET('/v1/playlists/{playlist_id}', {
          params: { path: { playlist_id: rawId } },
        });
        if (!res.data) {
          setError('Danh sách phát không tồn tại hoặc đã bị xóa');
          setLoading(false);
          return;
        }
        pl = res.data;
      }

      setPlaylist(pl);
      setEditTitle(pl.title);
      setEditDesc(pl.description || '');
      setEditVisibility(pl.visibility);
      setEditIsSeries(Boolean(pl.is_series));

      // Load first page of items
      const itemsRes = await api.social.GET('/v1/playlists/{playlist_id}/items', {
        params: { path: { playlist_id: pl.id }, query: { limit: 50 } },
      });

      const rawItems = itemsRes.data?.items || [];
      setNextCursor(itemsRes.data?.next_cursor ?? null);

      if (rawItems.length > 0) {
        // ONE batchGetVideos per page
        const videoIds = rawItems.map((it) => it.video_id);
        const batchRes = await api.video.GET('/v1/videos/batch', {
          params: { query: { ids: videoIds } },
          querySerializer: { array: { style: 'form', explode: false } },
        });

        const batchVideos = batchRes.data?.items || [];
        const videoMap = new Map<string, VideoSummary>();
        for (const v of batchVideos) {
          videoMap.set(v.id, v);
        }

        const merged: MergedItem[] = rawItems.map((item) => ({
          item,
          video: videoMap.get(item.video_id) || null,
        }));

        setMergedItems(merged);
      } else {
        setMergedItems([]);
      }
    } catch (err) {
      console.error(err);
      setError('Lỗi kết nối khi tải danh sách phát');
    } finally {
      setLoading(false);
    }
  }, [rawId]);

  useEffect(() => {
    loadPlaylist();
  }, [loadPlaylist]);

  // Load more items (infinite scroll)
  const handleLoadMore = async () => {
    if (!playlist || !nextCursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const itemsRes = await api.social.GET('/v1/playlists/{playlist_id}/items', {
        params: {
          path: { playlist_id: playlist.id },
          query: { cursor: nextCursor, limit: 50 },
        },
      });

      const newRawItems = itemsRes.data?.items || [];
      setNextCursor(itemsRes.data?.next_cursor ?? null);

      if (newRawItems.length > 0) {
        const videoIds = newRawItems.map((it) => it.video_id);
        const batchRes = await api.video.GET('/v1/videos/batch', {
          params: { query: { ids: videoIds } },
          querySerializer: { array: { style: 'form', explode: false } },
        });

        const batchVideos = batchRes.data?.items || [];
        const videoMap = new Map<string, VideoSummary>();
        for (const v of batchVideos) {
          videoMap.set(v.id, v);
        }

        const newMerged: MergedItem[] = newRawItems.map((item) => ({
          item,
          video: videoMap.get(item.video_id) || null,
        }));

        setMergedItems((prev) => [...prev, ...newMerged]);
      }
    } catch (err) {
      console.error('Failed to load more items:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Reordering move action
  const handleMove = async (videoId: string, beforeVideoId: string | null | undefined) => {
    if (!playlist || beforeVideoId === undefined) return;

    const previousItems = [...mergedItems];

    // Optimistic reorder
    const sourceIndex = mergedItems.findIndex((m) => m.item.video_id === videoId);
    if (sourceIndex === -1) return;

    const updated = [...mergedItems];
    const [moved] = updated.splice(sourceIndex, 1);

    if (beforeVideoId === null) {
      updated.push(moved);
    } else {
      const targetIndex = updated.findIndex((m) => m.item.video_id === beforeVideoId);
      if (targetIndex !== -1) {
        updated.splice(targetIndex, 0, moved);
      } else {
        updated.push(moved);
      }
    }

    setMergedItems(updated);

    try {
      const res = await api.social.POST('/v1/playlists/{playlist_id}/items/{video_id}/move', {
        params: {
          path: { playlist_id: playlist.id, video_id: videoId },
        },
        body: { before_video_id: beforeVideoId },
      });

      if (res.error) {
        setMergedItems(previousItems);
        showToast({ title: 'Không thể sắp xếp lại video', type: 'error' });
      }
    } catch {
      setMergedItems(previousItems);
      showToast({ title: 'Lỗi mạng khi sắp xếp', type: 'error' });
    }
  };

  // Remove item action
  const handleRemoveItem = async (videoId: string) => {
    if (!playlist) return;

    const previousItems = [...mergedItems];
    setMergedItems((prev) => prev.filter((m) => m.item.video_id !== videoId));
    setPlaylist((prev) =>
      prev ? { ...prev, item_count: Math.max(0, prev.item_count - 1) } : null,
    );

    try {
      const res = await api.social.DELETE('/v1/playlists/{playlist_id}/items/{video_id}', {
        params: {
          path: { playlist_id: playlist.id, video_id: videoId },
        },
      });

      if (res.error) {
        setMergedItems(previousItems);
        setPlaylist((prev) => (prev ? { ...prev, item_count: previousItems.length } : null));
        showToast({ title: 'Lỗi khi xóa video khỏi danh sách', type: 'error' });
      } else {
        showToast({ title: 'Đã xóa video khỏi danh sách', type: 'success' });
      }
    } catch {
      setMergedItems(previousItems);
      setPlaylist((prev) => (prev ? { ...prev, item_count: previousItems.length } : null));
      showToast({ title: 'Lỗi mạng khi xóa video', type: 'error' });
    }
  };

  // Edit playlist info
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playlist || savingEdit) return;

    setSavingEdit(true);
    try {
      const res = await api.social.PATCH('/v1/playlists/{playlist_id}', {
        params: { path: { playlist_id: playlist.id } },
        body: {
          title: editTitle.trim(),
          description: editDesc.trim(),
          visibility: editVisibility,
          is_series: editIsSeries,
        },
      });

      if (res.response.status === 409) {
        const errData = res.error as { code?: string; title?: string } | undefined;
        const msg =
          errData?.code === 'SERIES_FOREIGN_ITEM'
            ? 'Bộ phim chỉ chứa video của chính kênh bạn.'
            : errData?.title || 'Không thể cập nhật danh sách';
        showToast({ title: msg, type: 'error' });
        return;
      }

      if (res.data) {
        setPlaylist(res.data);
        setShowEditModal(false);
        showToast({ title: 'Đã cập nhật danh sách phát', type: 'success' });
      } else {
        showToast({ title: 'Không thể cập nhật danh sách', type: 'error' });
      }
    } catch {
      showToast({ title: 'Lỗi mạng khi cập nhật', type: 'error' });
    } finally {
      setSavingEdit(false);
    }
  };

  // Delete playlist
  const handleDeletePlaylist = async () => {
    if (!playlist || deleting) return;
    setDeleting(true);

    try {
      const res = await api.social.DELETE('/v1/playlists/{playlist_id}', {
        params: { path: { playlist_id: playlist.id } },
      });

      if (res.response.status === 204) {
        showToast({ title: 'Đã xóa danh sách phát', type: 'success' });
        router.push('/');
      } else {
        showToast({ title: 'Không thể xóa danh sách phát', type: 'error' });
      }
    } catch {
      showToast({ title: 'Lỗi mạng khi xóa', type: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  // Filter items visible to current user:
  // Owner sees all items (including omitted ones with "Video không còn khả dụng").
  // Non-owners ONLY see items where video is not null.
  const visibleItems = mergedItems.filter((m) => isOwner || m.video !== null);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] text-zinc-400">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !playlist) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center p-6">
        <div className="p-4 rounded-full bg-zinc-800 text-zinc-400 mb-4">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">
          {error || 'Không tìm thấy danh sách phát'}
        </h2>
        <p className="text-sm text-zinc-400 mb-6">
          Danh sách phát này không tồn tại hoặc đã được đặt ở chế độ riêng tư.
        </p>
        <Link
          href="/"
          className="px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition"
        >
          Về trang chủ
        </Link>
      </div>
    );
  }

  const firstValidVideo = mergedItems.find((m) => m.video !== null)?.video;
  const coverUrl = getThumbnailUrl(firstValidVideo?.thumbnail_url);

  return (
    <div className="w-full max-w-[1600px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 py-4 px-2 sm:px-4">
      {/* Left Column: Playlist Card / Info */}
      <div className="lg:col-span-4 xl:col-span-3">
        <div className="sticky top-20 rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900 border border-zinc-800 p-6 flex flex-col gap-5 shadow-2xl backdrop-blur-md">
          {/* Cover Image */}
          <div className="relative aspect-video w-full rounded-xl overflow-hidden shadow-lg bg-zinc-800">
            <img src={coverUrl} alt={playlist.title} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
              {firstValidVideo && (
                <Link
                  href={buildWatchUrl(firstValidVideo.id, 'playlist')}
                  className="p-4 rounded-full bg-red-600 text-white shadow-xl hover:scale-110 transition"
                  aria-label="Phát tất cả"
                >
                  <Play className="h-6 w-6 fill-current" />
                </Link>
              )}
            </div>
            {playlist.kind === 'WATCH_LATER' && (
              <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/80 text-[11px] font-semibold text-white">
                <Clock className="h-3.5 w-3.5 text-red-500" />
                <span>Xem sau</span>
              </div>
            )}
          </div>

          {/* Title & Description */}
          <div className="flex flex-col gap-1">
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight break-words">
              {playlist.title}
            </h1>
            {playlist.description && (
              <p className="text-xs sm:text-sm text-zinc-400 mt-1 whitespace-pre-line leading-relaxed">
                {playlist.description}
              </p>
            )}
          </div>

          {/* Owner info */}
          <div className="flex items-center gap-3 pt-2 border-t border-zinc-800">
            <Link href={`/c/${playlist.owner.handle}`} className="shrink-0">
              {playlist.owner.avatar_url ? (
                <img
                  src={playlist.owner.avatar_url}
                  alt={playlist.owner.display_name}
                  className="h-8 w-8 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 font-bold text-xs text-white">
                  {playlist.owner.display_name.charAt(0)}
                </div>
              )}
            </Link>
            <div className="flex flex-col min-w-0">
              <Link
                href={`/c/${playlist.owner.handle}`}
                className="text-sm font-semibold text-white hover:underline truncate"
              >
                {playlist.owner.display_name}
              </Link>
              <span className="text-xs text-zinc-500 truncate">@{playlist.owner.handle}</span>
            </div>
          </div>

          {/* Badges / Stats */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 font-medium">
            {playlist.is_series && (
              <span
                data-testid="playlist-series-badge"
                className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-950/60 border border-red-800/60 text-red-400 font-semibold"
              >
                Bộ phim
              </span>
            )}
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-800/80 border border-zinc-700/60">
              {playlist.visibility === 'PRIVATE' || playlist.kind === 'WATCH_LATER' ? (
                <>
                  <Lock className="h-3 w-3 text-red-400" />
                  <span>Riêng tư</span>
                </>
              ) : playlist.visibility === 'UNLISTED' ? (
                <>
                  <EyeOff className="h-3 w-3 text-amber-400" />
                  <span>Không công khai</span>
                </>
              ) : (
                <>
                  <Globe className="h-3 w-3 text-emerald-400" />
                  <span>Công khai</span>
                </>
              )}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-zinc-800/80 border border-zinc-700/60">
              {playlist.item_count} video
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-800">
            {firstValidVideo && (
              <Link
                href={buildWatchUrl(firstValidVideo.id, 'playlist')}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-white text-black font-semibold text-xs hover:bg-zinc-200 transition"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Phát tất cả</span>
              </Link>
            )}

            {isOwner && playlist.kind !== 'WATCH_LATER' && (
              <>
                <button
                  type="button"
                  onClick={() => setShowEditModal(true)}
                  aria-label="Chỉnh sửa danh sách phát"
                  data-testid="edit-playlist-btn"
                  className="p-2.5 rounded-full bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
                >
                  <Edit2 className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  aria-label="Xóa danh sách phát"
                  data-testid="delete-playlist-btn"
                  className="p-2.5 rounded-full bg-zinc-800 text-zinc-300 hover:text-red-500 hover:bg-zinc-700 transition"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right Column: Playlist Items */}
      <div className="lg:col-span-8 xl:col-span-9 flex flex-col gap-2">
        {visibleItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 rounded-2xl bg-zinc-900/50 border border-zinc-800 text-center p-6 text-zinc-500">
            <Clock className="h-10 w-10 text-zinc-600 mb-3" />
            <p className="text-base font-semibold text-zinc-300">
              Danh sách phát này chưa có video nào.
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              Thêm video bằng nút "Lưu" hoặc "Xem sau" trên trang xem video.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="playlist-items-list">
            {visibleItems.map((entry, index) => {
              const { item, video } = entry;
              const isUnavailable = !video;

              return (
                <div
                  key={item.video_id}
                  draggable={isOwner}
                  onDragStart={(e) => {
                    setDraggedIndex(index);
                    e.dataTransfer.setData('text/plain', String(index));
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedIndex === null || draggedIndex === index) return;
                    const beforeId = computeDropBeforeVideoId(
                      visibleItems.map((m) => m.item),
                      draggedIndex,
                      index,
                    );
                    handleMove(visibleItems[draggedIndex].item.video_id, beforeId);
                    setDraggedIndex(null);
                  }}
                  data-testid={`playlist-item-${item.video_id}`}
                  className={`group flex items-center gap-3 p-3 rounded-2xl transition border ${
                    isOwner ? 'cursor-grab active:cursor-grabbing' : ''
                  } ${
                    draggedIndex === index
                      ? 'opacity-40 border-dashed border-red-500 bg-red-950/20'
                      : 'border-transparent bg-zinc-900/60 hover:bg-zinc-800/80 hover:border-zinc-700/60'
                  }`}
                >
                  {/* Drag Handle & Index */}
                  <div className="flex items-center gap-2 shrink-0">
                    {isOwner ? (
                      <div className="text-zinc-500 group-hover:text-zinc-300 transition cursor-grab">
                        <GripVertical className="h-4 w-4" />
                      </div>
                    ) : null}
                    <span className="w-5 text-center text-xs font-semibold text-zinc-500">
                      {index + 1}
                    </span>
                  </div>

                  {/* Video Content */}
                  {isUnavailable ? (
                    <div className="flex-1 flex items-center justify-between p-2 rounded-xl bg-zinc-800/40 border border-zinc-700/40 text-xs text-zinc-400">
                      <span className="italic">Video không còn khả dụng</span>
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(item.video_id)}
                          aria-label="Xóa video không khả dụng"
                          data-testid={`remove-unavailable-${item.video_id}`}
                          className="text-xs font-semibold text-red-400 hover:text-red-300 underline"
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Thumbnail */}
                      <Link
                        href={buildWatchUrl(video.id, 'playlist')}
                        className="relative aspect-video w-32 sm:w-40 shrink-0 rounded-xl overflow-hidden bg-zinc-800"
                      >
                        <img
                          src={getThumbnailUrl(video.thumbnail_url)}
                          alt={video.title}
                          className="h-full w-full object-cover group-hover:scale-105 transition"
                          loading="lazy"
                        />
                        <div className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] font-semibold text-white">
                          {formatDuration(video.duration_ms)}
                        </div>
                      </Link>

                      {/* Info */}
                      <div className="flex flex-col min-w-0 flex-1">
                        <Link
                          href={buildWatchUrl(video.id, 'playlist')}
                          className="text-xs sm:text-sm font-semibold text-white line-clamp-2 hover:text-red-500 transition leading-snug"
                        >
                          {video.title}
                        </Link>
                        <Link
                          href={`/c/${video.owner.handle}`}
                          className="text-xs text-zinc-400 hover:text-white transition truncate mt-1"
                        >
                          {video.owner.display_name}
                        </Link>
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 mt-1">
                          <span>{formatViews(video.view_count)} lượt xem</span>
                          <span>•</span>
                          <span>{formatRelativeTime(video.published_at || item.added_at)}</span>
                        </div>
                      </div>

                      {/* Owner Actions: Reorder Keyboard Buttons & Remove */}
                      {isOwner && (
                        <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => {
                              const beforeId = computeBeforeVideoId(
                                visibleItems.map((m) => m.item),
                                index,
                                'up',
                              );
                              handleMove(item.video_id, beforeId);
                            }}
                            title="Di chuyển lên"
                            aria-label="Di chuyển lên"
                            data-testid={`move-up-btn-${item.video_id}`}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-20 transition"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>

                          <button
                            type="button"
                            disabled={index === visibleItems.length - 1}
                            onClick={() => {
                              const beforeId = computeBeforeVideoId(
                                visibleItems.map((m) => m.item),
                                index,
                                'down',
                              );
                              handleMove(item.video_id, beforeId);
                            }}
                            title="Di chuyển xuống"
                            aria-label="Di chuyển xuống"
                            data-testid={`move-down-btn-${item.video_id}`}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-20 transition"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRemoveItem(item.video_id)}
                            title="Xóa khỏi danh sách"
                            aria-label="Xóa khỏi danh sách"
                            data-testid={`remove-item-btn-${item.video_id}`}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-zinc-700 transition"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {/* Load more button if cursor exists */}
            {nextCursor && (
              <div className="py-4 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white transition disabled:opacity-50"
                >
                  {loadingMore ? 'Đang tải thêm...' : 'Tải thêm video'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Playlist Modal */}
      {showEditModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowEditModal(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800 mb-4">
              <h3 className="text-base font-bold text-white">Chỉnh sửa danh sách phát</h3>
              <button
                type="button"
                onClick={() => setShowEditModal(false)}
                className="p-1 rounded-full text-zinc-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label
                  htmlFor="edit-playlist-title"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Tiêu đề
                </label>
                <input
                  id="edit-playlist-title"
                  type="text"
                  required
                  maxLength={150}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-playlist-desc"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Mô tả
                </label>
                <textarea
                  id="edit-playlist-desc"
                  rows={3}
                  maxLength={1000}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-playlist-visibility"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Quyền riêng tư
                </label>
                <select
                  id="edit-playlist-visibility"
                  value={editVisibility}
                  onChange={(e) => setEditVisibility(e.target.value as Visibility)}
                  className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
                >
                  <option value="PUBLIC">Công khai</option>
                  <option value="UNLISTED">Không công khai</option>
                  <option value="PRIVATE">Riêng tư</option>
                </select>
              </div>

              <div className="flex items-start gap-2 pt-1">
                <input
                  id="edit-playlist-is-series"
                  type="checkbox"
                  checked={editIsSeries}
                  onChange={(e) => setEditIsSeries(e.target.checked)}
                  data-testid="edit-playlist-is-series-checkbox"
                  className="h-4 w-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-red-600 focus:ring-red-500 focus:ring-offset-zinc-900"
                />
                <div className="flex flex-col">
                  <label
                    htmlFor="edit-playlist-is-series"
                    className="text-xs font-medium text-zinc-300 cursor-pointer select-none"
                  >
                    Bộ phim
                  </label>
                  <span className="text-[11px] text-zinc-500">
                    Đánh dấu danh sách phát này là một bộ phim.
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={!editTitle.trim() || savingEdit}
                  data-testid="save-edit-playlist-btn"
                  className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-semibold text-white disabled:opacity-50 transition"
                >
                  {savingEdit && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>Lưu thay đổi</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowDeleteConfirm(false);
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl text-white">
            <h3 className="text-base font-bold text-white mb-2">Xóa danh sách phát?</h3>
            <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
              Bạn có chắc chắn muốn xóa danh sách "{playlist.title}"? Thao tác này không thể hoàn
              tác.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleDeletePlaylist}
                disabled={deleting}
                data-testid="confirm-delete-playlist-btn"
                className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-semibold text-white disabled:opacity-50 transition"
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Xóa</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
