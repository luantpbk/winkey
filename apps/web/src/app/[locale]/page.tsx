'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api-client';
import { VideoFeed } from '../../components/video/video-feed';
import type { VideoPage } from '@winkey/api-client';

const CATEGORIES = [
  'Tất cả',
  'Công nghệ',
  'Lập trình',
  'Gaming',
  'Âm nhạc',
  'Trực tiếp',
  'Kiến trúc máy tính',
  'HLS',
];

export default function HomePage() {
  const t = useTranslations('home');

  const fetchPage = async (pageParam: string | null): Promise<VideoPage> => {
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
      throw new Error(apiErr?.detail || 'Failed to fetch video feed');
    }

    return page as VideoPage;
  };

  return (
    <div className="w-full max-w-[2000px] mx-auto">
      {/* Category Pills (YouTube-like) */}
      <div className="flex gap-3 overflow-x-auto pb-4 mb-4 scrollbar-none text-xs font-semibold">
        {CATEGORIES.map((cat, idx) => (
          <button
            key={cat}
            type="button"
            className={`rounded-lg px-3 py-1.5 whitespace-nowrap transition ${
              idx === 0
                ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                : 'bg-gray-100 dark:bg-[#272727] text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-[#383838]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <VideoFeed
        queryKey={['videos', 'feed']}
        fetchPage={fetchPage}
        emptySlot={
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-gray-500 dark:text-gray-400 text-base">{t('noVideos')}</p>
          </div>
        }
      />
    </div>
  );
}
