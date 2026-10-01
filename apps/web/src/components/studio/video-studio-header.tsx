'use client';

import React from 'react';
import { Link, usePathname } from '../../i18n/routing';
import { ArrowLeft, Video as VideoIcon, FileText, BarChart2 } from 'lucide-react';
import type { Video } from '@winkey/api-client';

interface VideoStudioHeaderProps {
  videoId: string;
  video?: Video | null;
  isLoading?: boolean;
}

export function VideoStudioHeader({ videoId, video, isLoading }: VideoStudioHeaderProps) {
  const pathname = usePathname();

  const isAnalytics = pathname.includes('/analytics');
  const isDetails = !isAnalytics;

  return (
    <div className="flex flex-col gap-4">
      {/* Back button */}
      <div>
        <Link
          href="/studio"
          className="inline-flex items-center gap-2 text-xs font-semibold text-gray-500 hover:text-white transition"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Quay lại Studio</span>
        </Link>
      </div>

      {/* Video title and summary header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-md">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-600/10 text-red-500">
            <VideoIcon className="h-5 w-5" />
          </div>
          <div>
            <h1
              data-testid="video-studio-title"
              className="text-base font-bold text-gray-900 dark:text-white line-clamp-1"
            >
              {isLoading ? 'Đang tải...' : video?.title || videoId}
            </h1>
            <span className="text-xs text-gray-500 font-mono">{videoId}</span>
          </div>
        </div>

        {video && (
          <span className="rounded-full bg-green-500/10 border border-green-500/30 px-3 py-1 text-xs font-semibold text-green-400">
            {video.status}
          </span>
        )}
      </div>

      {/* Tabs: Chi tiết vs Thống kê */}
      <div className="flex items-center gap-2 border-b border-[#272727] dark:border-[#272727] border-gray-200">
        <Link
          href={`/studio/videos/${videoId}`}
          data-testid="video-tab-details"
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition -mb-px ${
            isDetails
              ? 'border-red-600 text-red-500 dark:text-white'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          <FileText className="h-4 w-4" />
          <span>Chi tiết</span>
        </Link>

        <Link
          href={`/studio/videos/${videoId}/analytics`}
          data-testid="video-tab-analytics"
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition -mb-px ${
            isAnalytics
              ? 'border-red-600 text-red-500 dark:text-white'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          <BarChart2 className="h-4 w-4" />
          <span>Thống kê</span>
        </Link>
      </div>
    </div>
  );
}
