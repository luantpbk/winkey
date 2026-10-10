import React, { cache } from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { VideoSummary } from '@winkey/api-client';
import { getBaseUrl } from '../../lib/api-client';
import { CinemaView } from '../../components/cinema/cinema-view';

// Read process.env at request time, not at build time
export const dynamic = 'force-dynamic';

interface CinemaPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ v?: string; series?: string }>;
}

async function getHeroInitialVideos(): Promise<{
  videos: VideoSummary[];
  sortSource: 'trending' | 'latest';
}> {
  const baseUrl = getBaseUrl();

  // 1. Try trending with 60s revalidation cache
  try {
    const res = await fetch(`${baseUrl}/v1/videos?sort=trending&limit=5`, {
      next: { revalidate: 60 },
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        return { videos: data.items, sortSource: 'trending' };
      }
    }
  } catch {
    // Trending failed or network error, fallback to newest below
  }

  // 2. Fallback to newest with 60s revalidation cache
  try {
    const res = await fetch(`${baseUrl}/v1/videos?sort=newest&limit=5`, {
      next: { revalidate: 60 },
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        return { videos: data.items, sortSource: 'latest' };
      }
    }
  } catch {
    // Fallback failed
  }

  return { videos: [], sortSource: 'trending' };
}

// React cache ensures generateMetadata and CinemaPage share the exact same result
const fetchInitialHero = cache(async () => {
  return getHeroInitialVideos();
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);

  const { videos } = await fetchInitialHero();
  const firstVideo = videos[0];

  const title = 'Winkey – Xem video, phim và clip';
  const description = firstVideo?.title
    ? `${firstVideo.title} — Xem video, phim và clip đặc sắc trên Winkey.`
    : 'Nền tảng xem video, phim và clip trực tuyến với chất lượng cao.';

  const ogImages = firstVideo?.thumbnail_url
    ? [{ url: firstVideo.thumbnail_url, width: 1280, height: 720, alt: firstVideo.title }]
    : [];

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ogImages,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ogImages.map((img) => img.url),
    },
  };
}

export default async function CinemaPage({ params, searchParams }: CinemaPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { v: initialVideoId, series: initialSeriesId } = await searchParams;
  const curatorHandle = process.env.CINEMA_CURATOR_HANDLE || '';

  const { videos, sortSource } = await fetchInitialHero();

  return (
    <CinemaView
      curatorHandle={curatorHandle}
      initialVideoId={initialVideoId}
      initialSeriesId={initialSeriesId}
      initialHeroVideos={videos}
      initialSortSource={sortSource}
    />
  );
}
