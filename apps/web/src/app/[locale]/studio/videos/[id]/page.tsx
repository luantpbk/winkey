'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '../../../../../lib/api-client';
import type { Video } from '@winkey/api-client';
import { VideoSubtitlesSection } from '../../../../../components/studio/video-subtitles-section';
import { VideoStudioHeader } from '../../../../../components/studio/video-studio-header';

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
      <VideoStudioHeader videoId={id} video={video} isLoading={isLoading} />

      {/* Phụ đề Section */}
      <div className="p-6 rounded-2xl bg-[#141414] dark:bg-[#141414] bg-white border border-[#272727] dark:border-[#272727] border-gray-200 shadow-xl">
        <VideoSubtitlesSection videoId={id} initialVideo={video} />
      </div>
    </div>
  );
}
