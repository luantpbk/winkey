'use client';

import React from 'react';
import type { StatsTotals } from '@winkey/api-client';
import {
  formatStarts,
  formatWatchTime,
  formatAvgWatchTime,
  formatRebufferRatio,
  formatStartupMs,
} from '../../lib/analytics/stats-utils';
import { Play, Clock, Timer, Zap, Eye, Activity, HelpCircle } from 'lucide-react';

interface StatsKpiCardsProps {
  totals: StatsTotals;
  viewCount?: number;
  startupP50Ms?: number | null;
  startupP95Ms?: number | null;
}

export function StatsKpiCards({
  totals,
  viewCount,
  startupP50Ms,
  startupP95Ms,
}: StatsKpiCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {/* 1. Lượt phát (starts) */}
      <div
        data-testid="kpi-starts"
        className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
      >
        <div className="flex items-center justify-between text-gray-400">
          <span className="text-xs font-semibold">Lượt phát</span>
          <Play className="h-4 w-4 text-red-500" />
        </div>
        <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
          {formatStarts(totals.starts)}
        </div>
        <span className="text-[11px] text-gray-500">Số phiên phát bắt đầu</span>
      </div>

      {/* 2. Thời gian xem (watch_time_ms) */}
      <div
        data-testid="kpi-watch-time"
        className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
      >
        <div className="flex items-center justify-between text-gray-400">
          <span className="text-xs font-semibold">Thời gian xem (giờ)</span>
          <Clock className="h-4 w-4 text-blue-500" />
        </div>
        <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
          {formatWatchTime(totals.watch_time_ms)}
        </div>
        <span className="text-[11px] text-gray-500">Định dạng h:mm</span>
      </div>

      {/* 3. Thời gian xem trung bình (avg_watch_ms) */}
      <div
        data-testid="kpi-avg-watch"
        className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
      >
        <div className="flex items-center justify-between text-gray-400">
          <span className="text-xs font-semibold">Thời gian xem TB</span>
          <Timer className="h-4 w-4 text-emerald-500" />
        </div>
        <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
          {formatAvgWatchTime(totals.avg_watch_ms)}
        </div>
        <span className="text-[11px] text-gray-500">
          {totals.avg_watch_ms === null ? '— khi không có lượt phát' : 'Định dạng m:ss'}
        </span>
      </div>

      {/* 4. Tỉ lệ giật hình (rebuffer_ratio) */}
      <div
        data-testid="kpi-rebuffer-ratio"
        className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
      >
        <div className="flex items-center justify-between text-gray-400">
          <span className="text-xs font-semibold">Tỉ lệ giật hình</span>
          <Zap className="h-4 w-4 text-amber-500" />
        </div>
        <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
          {formatRebufferRatio(totals.rebuffer_ratio)}
        </div>
        <span className="text-[11px] text-gray-500">
          {totals.rebuffer_ratio === null ? '— khi không có phát' : 'Tỉ lệ thời gian chờ đệm'}
        </span>
      </div>

      {/* Video-specific KPI cards */}
      {viewCount !== undefined && (
        <div
          data-testid="kpi-view-count"
          className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
        >
          <div className="flex items-center justify-between text-gray-400">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold">Lượt xem đã tính</span>
              <span
                className="group relative cursor-pointer"
                title="Lượt xem hợp lệ sau khi lọc gian lận (lifetime count), khác với số phiên phát (starts)."
              >
                <HelpCircle className="h-3.5 w-3.5 text-gray-500" />
              </span>
            </div>
            <Eye className="h-4 w-4 text-purple-500" />
          </div>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            {formatStarts(viewCount)}
          </div>
          <span className="text-[11px] text-gray-500">Tổng toàn thời gian</span>
        </div>
      )}

      {startupP50Ms !== undefined && (
        <div
          data-testid="kpi-startup-p50"
          className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
        >
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-semibold">Khởi động P50</span>
            <Activity className="h-4 w-4 text-teal-500" />
          </div>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            {formatStartupMs(startupP50Ms)}
          </div>
          <span className="text-[11px] text-gray-500">Độ trễ phát P50</span>
        </div>
      )}

      {startupP95Ms !== undefined && (
        <div
          data-testid="kpi-startup-p95"
          className="flex flex-col gap-1 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-4 shadow-md"
        >
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-semibold">Khởi động P95</span>
            <Activity className="h-4 w-4 text-rose-500" />
          </div>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            {formatStartupMs(startupP95Ms)}
          </div>
          <span className="text-[11px] text-gray-500">Độ trễ phát P95</span>
        </div>
      )}
    </div>
  );
}
