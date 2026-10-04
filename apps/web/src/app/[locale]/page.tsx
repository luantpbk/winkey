'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles, Flame, Upload } from 'lucide-react';
import { api } from '../../lib/api-client';
import { VideoFeed } from '../../components/video/video-feed';
import { VideoSkeleton } from '../../components/video/video-skeleton';
import { Link, useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
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

const VALID_TABS = ['for-you', 'latest', 'trending'] as const;
type TabType = (typeof VALID_TABS)[number];

function isValidTab(tab: string | null): tab is TabType {
  return tab !== null && (VALID_TABS as readonly string[]).includes(tab);
}

function HomeContent() {
  const t = useTranslations('home');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();

  const tabParam = searchParams.get('tab');

  const [activeTab, setActiveTab] = useState<TabType | null>(() => {
    if (isValidTab(tabParam)) {
      return tabParam;
    }
    if (isLoading) {
      return null;
    }
    return user ? 'for-you' : 'latest';
  });

  // Sync state when URL tab param or auth status changes
  useEffect(() => {
    if (isValidTab(tabParam)) {
      setActiveTab(tabParam);
    } else if (!isLoading) {
      setActiveTab(user ? 'for-you' : 'latest');
    }
  }, [tabParam, user, isLoading]);

  const handleTabChange = (newTab: TabType) => {
    setActiveTab(newTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', newTab);
    router.push(`${pathname}?${params.toString()}`);
  };

  // 1. "Dành cho bạn" (Recommended) feed fetcher
  const fetchRecommendedPage = async (pageParam: string | null): Promise<VideoPage> => {
    const {
      data: page,
      error: apiErr,
      response,
    } = await api.video.GET('/v1/feed/recommended', {
      params: {
        query: {
          cursor: pageParam || undefined,
          limit: 24,
        },
      },
    });

    if (!response.ok || !page) {
      throw new Error(apiErr?.detail || 'Failed to fetch recommended feed');
    }

    return page as VideoPage;
  };

  // 2. "Mới nhất" (Latest) feed fetcher
  const fetchLatestPage = async (pageParam: string | null): Promise<VideoPage> => {
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

  // 3. "Thịnh hành" (Trending) feed fetcher
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

  return (
    <div className="w-full max-w-[2000px] mx-auto">
      {/* Feed Tabs: Dành cho bạn | Mới nhất | Thịnh hành */}
      <div
        role="tablist"
        aria-label={t('feedTabs')}
        className="flex items-center gap-2 border-b border-gray-200 dark:border-[#272727] mb-4 pb-1 overflow-x-auto scrollbar-none"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'for-you'}
          data-testid="tab-for-you"
          onClick={() => handleTabChange('for-you')}
          className={`px-4 py-2 text-sm font-semibold transition relative whitespace-nowrap ${
            activeTab === 'for-you'
              ? 'text-red-600 dark:text-red-500 font-bold border-b-2 border-red-600 dark:border-red-500 -mb-[5px]'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          {t('tabs.forYou')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'latest'}
          data-testid="tab-latest"
          onClick={() => handleTabChange('latest')}
          className={`px-4 py-2 text-sm font-semibold transition relative whitespace-nowrap ${
            activeTab === 'latest'
              ? 'text-red-600 dark:text-red-500 font-bold border-b-2 border-red-600 dark:border-red-500 -mb-[5px]'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          {t('tabs.latest')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'trending'}
          data-testid="tab-trending"
          onClick={() => handleTabChange('trending')}
          className={`px-4 py-2 text-sm font-semibold transition relative whitespace-nowrap ${
            activeTab === 'trending'
              ? 'text-red-600 dark:text-red-500 font-bold border-b-2 border-red-600 dark:border-red-500 -mb-[5px]'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          {t('tabs.trending')}
        </button>
      </div>

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

      {/* Tab: Dành cho bạn */}
      {activeTab === 'for-you' &&
        (isLoading ? (
          <div
            data-testid="feed-skeleton"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8 mt-2"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <VideoSkeleton key={i} />
            ))}
          </div>
        ) : (
          <VideoFeed
            key={`feed-for-you-${user?.id ?? 'anon'}`}
            queryKey={['feed', 'recommended', user?.id ?? 'anon']}
            fetchPage={fetchRecommendedPage}
            staleTime={5 * 60 * 1000}
            surface="for_you"
            emptySlot={
              <div
                data-testid="for-you-empty-state"
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 dark:bg-[#272727] text-amber-500 mb-4">
                  <Sparkles className="h-8 w-8" />
                </div>
                <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
                  {t('forYouEmptyTitle')}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mb-6">
                  {t('forYouEmptyDesc')}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleTabChange('trending')}
                    data-testid="empty-trending-btn"
                    className="inline-flex items-center gap-2 rounded-full bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 text-sm font-semibold transition"
                  >
                    <Flame className="h-4 w-4" />
                    {t('exploreTrending')}
                  </button>
                  <Link
                    href="/upload"
                    data-testid="empty-upload-link"
                    className="inline-flex items-center gap-2 rounded-full bg-gray-100 dark:bg-[#272727] hover:bg-gray-200 dark:hover:bg-[#383838] text-gray-800 dark:text-gray-200 px-5 py-2.5 text-sm font-semibold transition"
                  >
                    <Upload className="h-4 w-4" />
                    {t('uploadVideo')}
                  </Link>
                </div>
              </div>
            }
          />
        ))}

      {/* Tab: Mới nhất */}
      {activeTab === 'latest' && (
        <VideoFeed
          key="feed-latest"
          queryKey={['feed', 'latest']}
          fetchPage={fetchLatestPage}
          staleTime={5 * 60 * 1000}
          surface="latest"
          emptySlot={
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-gray-500 dark:text-gray-400 text-base">{t('noVideos')}</p>
            </div>
          }
        />
      )}

      {/* Tab: Thịnh hành */}
      {activeTab === 'trending' && (
        <VideoFeed
          key="feed-trending"
          queryKey={['feed', 'trending']}
          fetchPage={fetchTrendingPage}
          staleTime={5 * 60 * 1000}
          surface="trending"
          emptySlot={
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-gray-500 dark:text-gray-400 text-base">{t('noVideos')}</p>
            </div>
          }
        />
      )}

      {/* Loading skeleton while determining default tab */}
      {activeTab === null && (
        <div
          data-testid="feed-skeleton"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8 mt-2"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <VideoSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="w-full max-w-[2000px] mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8 mt-12">
            {Array.from({ length: 8 }).map((_, i) => (
              <VideoSkeleton key={i} />
            ))}
          </div>
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
