'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Tv, Flame } from 'lucide-react';
import { useRouter, Link } from '../../../../i18n/routing';
import { useAuth } from '../../../../lib/auth/auth-context';
import { api } from '../../../../lib/api-client';
import { VideoFeed } from '../../../../components/video/video-feed';
import type { VideoPage } from '@winkey/api-client';

export default function SubscriptionsFeedPage() {
  const t = useTranslations('subscriptions');
  const router = useRouter();
  const { user, isAuthenticated, isLoading: isAuthLoading, clearSession } = useAuth();

  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.push('/login?return_to=/feed/subscriptions');
    }
  }, [isAuthLoading, isAuthenticated, router]);

  if (isAuthLoading || !isAuthenticated || !user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  const fetchPage = async (pageParam: string | null): Promise<VideoPage> => {
    const {
      data: page,
      error: apiErr,
      response,
    } = await api.video.GET('/v1/feed/subscriptions', {
      params: {
        query: {
          cursor: pageParam || undefined,
          limit: 12,
        },
      },
    });

    if (response.status === 401) {
      clearSession();
      router.push('/login?return_to=/feed/subscriptions');
      throw new Error('Unauthorized');
    }

    if (!response.ok || !page) {
      throw new Error(apiErr?.detail || 'Failed to fetch subscription feed');
    }

    return page as VideoPage;
  };

  return (
    <div className="w-full max-w-[2000px] mx-auto">
      {/* Page Header */}
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-200 dark:border-[#272727]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
          <Tv className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('title')}
          </h1>
        </div>
      </div>

      <VideoFeed
        queryKey={['feed', 'subscriptions']}
        fetchPage={fetchPage}
        staleTime={0}
        emptySlot={
          <div
            data-testid="subscriptions-empty-state"
            className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto"
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 text-red-500 mb-4">
              <Tv className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t('emptyTitle')}
            </h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">{t('emptyDescription')}</p>
            <Link
              href="/trending"
              className="inline-flex items-center gap-2 rounded-full bg-red-600 px-6 py-2.5 text-sm font-semibold text-white shadow hover:bg-red-700 transition"
            >
              <Flame className="h-4 w-4" />
              <span>{t('exploreTrending')}</span>
            </Link>
          </div>
        }
      />
    </div>
  );
}
