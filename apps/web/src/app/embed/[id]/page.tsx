import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Video } from '@winkey/api-client';
import { VideoPlayer } from '../../../components/video/video-player';
import { MswProvider } from '../../../mocks/msw-provider';

interface EmbedPageProps {
  params: Promise<{ id: string }>;
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

export async function generateMetadata({ params }: EmbedPageProps): Promise<Metadata> {
  const { id } = await params;
  const video = await getVideo(id);

  if (!video || video.visibility !== 'PUBLIC') {
    notFound();
    return {};
  }

  const watchUrl = `https://winkey.vn/watch/${video.id}`;

  return {
    title: video.title,
    alternates: {
      canonical: watchUrl,
    },
  };
}

export default async function EmbedPage({ params }: EmbedPageProps) {
  const { id } = await params;
  const video = await getVideo(id);

  if (!video || video.visibility !== 'PUBLIC') {
    notFound();
    return null;
  }

  const watchUrl = `https://winkey.vn/watch/${video.id}`;

  return (
    <html lang="vi" className="dark">
      <body className="bg-black m-0 p-0 overflow-hidden w-screen h-screen">
        <MswProvider>
          <main className="relative w-screen h-screen overflow-hidden bg-black flex items-center justify-center">
            <VideoPlayer
              videoId={video.id}
              durationMs={video.duration_ms}
              src={video.playback?.hls_url}
              hlsAv1Url={video.playback?.hls_av1_url}
              poster={video.playback?.thumbnail_url}
              title={video.title}
              renditions={video.playback?.renditions}
              subtitles={video.playback?.subtitles}
              audioTracks={video.playback?.audio_tracks}
              storyboardUrl={video.playback?.storyboard_url}
              expiresAt={video.playback?.expires_at}
              className="w-full h-full rounded-none"
            />
            <a
              href={watchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute top-3 right-3 z-40 px-2.5 py-1 rounded bg-black/70 hover:bg-black text-white text-xs font-semibold backdrop-blur transition pointer-events-auto shadow"
            >
              Winkey
            </a>
          </main>
        </MswProvider>
      </body>
    </html>
  );
}
