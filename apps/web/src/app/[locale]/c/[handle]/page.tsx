import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { mockPublicProfiles, mockVideos } from '../../../../mocks/fixtures';
import { VideoCard } from '../../../../components/video/video-card';
import { ChannelClientHeader } from './channel-client';

interface ChannelPageProps {
  params: Promise<{ locale: string; handle: string }>;
}

async function getProfile(handle: string) {
  const profile = mockPublicProfiles[handle];
  return profile || null;
}

export async function generateMetadata({ params }: ChannelPageProps): Promise<Metadata> {
  const { handle } = await params;
  const profile = await getProfile(handle);

  if (!profile) {
    return {
      title: 'Kênh không tồn tại — Winkey',
    };
  }

  return {
    title: `${profile.display_name} (@${profile.handle}) — Winkey`,
    description: `Xem các video mới nhất từ ${profile.display_name} trên Winkey VN.`,
  };
}

export default async function ChannelPage({ params }: ChannelPageProps) {
  const { locale, handle } = await params;
  setRequestLocale(locale);

  const profile = await getProfile(handle);
  if (!profile) {
    notFound();
  }

  const channelVideos = mockVideos.filter((v) => v.owner.handle === handle);

  return (
    <div className="w-full max-w-[1600px] mx-auto flex flex-col gap-6">
      {/* Banner */}
      <div className="h-36 sm:h-52 w-full rounded-2xl overflow-hidden bg-gradient-to-r from-red-900 via-gray-900 to-black relative">
        <div className="absolute inset-0 bg-black/20" />
      </div>

      {/* Profile Header */}
      <ChannelClientHeader profile={profile} videoCount={channelVideos.length} />

      {/* Navigation Tabs */}
      <div className="flex border-b border-[#272727] dark:border-[#272727] border-gray-200 text-sm font-semibold">
        <button className="border-b-2 border-red-600 px-4 py-3 text-red-600">
          Video
        </button>
        <button className="px-4 py-3 text-gray-500 hover:text-gray-900 dark:hover:text-white transition">
          Danh sách phát
        </button>
        <button className="px-4 py-3 text-gray-500 hover:text-gray-900 dark:hover:text-white transition">
          Giới thiệu
        </button>
      </div>

      {/* Video Grid */}
      {channelVideos.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8">
          {channelVideos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center text-gray-500 dark:text-gray-400">
          <p className="text-base">Kênh này chưa có video nào.</p>
        </div>
      )}
    </div>
  );
}
