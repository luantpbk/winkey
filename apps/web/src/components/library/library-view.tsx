'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from '../../i18n/routing';
import { Link } from '../../i18n/routing';
import type { Playlist, VideoSummary } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '../../lib/format';
import { getThumbnailUrl } from '../../lib/constants';
import { CreatePlaylistDialog } from '../playlist/create-playlist-dialog';
import {
  ListVideo,
  Plus,
  Lock,
  Globe,
  EyeOff,
  Film,
  Clock,
  Loader2,
  FolderHeart,
} from 'lucide-react';

export function LibraryView() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const t = useTranslations('library');
  const tPl = useTranslations('playlist');

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map()); // playlistId -> thumbnailUrl
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // 1. Signed-in check: redirect anonymous users to /login?return_to=/thu-vien
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login?return_to=/thu-vien');
    }
  }, [authLoading, isAuthenticated, router]);

  // Batch fetch thumbnails for a set of playlists:
  // For each playlist, queries limit: 1 item, then collects all first video IDs and calls ONE batchGetVideos
  const fetchThumbnailsForPlaylists = useCallback(async (pls: Playlist[]) => {
    const nonZeroPlaylists = pls.filter((p) => p.item_count > 0);
    if (nonZeroPlaylists.length === 0) return;

    try {
      // Fetch 1st item for each playlist in parallel
      const firstItemResults = await Promise.all(
        nonZeroPlaylists.map(async (p) => {
          try {
            const res = await api.social.GET('/v1/playlists/{playlist_id}/items', {
              params: { path: { playlist_id: p.id }, query: { limit: 1 } },
            });
            const firstVideoId = res.data?.items?.[0]?.video_id;
            return { playlistId: p.id, videoId: firstVideoId };
          } catch {
            return { playlistId: p.id, videoId: undefined };
          }
        }),
      );

      const validPairs = firstItemResults.filter(
        (pair): pair is { playlistId: string; videoId: string } => Boolean(pair.videoId),
      );

      if (validPairs.length === 0) return;

      const uniqueVideoIds = Array.from(new Set(validPairs.map((p) => p.videoId)));

      // ONE batchGetVideos per page
      const batchRes = await api.video.GET('/v1/videos/batch', {
        params: { query: { ids: uniqueVideoIds } },
        querySerializer: { array: { style: 'form', explode: false } },
      });

      const videoMap = new Map<string, VideoSummary>();
      for (const v of batchRes.data?.items || []) {
        videoMap.set(v.id, v);
      }

      setThumbnails((prev) => {
        const next = new Map(prev);
        for (const pair of validPairs) {
          const video = videoMap.get(pair.videoId);
          if (video?.thumbnail_url) {
            next.set(pair.playlistId, video.thumbnail_url);
          }
        }
        return next;
      });
    } catch (err) {
      console.warn('Failed to batch fetch playlist covers:', err);
    }
  }, []);

  // Load playlists
  const loadPlaylists = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      const res = await api.social.GET('/v1/channels/{channel_id}/playlists', {
        params: {
          path: { channel_id: user.id },
          query: { limit: 40 },
        },
      });

      const items = res.data?.items || [];
      // Watch-later first
      const sorted = [...items].sort((a, b) => {
        if (a.kind === 'WATCH_LATER') return -1;
        if (b.kind === 'WATCH_LATER') return 1;
        return 0;
      });

      setPlaylists(sorted);
      setNextCursor(res.data?.next_cursor || null);

      void fetchThumbnailsForPlaylists(sorted);
    } catch (err) {
      console.error('Failed to load library playlists:', err);
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id, fetchThumbnailsForPlaylists]);

  useEffect(() => {
    if (isAuthenticated && user?.id) {
      void loadPlaylists();
    }
  }, [isAuthenticated, user?.id, loadPlaylists]);

  // Load more
  const handleLoadMore = async () => {
    if (!user?.id || !nextCursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const res = await api.social.GET('/v1/channels/{channel_id}/playlists', {
        params: {
          path: { channel_id: user.id },
          query: { limit: 40, cursor: nextCursor },
        },
      });

      const newItems = res.data?.items || [];
      setPlaylists((prev) => [...prev, ...newItems]);
      setNextCursor(res.data?.next_cursor || null);

      void fetchThumbnailsForPlaylists(newItems);
    } catch (err) {
      console.error('Failed to load more playlists:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  if (authLoading || (isAuthenticated && loading && playlists.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-zinc-400 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-red-500" />
        <span className="text-sm font-medium">Đang tải Thư viện...</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null; // redirecting to login in useEffect
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600/10 text-red-500 border border-red-500/20">
            <FolderHeart className="h-6 w-6" />
          </div>
          <div>
            <h1
              data-testid="library-page-title"
              className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white"
            >
              {t('title')}
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">{t('description')}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          data-testid="create-playlist-btn"
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold text-xs sm:text-sm shadow-lg hover:shadow-red-600/20 transition active:scale-95 self-start sm:self-auto cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{t('createPlaylist')}</span>
        </button>
      </div>

      {/* Grid of Playlists */}
      {playlists.length === 0 ? (
        /* Empty State */
        <div
          data-testid="library-empty-state"
          className="flex flex-col items-center justify-center py-20 rounded-3xl bg-zinc-900/40 border border-zinc-800/80 text-center p-8 max-w-xl mx-auto shadow-xl"
        >
          <div className="p-4 rounded-2xl bg-zinc-800/80 text-zinc-400 mb-4 border border-zinc-700/50">
            <ListVideo className="h-10 w-10 text-red-500" />
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-white mb-2">{t('emptyTitle')}</h2>
          <p className="text-xs sm:text-sm text-zinc-400 mb-6 max-w-md leading-relaxed">
            {t('emptyDesc')}
          </p>
          <button
            type="button"
            onClick={() => setShowCreateDialog(true)}
            data-testid="empty-create-playlist-btn"
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold text-xs sm:text-sm shadow-lg transition active:scale-95"
          >
            <Plus className="h-4 w-4" />
            <span>{t('createPlaylist')}</span>
          </button>
        </div>
      ) : (
        <div
          data-testid="library-playlists-grid"
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6"
        >
          {playlists.map((pl) => {
            const rawThumb = thumbnails.get(pl.id);
            const coverUrl = rawThumb ? getThumbnailUrl(rawThumb) : null;
            const isWatchLater = pl.kind === 'WATCH_LATER';

            return (
              <Link
                key={pl.id}
                href={`/playlist/${pl.id}`}
                data-testid={`library-playlist-card-${pl.id}`}
                className="group flex flex-col gap-3 rounded-2xl p-3 bg-zinc-900/60 hover:bg-zinc-850 border border-zinc-800/80 hover:border-zinc-700/90 shadow-md hover:shadow-xl transition duration-200"
              >
                {/* Thumbnail Cover 16:9 */}
                <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-zinc-800 shadow-sm">
                  {coverUrl ? (
                    <img
                      src={coverUrl}
                      alt={pl.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="h-full w-full bg-gradient-to-br from-zinc-800 via-zinc-900 to-black flex items-center justify-center">
                      {isWatchLater ? (
                        <Clock className="h-10 w-10 text-zinc-600 group-hover:text-red-500 transition" />
                      ) : (
                        <ListVideo className="h-10 w-10 text-zinc-600 group-hover:text-red-500 transition" />
                      )}
                    </div>
                  )}

                  {/* Item count overlay badge (bottom right) */}
                  <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-xs text-[11px] font-semibold text-white">
                    <ListVideo className="h-3.5 w-3.5" />
                    <span>{pl.item_count} video</span>
                  </div>

                  {/* Watch Later badge (bottom left) */}
                  {isWatchLater && (
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-600/90 backdrop-blur-xs text-[11px] font-bold text-white shadow-sm">
                      <Clock className="h-3.5 w-3.5" />
                      <span>{tPl('watchLater')}</span>
                    </div>
                  )}
                </div>

                {/* Card Info */}
                <div className="flex flex-col gap-1.5 px-0.5">
                  {/* Badges: Visibility & Series */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Visibility badge */}
                    <span
                      data-testid="playlist-visibility-badge"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700/60"
                    >
                      {pl.visibility === 'PUBLIC' ? (
                        <>
                          <Globe className="h-3 w-3 text-emerald-400" />
                          <span>{t('public')}</span>
                        </>
                      ) : pl.visibility === 'UNLISTED' ? (
                        <>
                          <EyeOff className="h-3 w-3 text-amber-400" />
                          <span>{t('unlisted')}</span>
                        </>
                      ) : (
                        <>
                          <Lock className="h-3 w-3 text-red-400" />
                          <span>{t('private')}</span>
                        </>
                      )}
                    </span>

                    {/* Series badge */}
                    {pl.is_series && (
                      <span
                        data-testid="playlist-series-badge"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-red-950/60 border border-red-700/60 text-red-400"
                      >
                        <Film className="h-3 w-3" />
                        <span>{t('seriesBadge')}</span>
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <h3 className="text-sm font-bold text-white line-clamp-1 group-hover:text-red-500 transition mt-0.5">
                    {isWatchLater ? tPl('watchLater') : pl.title}
                  </h3>

                  {/* Updated time */}
                  <span className="text-[11px] text-zinc-500">
                    Cập nhật {formatRelativeTime(pl.updated_at)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination "Tải thêm" */}
      {nextCursor && (
        <div className="flex justify-center pt-4">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            data-testid="load-more-library-btn"
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-semibold transition"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>{t('loadMore')}</span>
          </button>
        </div>
      )}

      {/* Create Playlist Modal */}
      <CreatePlaylistDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={(newPl) => {
          setPlaylists((prev) => [newPl, ...prev]);
        }}
        navigateOnSuccess={true}
      />
    </div>
  );
}
