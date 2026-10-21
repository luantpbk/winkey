'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles, Flame, Upload } from 'lucide-react';
import { api } from '../../../lib/api-client';
import { VideoFeed } from '../../../components/video/video-feed';
import { VideoSkeleton } from '../../../components/video/video-skeleton';
import { Link, useRouter, usePathname } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import type { VideoPage } from '@winkey/api-client';
import { CATEGORY_CHIPS } from '../../../lib/explore-categories';

function getValidCat(cat: string | null): string {
  if (cat && CATEGORY_CHIPS.some((c) => c.id === cat)) {
    return cat;
  }
  return 'all';
}

const VALID_TABS = ['for-you', 'latest', 'trending'] as const;
type TabType = (typeof VALID_TABS)[number];

function isValidTab(tab: string | null): tab is TabType {
  return tab !== null && (VALID_TABS as readonly string[]).includes(tab);
}

function KhamPhaContent() {
  const t = useTranslations('home');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();

  const tabParam = searchParams.get('tab');
  const catParam = searchParams.get('cat');

  const [selectedCat, setSelectedCat] = useState<string>(() => getValidCat(catParam));

  const [activeTab, setActiveTab] = useState<TabType | null>(() => {
    if (isValidTab(tabParam)) {
      return tabParam;
    }
    if (isLoading) {
      return null;
    }
    return user ? 'for-you' : 'latest';
  });

  // Sync state when URL tab or cat param or auth status changes
  useEffect(() => {
    if (isValidTab(tabParam)) {
      setActiveTab(tabParam);
    } else if (!isLoading) {
      setActiveTab(user ? 'for-you' : 'latest');
    }
  }, [tabParam, user, isLoading]);

  useEffect(() => {
    setSelectedCat(getValidCat(catParam));
  }, [catParam]);

  const handleTabChange = (newTab: TabType) => {
    setActiveTab(newTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', newTab);
    const queryString = params.toString();
    router.push(`${pathname}${queryString ? `?${queryString}` : ''}`);
  };

  const handleCatChange = (newCat: string) => {
    setSelectedCat(newCat);
    const params = new URLSearchParams(searchParams.toString());
    if (newCat && newCat !== 'all') {
      params.set('cat', newCat);
    } else {
      params.delete('cat');
    }
    const queryString = params.toString();
    router.push(`${pathname}${queryString ? `?${queryString}` : ''}`);
  };

  const activeChip = CATEGORY_CHIPS.find((c) => c.id === selectedCat);
  const activeTag = activeChip?.tag;

  // 1. "Dành cho bạn" (Recommended) feed fetcher
  const fetchRecommendedPage = async (pageParam: string | null): Promise<VideoPage> => {
    if (activeTag) {
      const {
        data: page,
        error: apiErr,
        response,
      } = await api.video.GET('/v1/videos', {
        params: {
          query: {
            cursor: pageParam || undefined,
            limit: 24,
            tag: activeTag,
          },
        },
      });

      if (!response.ok || !page) {
        throw new Error(apiErr?.detail || 'Failed to fetch videos by category');
      }

      return page as VideoPage;
    }

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
          tag: activeTag,
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
          tag: activeTag,
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
          className={`px-4 min-h-11 inline-flex items-center justify-center text-sm font-semibold transition relative whitespace-nowrap ${
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
          className={`px-4 min-h-11 inline-flex items-center justify-center text-sm font-semibold transition relative whitespace-nowrap ${
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
          className={`px-4 min-h-11 inline-flex items-center justify-center text-sm font-semibold transition relative whitespace-nowrap ${
            activeTab === 'trending'
              ? 'text-red-600 dark:text-red-500 font-bold border-b-2 border-red-600 dark:border-red-500 -mb-[5px]'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          {t('tabs.trending')}
        </button>
      </div>

      {/* Category Pills (YouTube-like) */}
      <div
        role="group"
        aria-label="Thể loại"
        className="flex gap-3 overflow-x-auto pb-4 mb-4 scrollbar-none text-xs font-semibold"
      >
        {CATEGORY_CHIPS.map((chip) => {
          const isSelected = selectedCat === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              aria-pressed={isSelected}
              data-testid={`category-chip-${chip.id}`}
              onClick={() => handleCatChange(chip.id)}
              className={`rounded-lg px-3.5 min-h-11 inline-flex items-center justify-center whitespace-nowrap transition cursor-pointer ${
                isSelected
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'bg-gray-100 dark:bg-[#272727] text-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-[#383838]'
              }`}
            >
              {chip.label}
            </button>
          );
        })}
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
            key={
              selectedCat === 'all'
                ? `feed-for-you-${user?.id ?? 'anon'}`
                : `feed-for-you-${user?.id ?? 'anon'}-${selectedCat}`
            }
            queryKey={
              selectedCat === 'all'
                ? ['feed', 'recommended', user?.id ?? 'anon']
                : ['feed', 'recommended', user?.id ?? 'anon', selectedCat]
            }
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
          key={selectedCat === 'all' ? 'feed-latest' : `feed-latest-${selectedCat}`}
          queryKey={selectedCat === 'all' ? ['feed', 'latest'] : ['feed', 'latest', selectedCat]}
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
          key={selectedCat === 'all' ? 'feed-trending' : `feed-trending-${selectedCat}`}
          queryKey={
            selectedCat === 'all' ? ['feed', 'trending'] : ['feed', 'trending', selectedCat]
          }
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
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5 4xl:grid-cols-6 gap-x-4 gap-y-8 mt-2"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <VideoSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function KhamPhaPage() {
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
      <KhamPhaContent />
    </Suspense>
  );
}
