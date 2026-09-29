import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { Video, VideoSummary, VideoPage } from '@winkey/api-client';
import { VideoPlayer } from '../../../../components/video/video-player';
import { formatViews } from '../../../../lib/format';
import { Link } from '../../../../i18n/routing';
import { WatchClientSection } from './watch-client';

interface WatchPageProps {
  params: Promise<{ locale: string; id: string }>;
}

async function getVideo(id: string): Promise<Video | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/videos/${id}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getRelatedVideos(): Promise<VideoSummary[]> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/videos?limit=10`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return [];
    const data: VideoPage = await res.json();
    return data.items || [];
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: WatchPageProps): Promise<Metadata> {
  const { id } = await params;
  const video = await getVideo(id);

  if (!video) {
    return {
      title: 'Video không tồn tại — Winkey',
      description: 'Video không tìm thấy hoặc đã bị xóa.',
    };
  }

  const thumbUrl = video.playback?.thumbnail_url || 'https://winkey.vn/og-default.jpg';

  return {
    title: `${video.title} — Winkey`,
    description: video.description || 'Xem video trực tuyến trên Winkey VN',
    openGraph: {
      title: video.title,
      description: video.description,
      type: 'video.other',
      url: `https://winkey.vn/watch/${video.id}`,
      images: [
        {
          url: thumbUrl,
          width: 1280,
          height: 720,
          alt: video.title,
        },
      ],
      siteName: 'Winkey',
    },
    twitter: {
      card: 'summary_large_image',
      title: video.title,
      description: video.description,
      images: [thumbUrl],
    },
  };
}

export default async function WatchPage({ params }: WatchPageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const [video, allRelated] = await Promise.all([getVideo(id), getRelatedVideos()]);

  if (!video) {
    notFound();
  }

  const relatedVideos = allRelated.filter((v) => v.id !== id);

  return (
    <div className="w-full max-w-[1800px] mx-auto grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {/* Main player + Video Info */}
      <div className="lg:col-span-2 xl:col-span-3 flex flex-col gap-4">
        {/* Player with Poster */}
        <VideoPlayer
          src={video.playback?.hls_url}
          poster={video.playback?.thumbnail_url}
          title={video.title}
        />

        {/* Video Title */}
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white leading-tight">
          {video.title}
        </h1>

        {/* Client Interactive Section (Owner info, Subscribe, Like, Description) */}
        <WatchClientSection video={video} />
      </div>

      {/* Recommended Sidebar */}
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-bold text-gray-900 dark:text-white">Video liên quan</h2>
        <div className="flex flex-col gap-3">
          {relatedVideos.map((item) => (
            <Link
              key={item.id}
              href={`/watch/${item.id}`}
              className="group flex gap-3 focus:outline-none focus:ring-2 focus:ring-red-600 rounded-xl"
            >
              <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-gray-800">
                <img
                  src={item.thumbnail_url}
                  alt={item.title}
                  className="h-full w-full object-cover group-hover:scale-105 transition duration-200"
                  loading="lazy"
                />
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <h3 className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white line-clamp-2 leading-snug group-hover:text-red-500 transition-colors">
                  {item.title}
                </h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate">
                  {item.owner.display_name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatViews(item.view_count)} lượt xem
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
