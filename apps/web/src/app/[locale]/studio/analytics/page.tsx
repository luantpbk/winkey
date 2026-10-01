'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../lib/auth/auth-context';
import type { ChannelStats } from '@winkey/api-client';
import { getStatsDateRange, type StatsRangeOption } from '../../../../lib/analytics/stats-utils';
import { StudioNav } from '../../../../components/studio/studio-nav';
import { StatsRangePicker } from '../../../../components/studio/stats-range-picker';
import { StatsKpiCards } from '../../../../components/studio/stats-kpi-cards';
import { StatsChart } from '../../../../components/studio/stats-chart';
import { TopVideosTable } from '../../../../components/studio/top-videos-table';
import { StatsFooter } from '../../../../components/studio/stats-footer';
import { AlertCircle, Lock, BarChart2 } from 'lucide-react';
import { Link } from '../../../../i18n/routing';

export default function StudioAnalyticsPage() {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [selectedRange, setSelectedRange] = useState<StatsRangeOption>(28);

  const { from, to } = getStatsDateRange(selectedRange);

  const {
    data: stats,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['studio', 'analytics', 'channel', selectedRange, from, to],
    queryFn: async () => {
      const res = await api.video.GET('/v1/studio/stats', {
        params: { query: { from, to } },
      });

      if (res.response.status === 429) {
        throw new Error('RATE_LIMITED');
      }
      if (!res.response.ok || !res.data) {
        const errorData = res.error as { title?: string; detail?: string } | undefined;
        throw new Error(
          errorData?.detail || errorData?.title || 'Failed to load channel statistics',
        );
      }

      return res.data as ChannelStats;
    },
    // The page never calls the API without auth
    enabled: Boolean(!isAuthLoading && isAuthenticated),
    retry: (failureCount, err: Error) => {
      // Don't retry rate limit immediately
      if (err.message === 'RATE_LIMITED') return false;
      return failureCount < 2;
    },
  });

  // 1. Auth required state
  if (!isAuthLoading && !isAuthenticated) {
    return (
      <div className="w-full max-w-[1600px] mx-auto py-6 flex flex-col gap-6">
        <StudioNav />
        <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600/10 text-red-500 mb-3">
            <Lock className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white mb-1">
            Yêu cầu đăng nhập
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Vui lòng đăng nhập tài khoản Creator để xem số liệu thống kê Studio.
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

  return (
    <div className="w-full max-w-[1600px] mx-auto py-6 flex flex-col gap-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BarChart2 className="h-6 w-6 text-red-500" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Thống kê kênh</h1>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Dữ liệu phân tích lượt phát, thời gian xem và chất lượng kỹ thuật của toàn bộ kênh
          </p>
        </div>
      </div>

      {/* Studio Sub Navigation */}
      <StudioNav />

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
          <div className="h-48 rounded-2xl bg-[#1c1c1c] dark:bg-[#1c1c1c] bg-gray-100" />
        </div>
      )}

      {/* Error state: 429 Rate Limit */}
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

      {/* General Error state */}
      {error && (error as Error).message !== 'RATE_LIMITED' && (
        <div
          data-testid="stats-error-general"
          className="flex flex-col items-center justify-center p-8 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400 text-center gap-3"
        >
          <AlertCircle className="h-8 w-8" />
          <div>
            <h3 className="text-sm font-bold">Không thể tải số liệu thống kê</h3>
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
          {/* KPI Cards */}
          <StatsKpiCards totals={stats.totals} />

          {/* Daily Chart */}
          <StatsChart days={stats.days} />

          {/* Top 10 Videos */}
          <TopVideosTable videos={stats.top_videos} />

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
