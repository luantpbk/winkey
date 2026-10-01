'use client';

import React from 'react';
import { formatRefreshedAt } from '../../lib/analytics/stats-utils';
import { RefreshCw, Info } from 'lucide-react';

interface StatsFooterProps {
  refreshedAt: string | null | undefined;
  onRefresh?: () => void;
  isFetching?: boolean;
}

export function StatsFooter({ refreshedAt, onRefresh, isFetching }: StatsFooterProps) {
  const formattedTime = formatRefreshedAt(refreshedAt);

  return (
    <div
      data-testid="stats-footer"
      className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[#272727] dark:border-[#272727] border-gray-200 text-xs text-gray-500"
    >
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 text-gray-400 shrink-0" />
        <span>
          {formattedTime ? (
            <>
              Cập nhật lúc <strong className="text-gray-300 font-medium">{formattedTime}</strong>
            </>
          ) : (
            <span>Chưa có dữ liệu</span>
          )}
          {' — '}
          <span className="italic text-gray-500">
            Số liệu có thể trễ trong khi máy chủ phân tích ngoại tuyến.
          </span>
        </span>
      </div>

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="Làm mới thống kê"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#383838] dark:border-[#383838] border-gray-300 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#1f1f1f] transition disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span>Làm mới</span>
        </button>
      )}
    </div>
  );
}
