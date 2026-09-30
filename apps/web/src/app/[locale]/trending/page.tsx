'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Flame } from 'lucide-react';
import { api } from '../../../lib/api-client';
import { VideoFeed } from '../../../components/video/video-feed';
import { VideoCard } from '../../../components/video/video-card';
import type { VideoPage } from '@winkey/api-client';

export default function TrendingPage() {
  const t = useTranslations('trending');

  const fetchTrendingPage = async (pageParam: string | null): Promise<VideoPage> => {
    const {
      data: page,
      error: apiErr,
      response,
    } = await api.video.GET('/v1/videos', {
      params: {
        query: {
          sort: 'trending',
          cursor: pageParam || undefined,
          limit: 12,
        },
      },
    });

    if (!response.ok || !page) {
      throw new Error(apiErr?.detail || 'Failed to fetch trending videos');
    }

    return page as VideoPage;
  };

  const fetchNewestPage = async (pageParam: string | null): Promise<VideoPage> => {
    const {
      data: page,
      error: apiErr,
      response,
    } = await api.video.GET('/v1/videos', {
      params: {
        query: {
          cursor: pageParam || undefined,
          limit: 12,
        },
      },
    });

    if (!response.ok || !page) {
      throw new Error(apiErr?.detail || 'Failed to fetch newest videos');
    }

    return page as VideoPage;
  };

  return (
    <div className="w-full max-w-[2000px] mx-auto">
      {/* Page Header */}
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-200 dark:border-[#272727]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
          <Flame className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('title')}
          </h1>
        </div>
      </div>

      <VideoFeed
        queryKey={['videos', 'trending']}
        fetchPage={fetchTrendingPage}
        staleTime={60_000}
        renderItem={(video, index) => <VideoCard key={video.id} video={video} rank={index + 1} />}
        emptySlot={
          <div className="space-y-6">
            <div
              data-testid="empty-trending-notice"
              className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-700 dark:text-amber-300 font-medium"
            >
              {t('emptyNotice')}
            </div>
            <VideoFeed queryKey={['videos', 'feed']} fetchPage={fetchNewestPage} />
          </div>
        }
      />
    </div>
  );
}
