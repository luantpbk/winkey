'use client';

import React from 'react';
import { Link, usePathname } from '../../i18n/routing';
import { Film, BarChart2 } from 'lucide-react';

export function StudioNav() {
  const pathname = usePathname();

  const isVideos = pathname === '/studio' || pathname === '/studio/';
  const isAnalytics = pathname.startsWith('/studio/analytics');

  return (
    <div className="flex items-center gap-2 border-b border-[#272727] dark:border-[#272727] border-gray-200 mb-6">
      <Link
        href="/studio"
        data-testid="studio-nav-videos"
        className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition -mb-px ${
          isVideos
            ? 'border-red-600 text-red-500 dark:text-white'
            : 'border-transparent text-gray-500 hover:text-gray-300'
        }`}
      >
        <Film className="h-4 w-4" />
        <span>Nội dung</span>
      </Link>

      <Link
        href="/studio/analytics"
        data-testid="studio-nav-analytics"
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
  );
}
