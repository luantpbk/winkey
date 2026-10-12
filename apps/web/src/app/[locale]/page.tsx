import React, { cache } from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import type { VideoSummary } from '@winkey/api-client';
import { getBaseUrl } from '../../lib/api-client';
import { CinemaView } from '../../components/cinema/cinema-view';
import { buildWebSiteSchema, buildOrganizationSchema } from '../../lib/seo/website-schema';
import { jsonLd } from '../../lib/seo/json-ld';

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

  const title = 'Winkey – Xem phim, video, nhạc và game giải trí';
  const description =
    'Winkey – Nền tảng xem phim, phim bộ, video, nhạc và game giải trí trực tuyến tốc độ cao, hoàn toàn miễn phí với chất lượng hình ảnh sắc nét tại Việt Nam.';

  const ogImages = [
    { url: 'https://winkey.vn/opengraph-image.png', width: 1200, height: 630, alt: title },
    ...(firstVideo?.thumbnail_url
      ? [{ url: firstVideo.thumbnail_url, width: 1280, height: 720, alt: firstVideo.title }]
      : []),
  ];

  return {
    title: {
      absolute: title,
    },
    description,
    alternates: {
      canonical: '/',
    },
    openGraph: {
      title,
      description,
      images: ogImages,
      type: 'website',
      url: 'https://winkey.vn',
      siteName: 'Winkey',
      locale: 'vi_VN',
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
  const websiteSchema = buildWebSiteSchema();
  const organizationSchema = buildOrganizationSchema();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(websiteSchema),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(organizationSchema),
        }}
      />
      <CinemaView
        curatorHandle={curatorHandle}
        initialVideoId={initialVideoId}
        initialSeriesId={initialSeriesId}
        initialHeroVideos={videos}
        initialSortSource={sortSource}
      />
    </>
  );
}
