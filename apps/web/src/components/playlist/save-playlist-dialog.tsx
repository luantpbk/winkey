'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { Playlist, Visibility } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { X, Plus, Lock, Globe, EyeOff, Loader2 } from 'lucide-react';

export interface SavePlaylistDialogProps {
  videoId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function SavePlaylistDialog({ videoId, isOpen, onClose }: SavePlaylistDialogProps) {
  const { user, isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Inline creation form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>('PRIVATE');
  const [newIsSeries, setNewIsSeries] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !isAuthenticated || !user?.id) return;

    let mounted = true;
    setLoading(true);

    Promise.all([
      api.social.GET('/v1/channels/{channel_id}/playlists', {
        params: { path: { channel_id: user.id } },
      }),
      api.social.GET('/v1/videos/{video_id}/playlist-membership', {
        params: { path: { video_id: videoId } },
      }),
    ])
      .then(([playlistsRes, membershipRes]) => {
        if (!mounted) return;
        if (playlistsRes.data?.items) {
          // Ensure WATCH_LATER is first
          const sorted = [...playlistsRes.data.items].sort((a, b) => {
            if (a.kind === 'WATCH_LATER') return -1;
            if (b.kind === 'WATCH_LATER') return 1;
            return 0;
          });
          setPlaylists(sorted);
        }
        if (membershipRes.data?.playlist_ids) {
          setSelectedIds(new Set(membershipRes.data.playlist_ids));
        }
      })
      .catch((err) => {
        console.error('Failed to load playlist data:', err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen, isAuthenticated, user?.id, videoId]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleToggle = async (playlist: Playlist) => {
    const isCurrentlySelected = selectedIds.has(playlist.id);
    const nextSelected = !isCurrentlySelected;

    // Optimistic update
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (nextSelected) {
        next.add(playlist.id);
      } else {
        next.delete(playlist.id);
      }
      return next;
    });

    try {
      if (nextSelected) {
        const res = await api.social.POST('/v1/playlists/{playlist_id}/items', {
          params: { path: { playlist_id: playlist.id } },
          body: { video_id: videoId },
        });

        if (res.response.status === 409) {
          const errData = res.error as { code?: string; title?: string } | undefined;
          const msg =
            errData?.code === 'SERIES_FOREIGN_ITEM'
              ? 'Bộ phim chỉ chứa video của chính kênh bạn.'
              : errData?.code === 'PLAYLIST_FULL'
                ? 'Danh sách phát đã đầy (tối đa 5.000 video).'
                : errData?.title || 'Không thể thêm vào danh sách phát.';
          showToast({ title: msg, type: 'error' });
          // Rollback
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(playlist.id);
            return next;
          });
          return;
        }

        if (res.error) {
          showToast({ title: 'Lỗi khi thêm vào danh sách phát.', type: 'error' });
          // Rollback
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(playlist.id);
            return next;
          });
        }
      } else {
        const res = await api.social.DELETE('/v1/playlists/{playlist_id}/items/{video_id}', {
          params: { path: { playlist_id: playlist.id, video_id: videoId } },
        });

        if (res.error) {
          showToast({ title: 'Lỗi khi xóa khỏi danh sách phát.', type: 'error' });
          // Rollback
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.add(playlist.id);
            return next;
          });
        }
      }
    } catch {
      showToast({ title: 'Lỗi kết nối mạng, vui lòng thử lại.', type: 'error' });
      // Rollback
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (nextSelected) {
          next.delete(playlist.id);
        } else {
          next.add(playlist.id);
        }
        return next;
      });
    }
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle || isCreating) return;

    setIsCreating(true);
    try {
      const createRes = await api.social.POST('/v1/playlists', {
        body: {
          title: trimmedTitle,
          description: '',
          visibility: newVisibility,
          is_series: newIsSeries,
        },
      });

      if (createRes.response.status === 409) {
        const errData = createRes.error as { code?: string; title?: string } | undefined;
        const msg =
          errData?.code === 'SERIES_FOREIGN_ITEM'
            ? 'Bộ phim chỉ chứa video của chính kênh bạn.'
            : errData?.code === 'PLAYLIST_LIMIT'
              ? 'Bạn đã đạt giới hạn tối đa 200 danh sách phát.'
              : errData?.title || 'Không thể tạo danh sách phát.';
        showToast({ title: msg, type: 'error' });
        setIsCreating(false);
        return;
      }

      if (createRes.data) {
        const createdPlaylist = createRes.data;

        // Automatically add video to this new playlist
        const itemRes = await api.social.POST('/v1/playlists/{playlist_id}/items', {
          params: { path: { playlist_id: createdPlaylist.id } },
          body: { video_id: videoId },
        });

        if (itemRes.response.status === 409) {
          const itemErr = itemRes.error as { code?: string; title?: string } | undefined;
          const msg =
            itemErr?.code === 'SERIES_FOREIGN_ITEM'
              ? 'Bộ phim chỉ chứa video của chính kênh bạn.'
              : itemErr?.title || 'Không thể thêm video vào danh sách phát.';
          showToast({ title: msg, type: 'error' });
        } else {
          setSelectedIds((prev) => new Set(prev).add(createdPlaylist.id));
          showToast({
            title: `Đã tạo "${createdPlaylist.title}" và lưu video`,
            type: 'success',
          });
        }

        setPlaylists((prev) => [...prev, createdPlaylist]);
        setNewTitle('');
        setNewIsSeries(false);
        setShowCreateForm(false);
      } else {
        showToast({ title: 'Không thể tạo danh sách phát.', type: 'error' });
      }
    } catch {
      showToast({ title: 'Lỗi kết nối khi tạo danh sách phát.', type: 'error' });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-sm rounded-2xl bg-[#1f1f1f] border border-[#333333] p-5 shadow-2xl text-white transition-all transform duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#2e2e2e]">
          <h2 id="save-dialog-title" className="text-base font-semibold text-white">
            Lưu video vào...
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Playlists List */}
        <div className="my-3 max-h-60 overflow-y-auto space-y-1 pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-zinc-400">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : playlists.length === 0 ? (
            <div className="py-6 text-center text-sm text-zinc-400">
              Chưa có danh sách phát nào.
            </div>
          ) : (
            playlists.map((pl) => {
              const isChecked = selectedIds.has(pl.id);
              return (
                <label
                  key={pl.id}
                  className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-zinc-800/60 cursor-pointer select-none transition"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggle(pl)}
                    data-testid={`playlist-checkbox-${pl.id}`}
                    className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-red-600 focus:ring-red-500 focus:ring-offset-zinc-900"
                  />
                  <span className="flex-1 text-sm font-medium text-zinc-200 truncate">
                    {pl.kind === 'WATCH_LATER' ? 'Xem sau' : pl.title}
                  </span>
                  <span className="text-zinc-500 shrink-0">
                    {pl.visibility === 'PRIVATE' || pl.kind === 'WATCH_LATER' ? (
                      <Lock className="h-3.5 w-3.5" />
                    ) : pl.visibility === 'UNLISTED' ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Globe className="h-3.5 w-3.5" />
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>

        {/* Inline Create Form */}
        <div className="pt-3 border-t border-[#2e2e2e]">
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              data-testid="open-create-playlist-btn"
              className="flex items-center gap-2 text-sm font-medium text-red-500 hover:text-red-400 transition py-1"
            >
              <Plus className="h-4 w-4" />
              <span>Tạo danh sách mới</span>
            </button>
          ) : (
            <form onSubmit={handleCreatePlaylist} className="space-y-3 pt-1">
              <div>
                <label
                  htmlFor="new-playlist-title"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Tên danh sách phát
                </label>
                <input
                  id="new-playlist-title"
                  type="text"
                  required
                  maxLength={150}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Nhập tên danh sách..."
                  data-testid="new-playlist-title-input"
                  className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-red-500 focus:outline-none"
                  autoFocus
                />
              </div>

              <div>
                <label
                  htmlFor="new-playlist-visibility"
                  className="block text-xs font-medium text-zinc-400 mb-1"
                >
                  Quyền riêng tư
                </label>
                <select
                  id="new-playlist-visibility"
                  value={newVisibility}
                  onChange={(e) => setNewVisibility(e.target.value as Visibility)}
                  data-testid="new-playlist-visibility-select"
                  className="w-full rounded-xl bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none"
                >
                  <option value="PRIVATE">Riêng tư</option>
                  <option value="UNLISTED">Không công khai</option>
                  <option value="PUBLIC">Công khai</option>
                </select>
              </div>

              <div className="flex items-start gap-2 pt-1">
                <input
                  id="new-playlist-is-series"
                  type="checkbox"
                  checked={newIsSeries}
                  onChange={(e) => setNewIsSeries(e.target.checked)}
                  data-testid="new-playlist-is-series-checkbox"
                  className="h-4 w-4 mt-0.5 rounded border-zinc-600 bg-zinc-800 text-red-600 focus:ring-red-500 focus:ring-offset-zinc-900"
                />
                <div className="flex flex-col">
                  <label
                    htmlFor="new-playlist-is-series"
                    className="text-xs font-medium text-zinc-300 cursor-pointer select-none"
                  >
                    Bộ phim
                  </label>
                  <span className="text-[11px] text-zinc-500">
                    Đánh dấu danh sách phát này là một bộ phim.
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewTitle('');
                  }}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={!newTitle.trim() || isCreating}
                  data-testid="submit-create-playlist-btn"
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-xs font-semibold text-white transition shadow-sm"
                >
                  {isCreating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>Tạo</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
