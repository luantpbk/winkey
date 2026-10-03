import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { Video } from '@winkey/api-client';
import { VideoPlayer } from '../../../../components/video/video-player';
import { CommentSection } from '../../../../components/social/comment-section';
import { RelatedVideosColumn } from '../../../../components/video/related-videos-column';
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

  const video = await getVideo(id);

  if (!video) {
    notFound();
  }

  return (
    <div className="w-full max-w-[1800px] mx-auto grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {/* Main player + Video Info */}
      <div className="lg:col-span-2 xl:col-span-3 flex flex-col gap-4">
        {/* Player with Poster */}
        <VideoPlayer
          videoId={video.id}
          durationMs={video.duration_ms}
          src={video.playback?.hls_url}
          poster={video.playback?.thumbnail_url}
          title={video.title}
          renditions={video.playback?.renditions}
          subtitles={video.playback?.subtitles}
          storyboardUrl={video.playback?.storyboard_url}
          expiresAt={video.playback?.expires_at}
        />

        {/* Video Title */}
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white leading-tight">
          {video.title}
        </h1>

        {/* Client Interactive Section (Owner info, Subscribe, Like, Description) */}
        <WatchClientSection video={video} />
      </div>

      {/* Related Videos Column:
          - desktop (≥ 1024 px): right of the player, beside the description/comments;
          - mobile (< 1024 px): under the player and the description, before the comments.
      */}
      <div className="lg:col-span-1 xl:col-span-1 lg:row-span-2">
        <RelatedVideosColumn videoId={video.id} />
      </div>

      {/* Comments Section */}
      <div className="lg:col-span-2 xl:col-span-3">
        <React.Suspense fallback={null}>
          <CommentSection videoId={video.id} />
        </React.Suspense>
      </div>
    </div>
  );
}
