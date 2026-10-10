import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { Video } from '@winkey/api-client';
import { CommentSection } from '../../../../components/social/comment-section';
import { WatchLayout } from '../../../../components/watch/watch-layout';
import {
  buildVideoObjectSchema,
  buildBreadcrumbListSchema,
  formatMetaDescription,
} from '../../../../lib/seo/video-schema';

interface WatchPageProps {
  params: Promise<{ locale: string; id: string }>;
  searchParams?: Promise<{ playlist?: string; src?: string }>;
}

async function getVideo(id: string): Promise<Video | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/videos/${id}`, {
      cache: 'no-store',
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
      title: 'Video không tồn tại – Winkey',
      description: 'Video không tìm thấy hoặc đã bị xóa.',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const isPublic = video.visibility === 'PUBLIC';
  const metaDescription = formatMetaDescription(video.description);
  const thumbUrl = video.playback?.thumbnail_url || 'https://winkey.vn/og-default.jpg';
  const watchUrl = `https://winkey.vn/watch/${video.id}`;

  return {
    title: `${video.title} – Winkey`,
    description: metaDescription,
    alternates: {
      canonical: watchUrl,
      languages: {
        vi: `https://winkey.vn/vi/watch/${video.id}`,
        en: `https://winkey.vn/en/watch/${video.id}`,
      },
    },
    robots: isPublic
      ? {
          index: true,
          follow: true,
        }
      : {
          index: false,
          follow: false,
        },
    openGraph: {
      title: `${video.title} – Winkey`,
      description: metaDescription,
      type: 'video.other',
      url: watchUrl,
      videos: [watchUrl],
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
      title: `${video.title} – Winkey`,
      description: metaDescription,
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

  const isPublic = video.visibility === 'PUBLIC';
  const videoObjectSchema = isPublic ? buildVideoObjectSchema(video) : null;
  const breadcrumbSchema = isPublic ? buildBreadcrumbListSchema(video) : null;

  const searchParamsObj = searchParams ? await searchParams : {};
  const initialPlaylistId = searchParamsObj.playlist;

  return (
    <>
      {videoObjectSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(videoObjectSchema),
          }}
        />
      )}
      {breadcrumbSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(breadcrumbSchema),
          }}
        />
      )}
      <WatchLayout
        video={video}
        initialPlaylistId={initialPlaylistId}
        commentsSlot={
          <React.Suspense fallback={null}>
            <CommentSection videoId={video.id} />
          </React.Suspense>
        }
      />
    </>
  );
}
