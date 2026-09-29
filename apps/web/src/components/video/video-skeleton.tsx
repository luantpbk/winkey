import React from 'react';

export function VideoSkeleton() {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      {/* Thumbnail placeholder */}
      <div className="aspect-video w-full rounded-xl bg-[#272727] dark:bg-[#272727] bg-gray-200" />

      {/* Info placeholder */}
      <div className="flex gap-3">
        <div className="h-9 w-9 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-200 shrink-0" />
        <div className="flex flex-col flex-1 gap-2">
          <div className="h-4 w-5/6 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
          <div className="h-3 w-1/2 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
          <div className="h-3 w-1/3 rounded bg-[#272727] dark:bg-[#272727] bg-gray-200" />
        </div>
      </div>
    </div>
  );
}
