'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '../../../../../../lib/api-client';
import { useAuth } from '../../../../../../lib/auth/auth-context';
import type { Video, VideoStats } from '@winkey/api-client';
import {
  getStatsDateRange,
  type StatsRangeOption,
} from '../../../../../../lib/analytics/stats-utils';
import { VideoStudioHeader } from '../../../../../../components/studio/video-studio-header';
import { StatsRangePicker } from '../../../../../../components/studio/stats-range-picker';
import { StatsKpiCards } from '../../../../../../components/studio/stats-kpi-cards';
import { StatsChart } from '../../../../../../components/studio/stats-chart';
import { StatsFooter } from '../../../../../../components/studio/stats-footer';
import { AlertCircle, Lock } from 'lucide-react';
import { Link } from '../../../../../../i18n/routing';

export default function StudioVideoAnalyticsPage() {
  const params = useParams();
  const videoId = params?.id as string;
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [selectedRange, setSelectedRange] = useState<StatsRangeOption>(28);

  const { from, to } = getStatsDateRange(selectedRange);

  // 1. Fetch video metadata for header
  const { data: video } = useQuery({
    queryKey: ['video', videoId],
    queryFn: async () => {
      const res = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: videoId } },
      });
      return (res.data as Video) ?? null;
    },
    enabled: Boolean(videoId && !isAuthLoading && isAuthenticated),
  });

  // 2. Fetch video statistics
  const {
    data: stats,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['studio', 'analytics', 'video', videoId, selectedRange, from, to],
    queryFn: async () => {
      const res = await api.video.GET('/v1/studio/videos/{video_id}/stats', {
        params: {
          path: { video_id: videoId },
          query: { from, to },
        },
      });

      if (res.response.status === 404) {
        throw new Error('VIDEO_NOT_FOUND');
      }
      if (res.response.status === 429) {
        throw new Error('RATE_LIMITED');
      }
      if (!res.response.ok || !res.data) {
        const errorData = res.error as { title?: string; detail?: string } | undefined;
        throw new Error(errorData?.detail || errorData?.title || 'Failed to load video statistics');
      }

      return res.data as VideoStats;
    },
    // The page never calls the API without auth
    enabled: Boolean(videoId && !isAuthLoading && isAuthenticated),
    retry: (failureCount, err: Error) => {
      if (err.message === 'VIDEO_NOT_FOUND' || err.message === 'RATE_LIMITED') return false;
      return failureCount < 2;
    },
  });

  // 1. Auth required state
  if (!isAuthLoading && !isAuthenticated) {
    return (
      <div className="w-full max-w-5xl mx-auto py-6 flex flex-col gap-6">
        <VideoStudioHeader videoId={videoId} video={video} />
        <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600/10 text-red-500 mb-3">
            <Lock className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white mb-1">
            Yêu cầu đăng nhập
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Vui lòng đăng nhập để xem số liệu thống kê của video này.
          </p>
          <Link
            href="/login"
            className="rounded-xl bg-red-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-red-700 transition"
          >
            Đăng nhập
          </Link>
        </div>
      </div>
    );
  }

  // Calculate overall startup p50 and p95 across the days range (median and 95th percentile)
  // or take latest non-null day
  const latestP50 = stats?.days.reduce<number | null>((acc, d) => {
    return d.startup_p50_ms !== null ? d.startup_p50_ms : acc;
  }, null);

  const latestP95 = stats?.days.reduce<number | null>((acc, d) => {
    return d.startup_p95_ms !== null ? d.startup_p95_ms : acc;
  }, null);

  return (
    <div className="w-full max-w-5xl mx-auto py-6 flex flex-col gap-6">
      {/* Shared Video Studio Header with Tabs */}
      <VideoStudioHeader videoId={videoId} video={video} isLoading={isLoading} />

      {/* Range Picker */}
      <StatsRangePicker
        selectedRange={selectedRange}
        onChangeRange={setSelectedRange}
        fromDate={from}
        toDate={to}
      />

      {/* Loading Skeleton */}
      {(isLoading || isAuthLoading) && (
        <div data-testid="stats-loading-skeleton" className="flex flex-col gap-6 animate-pulse">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-28 rounded-2xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-100"
              />
            ))}
          </div>
          <div className="h-64 rounded-2xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-100" />
        </div>
      )}

      {/* 404 Video Not Found Error State */}
      {error && (error as Error).message === 'VIDEO_NOT_FOUND' && (
        <div
          data-testid="stats-error-404"
          className="flex flex-col items-center justify-center p-12 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400 text-center gap-3"
        >
          <AlertCircle className="h-10 w-10 text-red-500" />
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-white">
              Không tìm thấy video
            </h3>
            <p className="text-xs text-red-300/80 mt-1">
              Video này không tồn tại hoặc bạn không có quyền xem số liệu thống kê.
            </p>
          </div>
          <Link
            href="/studio"
            className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 transition"
          >
            Quay lại Studio
          </Link>
        </div>
      )}

      {/* 429 Rate Limit Error State */}
      {error && (error as Error).message === 'RATE_LIMITED' && (
        <div
          data-testid="stats-error-429"
          className="flex flex-col items-center justify-center p-8 rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-400 text-center gap-3"
        >
          <AlertCircle className="h-8 w-8" />
          <div>
            <h3 className="text-sm font-bold">Quá nhiều yêu cầu</h3>
            <p className="text-xs text-amber-300/80 mt-1">
              Bạn đang gửi quá nhiều yêu cầu thống kê (giới hạn 60 yêu cầu/phút). Vui lòng thử lại
              sau giây lát.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 transition"
          >
            Thử lại
          </button>
        </div>
      )}

      {/* General Error State */}
      {error &&
        (error as Error).message !== 'VIDEO_NOT_FOUND' &&
        (error as Error).message !== 'RATE_LIMITED' && (
          <div
            data-testid="stats-error-general"
            className="flex flex-col items-center justify-center p-8 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400 text-center gap-3"
          >
            <AlertCircle className="h-8 w-8" />
            <div>
              <h3 className="text-sm font-bold">Lỗi tải dữ liệu</h3>
              <p className="text-xs text-red-300/80 mt-1">{(error as Error).message}</p>
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 transition"
            >
              Thử lại
            </button>
          </div>
        )}

      {/* Main Stats Content */}
      {!isLoading && !error && stats && (
        <div className="flex flex-col gap-6">
          {/* KPI Cards including view_count, startup p50, startup p95 */}
          <StatsKpiCards
            totals={stats.totals}
            viewCount={stats.view_count}
            startupP50Ms={latestP50}
            startupP95Ms={latestP95}
          />

          {/* Daily Chart with viewers toggle */}
          <StatsChart days={stats.days} showViewers={true} />

          {/* Footer */}
          <StatsFooter
            refreshedAt={stats.refreshed_at}
            onRefresh={() => refetch()}
            isFetching={isFetching}
          />
        </div>
      )}
    </div>
  );
}
