'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { VideoSummary, Playlist } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { CinemaHero } from './cinema-hero';
import { CinemaRow, type CinemaRowItem } from './cinema-row';
import { CinemaDetailDialog } from './cinema-detail-dialog';
import { CinemaSeriesDialog } from './cinema-series-dialog';
import type { WatchSurface } from '../../lib/video/watch-url';
import {
  getContinueWatching,
  removeContinueWatching,
  pruneContinueWatching,
} from '../../lib/video/continue-watching';
import { useTranslations } from 'next-intl';

export interface CinemaViewProps {
  curatorHandle?: string;
  initialVideoId?: string;
  initialSeriesId?: string;
  initialHeroVideos?: VideoSummary[];
  initialSortSource?: 'trending' | 'latest';
}

export function CinemaView({
  curatorHandle,
  initialVideoId,
  initialSeriesId,
  initialHeroVideos,
  initialSortSource = 'trending',
}: CinemaViewProps) {
  const t = useTranslations('cinema');
  const { isAuthenticated } = useAuth();

  // URL detail dialog sync (?v=<id>)
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(initialVideoId || null);
  const [selectedSurface, setSelectedSurface] = useState<WatchSurface>('other');

  // URL series dialog sync (?series=<playlist_id>)
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(initialSeriesId || null);

  // Continue Watching state
  const [continueWatchingVideos, setContinueWatchingVideos] = useState<VideoSummary[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  // Editorial playlists state
  const [editorialPlaylists, setEditorialPlaylists] = useState<Playlist[]>([]);

  // 1. Sync ?v=<id> and ?series=<id> with browser history
  useEffect(() => {
    const handlePopState = () => {
      const url = new URL(window.location.href);
      setSelectedVideoId(url.searchParams.get('v'));
      setSelectedSeriesId(url.searchParams.get('series'));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openDetail = useCallback((id: string, surface: WatchSurface = 'other') => {
    setSelectedVideoId(id);
    setSelectedSurface(surface);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('v', id);
      url.searchParams.delete('series');
      window.history.pushState({ videoId: id }, '', url.toString());
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedVideoId(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('v')) {
        url.searchParams.delete('v');
        window.history.pushState({}, '', url.toString());
      }
    }
  }, []);

  const openSeries = useCallback((playlistId: string) => {
    setSelectedSeriesId(playlistId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('series', playlistId);
      url.searchParams.delete('v');
      window.history.pushState({ seriesId: playlistId }, '', url.toString());
    }
  }, []);

  const closeSeries = useCallback(() => {
    setSelectedSeriesId(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('series')) {
        url.searchParams.delete('series');
        window.history.pushState({}, '', url.toString());
      }
    }
  }, []);

  // Hydrate catalog rows with ONE batchGetVideos call per page, dropping omitted items
  const fetchCatalogRow = useCallback(
    async (kind: 'all' | 'series' | 'video'): Promise<CinemaRowItem[]> => {
      const res = await api.social.GET('/v1/cinema/catalog', {
        params: { query: { kind, limit: 20 } },
      });

      const items = res.data?.items || [];
      if (items.length === 0) return [];

      const ids = items.map((it) =>
        it.kind === 'SERIES' ? it.series.first_video_id : it.video_id,
      );

      const batchRes = await api.video.GET('/v1/videos/batch', {
        params: { query: { ids } },
        querySerializer: { array: { style: 'form', explode: false } },
      });

      const batchVideos = batchRes.data?.items || [];
      const videoMap = new Map<string, VideoSummary>(batchVideos.map((v) => [v.id, v]));

      const result: CinemaRowItem[] = [];
      for (const it of items) {
        if (it.kind === 'SERIES') {
          const coverVideo = videoMap.get(it.series.first_video_id);
          if (coverVideo) {
            result.push({ kind: 'series', series: it.series, coverVideo });
          }
        } else {
          const video = videoMap.get(it.video_id);
          if (video) {
            result.push({ kind: 'video', video });
          }
        }
      }
      return result;
    },
    [],
  );

  // 2. Load Continue Watching entries & fetch batch
  const reloadContinueWatching = useCallback(async () => {
    const entries = getContinueWatching();

    if (entries.length === 0) {
      setContinueWatchingVideos([]);
      setProgressMap({});
      return;
    }

    const ids = entries.map((e) => e.id);
    const pMap: Record<string, number> = {};
    for (const e of entries) {
      if (e.d > 0) {
        pMap[e.id] = (e.t / e.d) * 100;
      }
    }
    setProgressMap(pMap);

    try {
      const res = await api.video.GET('/v1/videos/batch', {
        params: { query: { ids } },
        querySerializer: { array: { style: 'form', explode: false } },
      });

      const batchVideos = res.data?.items || [];
      const validIds = new Set(batchVideos.map((v) => v.id));

      // Drop ids that batchGetVideos did not return, and prune the local index
      pruneContinueWatching(validIds);

      // Keep order of continue watching entries
      const orderedVideos: VideoSummary[] = [];
      for (const e of entries) {
        const found = batchVideos.find((v) => v.id === e.id);
        if (found) orderedVideos.push(found);
      }

      setContinueWatchingVideos(orderedVideos);
    } catch (err) {
      console.warn('[CinemaView] Failed to fetch continue watching batch:', err);
    }
  }, []);

  useEffect(() => {
    reloadContinueWatching();
  }, [reloadContinueWatching]);

  const handleRemoveContinueWatching = useCallback((videoId: string) => {
    removeContinueWatching(videoId);
    setContinueWatchingVideos((prev) => prev.filter((v) => v.id !== videoId));
    setProgressMap((prev) => {
      const updated = { ...prev };
      delete updated[videoId];
      return updated;
    });
  }, []);

  // 3. Load Editorial Playlists if curatorHandle is provided
  useEffect(() => {
    if (!curatorHandle) return;

    let isMounted = true;
    async function loadEditorialPlaylists() {
      try {
        const userRes = await api.auth.GET('/v1/users/{handle}', {
          params: { path: { handle: curatorHandle! } },
        });

        const ownerId = userRes.data?.id;
        if (!ownerId) return;

        const playlistsRes = await api.social.GET('/v1/channels/{channel_id}/playlists', {
          params: { path: { channel_id: ownerId }, query: { limit: 8 } },
        });

        if (isMounted) {
          setEditorialPlaylists(playlistsRes.data?.items || []);
        }
      } catch (err) {
        // Unknown handle (404), empty or no playlists -> no editorial rows and no error
        console.warn('[CinemaView] Editorial curator load notice:', err);
      }
    }

    loadEditorialPlaylists();
    return () => {
      isMounted = false;
    };
  }, [curatorHandle]);

  return (
    <div
      data-testid="cinema-page"
      className="bg-[#0A0A0D] text-[#F4F4F6] min-h-screen pb-20 overflow-x-hidden"
    >
      {/* 1. HERO Full-bleed */}
      <CinemaHero
        initialVideos={initialHeroVideos}
        initialSortSource={initialSortSource}
        onOpenDetail={(id) =>
          openDetail(id, initialSortSource === 'latest' ? 'latest' : 'trending')
        }
      />

      {/* 2. ROWS IN EXACT ORDER */}
      <div className="flex flex-col gap-2 mt-4">
        {/* Row a: "Xem tiếp" (Continue Watching) */}
        {continueWatchingVideos.length > 0 && (
          <CinemaRow
            title={t('continueWatching')}
            surface="other"
            initialVideos={continueWatchingVideos}
            progressMap={progressMap}
            onRemoveItem={handleRemoveContinueWatching}
            onOpenDetail={(id) => openDetail(id, 'other')}
            testId="cinema-row-continue"
          />
        )}

        {/* Row b: "Top 10 hôm nay" */}
        <CinemaRow
          title={t('top10Today')}
          surface="trending"
          isTop10
          minVideos={3}
          fetchVideos={async () => {
            const res = await api.video.GET('/v1/videos', {
              params: { query: { sort: 'trending', limit: 10 } },
            });
            return res.data?.items || [];
          }}
          onOpenDetail={(id) => openDetail(id, 'trending')}
          testId="cinema-row-top10"
        />

        {/* Row c1: "Phim bộ" (Series) */}
        <CinemaRow
          title={t('seriesRowTitle')}
          surface="playlist"
          fetchItems={() => fetchCatalogRow('series')}
          onOpenDetail={(id) => openDetail(id, 'playlist')}
          onOpenSeries={openSeries}
          testId="cinema-row-series"
        />

        {/* Row c2: "Phim lẻ" (Standalone Videos) */}
        <CinemaRow
          title={t('moviesRowTitle')}
          surface="other"
          fetchItems={() => fetchCatalogRow('video')}
          onOpenDetail={(id) => openDetail(id, 'other')}
          onOpenSeries={openSeries}
          testId="cinema-row-movies"
        />

        {/* Row c3: "Mới thêm" (All newest items interleaved) */}
        <CinemaRow
          title={t('newestCatalogRowTitle')}
          surface="latest"
          fetchItems={() => fetchCatalogRow('all')}
          onOpenDetail={(id) => openDetail(id, 'latest')}
          onOpenSeries={openSeries}
          testId="cinema-row-newest-catalog"
        />

        {/* Row c: "Dành cho bạn" (Signed-in only) */}
        {isAuthenticated && (
          <CinemaRow
            title={t('forYou')}
            surface="for_you"
            fetchVideos={async () => {
              const res = await api.video.GET('/v1/feed/recommended', {
                params: { query: { limit: 20 } },
              });
              return res.data?.items || [];
            }}
            onOpenDetail={(id) => openDetail(id, 'for_you')}
            testId="cinema-row-foryou"
          />
        )}

        {/* Row d: "Mới cập nhật" */}
        <CinemaRow
          title={t('newUpdates')}
          surface="latest"
          fetchVideos={async () => {
            const res = await api.video.GET('/v1/videos', {
              params: { query: { sort: 'newest', limit: 20 } },
            });
            return res.data?.items || [];
          }}
          onOpenDetail={(id) => openDetail(id, 'latest')}
          testId="cinema-row-latest"
        />

        {/* Row e: "Từ kênh bạn theo dõi" (Signed-in only) */}
        {isAuthenticated && (
          <CinemaRow
            title={t('fromSubscriptions')}
            surface="subscriptions"
            fetchVideos={async () => {
              const res = await api.video.GET('/v1/feed/subscriptions', {
                params: { query: { limit: 20 } },
              });
              return res.data?.items || [];
            }}
            onOpenDetail={(id) => openDetail(id, 'subscriptions')}
            testId="cinema-row-subscriptions"
          />
        )}

        {/* Row f: EDITORIAL ROWS */}
        {editorialPlaylists.map((pl) => (
          <CinemaRow
            key={pl.id}
            title={pl.title}
            surface="playlist"
            viewAllHref={`/playlist/${pl.id}`}
            fetchVideos={async () => {
              const itemsRes = await api.social.GET('/v1/playlists/{playlist_id}/items', {
                params: { path: { playlist_id: pl.id }, query: { limit: 20 } },
              });
              const items = itemsRes.data?.items || [];
              if (items.length === 0) return [];

              const itemIds = items.map((it) => it.video_id);
              const batchRes = await api.video.GET('/v1/videos/batch', {
                params: { query: { ids: itemIds } },
                querySerializer: { array: { style: 'form', explode: false } },
              });
              const batchVideos = batchRes.data?.items || [];

              // Maintain playlist item order
              const ordered: VideoSummary[] = [];
              for (const it of items) {
                const found = batchVideos.find((v) => v.id === it.video_id);
                if (found) ordered.push(found);
              }
              return ordered;
            }}
            onOpenDetail={(id) => openDetail(id, 'playlist')}
            testId={`cinema-row-editorial-${pl.id}`}
          />
        ))}
      </div>

      {/* 4. DETAIL DIALOG (?v=<id>) */}
      <CinemaDetailDialog
        videoId={selectedVideoId}
        surface={selectedSurface}
        onClose={closeDetail}
        onSelectVideo={(newId) => openDetail(newId, 'up_next')}
      />

      {/* 5. SERIES DETAIL DIALOG (?series=<playlist_id>) */}
      <CinemaSeriesDialog
        playlistId={selectedSeriesId}
        onClose={closeSeries}
      />
    </div>
  );
}
