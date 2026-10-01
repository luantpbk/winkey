'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Link } from '../../../../../i18n/routing';
import { api } from '../../../../../lib/api-client';
import { ArrowLeft, Video as VideoIcon } from 'lucide-react';
import type { Video } from '@winkey/api-client';
import { VideoSubtitlesSection } from '../../../../../components/studio/video-subtitles-section';

export default function StudioVideoPage() {
  const params = useParams();
  const id = params?.id as string;

  const { data: video, isLoading } = useQuery({
    queryKey: ['video', id],
    queryFn: async () => {
      const { data, response } = await api.video.GET('/v1/videos/{video_id}', {
        params: { path: { video_id: id } },
      });
      if (!response.ok || !data) {
        throw new Error('Video not found');
      }
      return data as Video;
    },
    enabled: !!id,
  });

  return (
    <div className="w-full max-w-5xl mx-auto py-6 flex flex-col gap-6">
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
            <h1 className="text-base font-bold text-gray-900 dark:text-white line-clamp-1">
              {isLoading ? 'Đang tải...' : video?.title || id}
            </h1>
            <span className="text-xs text-gray-500 font-mono">{id}</span>
          </div>
        </div>

        {video && (
          <span className="rounded-full bg-green-500/10 border border-green-500/30 px-3 py-1 text-xs font-semibold text-green-400">
            {video.status}
          </span>
        )}
      </div>

      {/* Phụ đề Section */}
      <div className="p-6 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-xl">
        <VideoSubtitlesSection videoId={id} initialVideo={video} />
      </div>
    </div>
  );
}
