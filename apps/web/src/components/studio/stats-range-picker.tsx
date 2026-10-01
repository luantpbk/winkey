'use client';

import React from 'react';
import { Calendar } from 'lucide-react';

export type StatsRangeOption = 7 | 28 | 90;

interface StatsRangePickerProps {
  selectedRange: StatsRangeOption;
  onChangeRange: (range: StatsRangeOption) => void;
  fromDate?: string;
  toDate?: string;
}

export function StatsRangePicker({
  selectedRange,
  onChangeRange,
  fromDate,
  toDate,
}: StatsRangePickerProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-md">
      {/* Date display info */}
      <div className="flex items-center gap-2.5 text-xs text-gray-400">
        <Calendar className="h-4 w-4 text-red-500" />
        {fromDate && toDate ? (
          <span>
            Khoảng thời gian:{' '}
            <strong className="text-gray-900 dark:text-white font-mono">{fromDate}</strong> đến{' '}
            <strong className="text-gray-900 dark:text-white font-mono">{toDate}</strong>{' '}
            <span className="text-[11px] text-gray-500">(Asia/Ho_Chi_Minh)</span>
          </span>
        ) : (
          <span>Khoảng thời gian thống kê (Asia/Ho_Chi_Minh)</span>
        )}
      </div>

      {/* 7 / 28 / 90 Days buttons */}
      <div className="flex items-center gap-1.5 rounded-xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 p-1 text-xs font-semibold">
        <button
          type="button"
          data-testid="range-btn-7"
          onClick={() => onChangeRange(7)}
          className={`rounded-lg px-3 py-1.5 transition ${
            selectedRange === 7 ? 'bg-red-600 text-white shadow' : 'text-gray-400 hover:text-white'
          }`}
        >
          7 ngày
        </button>
        <button
          type="button"
          data-testid="range-btn-28"
          onClick={() => onChangeRange(28)}
          className={`rounded-lg px-3 py-1.5 transition ${
            selectedRange === 28 ? 'bg-red-600 text-white shadow' : 'text-gray-400 hover:text-white'
          }`}
        >
          28 ngày
        </button>
        <button
          type="button"
          data-testid="range-btn-90"
          onClick={() => onChangeRange(90)}
          className={`rounded-lg px-3 py-1.5 transition ${
            selectedRange === 90 ? 'bg-red-600 text-white shadow' : 'text-gray-400 hover:text-white'
          }`}
        >
          90 ngày
        </button>
      </div>
    </div>
  );
}
