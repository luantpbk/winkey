import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { Video } from '@winkey/api-client';
import { CommentSection } from '../../../../components/social/comment-section';
import { WatchLayout } from '../../../../components/watch/watch-layout';

interface WatchPageProps {
  params: Promise<{ locale: string; id: string }>;
  searchParams?: Promise<{ playlist?: string; src?: string }>;
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

export default async function WatchPage({ params, searchParams }: WatchPageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const video = await getVideo(id);

  if (!video) {
    notFound();
  }

  const searchParamsObj = searchParams ? await searchParams : {};
  const initialPlaylistId = searchParamsObj.playlist;

  return (
    <WatchLayout
      video={video}
      initialPlaylistId={initialPlaylistId}
      commentsSlot={
        <React.Suspense fallback={null}>
          <CommentSection videoId={video.id} />
        </React.Suspense>
      }
    />
  );
}
