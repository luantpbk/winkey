'use client';

import React from 'react';
import type { ChannelStatsTopVideo } from '@winkey/api-client';
import { Link } from '../../i18n/routing';
import { formatStarts, formatWatchTime } from '../../lib/analytics/stats-utils';
import { PlaySquare, ChevronRight } from 'lucide-react';

interface TopVideosTableProps {
  videos: ChannelStatsTopVideo[];
}

export function TopVideosTable({ videos }: TopVideosTableProps) {
  if (!videos || videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white text-center text-sm text-gray-500">
        <PlaySquare className="h-8 w-8 text-gray-600 mb-2" />
        <p>Không có video nào có lượt phát trong khoảng thời gian này.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between border-b border-[#272727] dark:border-[#272727] border-gray-200 pb-3">
        <h3 className="text-sm font-bold text-gray-900 dark:text-white">
          Top 10 video xem nhiều nhất
        </h3>
        <span className="text-xs text-gray-500">Xếp hạng theo thời gian xem</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="top-videos-table">
          <thead className="border-b border-[#272727] dark:border-[#272727] border-gray-200 text-xs font-semibold text-gray-500 uppercase">
            <tr>
              <th className="py-2.5 px-3 w-12 text-center">#</th>
              <th className="py-2.5 px-3">Video</th>
              <th className="py-2.5 px-3 text-right">Lượt phát</th>
              <th className="py-2.5 px-3 text-right">Thời gian xem</th>
              <th className="py-2.5 px-3 w-12"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#242424] dark:divide-[#242424] divide-gray-100">
            {videos.map((item, index) => (
              <tr
                key={item.video_id}
                data-testid={`top-video-row-${item.video_id}`}
                className="group hover:bg-[#1c1c1c] dark:hover:bg-[#1c1c1c] hover:bg-gray-50 transition"
              >
                <td className="py-3 px-3 text-center text-xs font-bold text-gray-400">
                  {index + 1}
                </td>
                <td className="py-3 px-3">
                  <Link
                    href={`/studio/videos/${item.video_id}/analytics`}
                    data-testid={`top-video-link-${item.video_id}`}
                    className="flex flex-col font-medium text-gray-900 dark:text-white hover:text-red-500 transition line-clamp-1"
                  >
                    <span>{item.title}</span>
                    <span className="text-[11px] text-gray-500 font-mono">{item.video_id}</span>
                  </Link>
                </td>
                <td className="py-3 px-3 text-right font-medium text-gray-700 dark:text-gray-300">
                  {formatStarts(item.starts)}
                </td>
                <td className="py-3 px-3 text-right font-medium text-gray-700 dark:text-gray-300">
                  {formatWatchTime(item.watch_time_ms)}
                </td>
                <td className="py-3 px-3 text-center">
                  <Link
                    href={`/studio/videos/${item.video_id}/analytics`}
                    aria-label={`Xem thống kê video ${item.title}`}
                    className="inline-flex items-center justify-center p-1.5 text-gray-500 group-hover:text-red-500 transition"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
