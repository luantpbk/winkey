'use client';

import React, { useState } from 'react';
import type { VideoSummary } from '@winkey/api-client';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api-client';
import { VideoCard } from '../video/video-card';
import { Loader2 } from 'lucide-react';

export interface TagVideosClientProps {
  initialVideos: VideoSummary[];
  initialCursor: string | null;
  tagSlug: string;
}

export function TagVideosClient({ initialVideos, initialCursor, tagSlug }: TagVideosClientProps) {
  const t = useTranslations('tag');
  const [videos, setVideos] = useState<VideoSummary[]>(initialVideos);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoadMore = async () => {
    if (!cursor || isLoadingMore) return;

    setIsLoadingMore(true);
    setError(null);

    try {
      const res = await api.video.GET('/v1/videos', {
        params: {
          query: {
            tag: tagSlug,
            limit: 24,
            cursor,
          },
        },
      });

      if (res.data) {
        const newItems = res.data.items || [];
        setVideos((prev) => [...prev, ...newItems]);
        setCursor(res.data.next_cursor ?? null);
      } else {
        setError('Không thể tải thêm video');
      }
    } catch {
      setError('Lỗi kết nối khi tải thêm video');
    } finally {
      setIsLoadingMore(false);
    }
  };

  if (videos.length === 0) {
    return (
      <div className="py-12 text-center text-gray-500 dark:text-gray-400">
        <p>{t('noVideos')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div
        data-testid="tag-video-grid"
        className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-6"
      >
        {videos.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>

      {cursor && (
        <div className="flex flex-col items-center justify-center gap-2 pt-4 pb-8">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={isLoadingMore}
            data-testid="tag-load-more-btn"
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-sm font-semibold text-white transition disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('loadingMore')}</span>
              </>
            ) : (
              <span>{t('loadMore')}</span>
            )}
          </button>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
