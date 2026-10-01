import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { PublicProfile, VideoSummary, VideoPage } from '@winkey/api-client';
import { ChannelClientHeader } from './channel-client';
import { ChannelTabs } from './channel-tabs';

interface ChannelPageProps {
  params: Promise<{ locale: string; handle: string }>;
}

async function getProfile(handle: string): Promise<PublicProfile | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/users/${handle}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getChannelVideos(handle: string): Promise<VideoSummary[]> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/videos?limit=50`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const data: VideoPage = await res.json();
    return (data.items || []).filter((v) => v.owner.handle === handle);
  } catch {
    return [];
  }
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

  const [profile, channelVideos] = await Promise.all([
    getProfile(handle),
    getChannelVideos(handle),
  ]);

  if (!profile) {
    notFound();
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto flex flex-col gap-6">
      {/* Banner */}
      <div className="h-36 sm:h-52 w-full rounded-2xl overflow-hidden bg-gradient-to-r from-red-900 via-gray-900 to-black relative">
        <div className="absolute inset-0 bg-black/20" />
      </div>

      {/* Profile Header */}
      <ChannelClientHeader profile={profile} videoCount={channelVideos.length} />

      {/* Interactive Tabs (Videos, Playlists, About) */}
      <ChannelTabs profile={profile} initialVideos={channelVideos} />
    </div>
  );
}
