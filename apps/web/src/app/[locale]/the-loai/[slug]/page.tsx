import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { TagSummary, VideoPage, VideoSummary } from '@winkey/api-client';
import { Link } from '../../../../i18n/routing';
import { VideoCard } from '../../../../components/video/video-card';
import { getCategory } from '../../../../lib/seo/categories';
import {
  buildCategoryCollectionPageSchema,
  buildCategoryBreadcrumbSchema,
} from '../../../../lib/seo/category-schema';
import { jsonLd } from '../../../../lib/seo/json-ld';

interface CategoryPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

async function getTag(slug: string): Promise<TagSummary | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  const res = await fetch(`${baseUrl}/v1/tags/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch tag: HTTP ${res.status}`);
  }
  return await res.json();
}

async function getTagVideos(slug: string, limit = 12): Promise<VideoSummary[]> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  const res = await fetch(`${baseUrl}/v1/videos?tag=${encodeURIComponent(slug)}&limit=${limit}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch tag videos: HTTP ${res.status}`);
  }
  const data: VideoPage = await res.json();
  return data.items || [];
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = getCategory(slug);

  if (!category) {
    return {
      title: 'Thể loại không tồn tại',
      robots: { index: false, follow: false },
    };
  }

  // Fetch videos for all source tags in parallel
  const tagResults = await Promise.all(
    category.tags.map(async (t) => {
      return await getTagVideos(t, 12);
    }),
  );

  // De-duplicate unique videos by id
  const seenIds = new Set<string>();
  const uniqueVideos: VideoSummary[] = [];
  for (const videos of tagResults) {
    for (const v of videos) {
      if (!seenIds.has(v.id)) {
        seenIds.add(v.id);
        uniqueVideos.push(v);
      }
    }
  }

  const canonicalUrl = `https://winkey.vn/the-loai/${category.slug}`;
  const firstVideo = uniqueVideos[0];
  const thumbUrl = firstVideo?.thumbnail_url || 'https://winkey.vn/opengraph-image.png';

  const robots =
    uniqueVideos.length >= 2 ? { index: true, follow: true } : { index: false, follow: true };

  return {
    title: category.title,
    description: category.description,
    alternates: {
      canonical: canonicalUrl,
    },
    robots,
    openGraph: {
      title: `${category.title} | Winkey`,
      description: category.description,
      url: canonicalUrl,
      images: [
        {
          url: thumbUrl,
          width: 1280,
          height: 720,
          alt: category.name,
        },
      ],
      siteName: 'Winkey',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${category.title} | Winkey`,
      description: category.description,
      images: [thumbUrl],
    },
  };
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const category = getCategory(slug);
  if (!category) {
    notFound();
    return null;
  }

  // Fetch tag info and videos for all source tags in parallel
  const tagRowsData = await Promise.all(
    category.tags.map(async (tagSlug) => {
      const [tagInfo, videos] = await Promise.all([getTag(tagSlug), getTagVideos(tagSlug, 12)]);
      return {
        tagSlug,
        tagName: tagInfo?.name || tagSlug,
        videos,
      };
    }),
  );

  // Merge and de-duplicate by id across rows
  const seenIds = new Set<string>();
  const allUniqueVideos: VideoSummary[] = [];
  const rows: Array<{
    tagSlug: string;
    tagName: string;
    videos: VideoSummary[];
  }> = [];

  for (const row of tagRowsData) {
    const deduplicatedRowVideos: VideoSummary[] = [];
    for (const v of row.videos) {
      if (!seenIds.has(v.id)) {
        seenIds.add(v.id);
        deduplicatedRowVideos.push(v);
        allUniqueVideos.push(v);
      }
    }
    if (deduplicatedRowVideos.length > 0) {
      rows.push({
        tagSlug: row.tagSlug,
        tagName: row.tagName,
        videos: deduplicatedRowVideos,
      });
    }
  }

  const collectionSchema = buildCategoryCollectionPageSchema(
    category,
    allUniqueVideos,
    'https://winkey.vn',
  );
  const breadcrumbSchema = buildCategoryBreadcrumbSchema(category, 'https://winkey.vn');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(collectionSchema),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema),
        }}
      />

      <div className="w-full max-w-7xl mx-auto px-4 py-8 flex flex-col gap-8">
        {/* Breadcrumbs + Header */}
        <header className="flex flex-col gap-3 pb-6 border-b border-[#272727] dark:border-[#272727] border-gray-200">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"
          >
            <Link href="/" className="hover:underline">
              Trang chủ
            </Link>
            <span>/</span>
            <Link href="/kham-pha" className="hover:underline">
              Thể loại
            </Link>
            <span>/</span>
            <span className="text-gray-900 dark:text-gray-200 font-medium">{category.name}</span>
          </nav>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
            {category.name}
          </h1>
          <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400 max-w-3xl leading-relaxed">
            {category.intro}
          </p>
        </header>

        {/* Tag Rows */}
        {rows.length > 0 ? (
          <div className="flex flex-col gap-10">
            {rows.map((row) => (
              <section key={row.tagSlug} className="flex flex-col gap-4">
                <div className="flex items-center justify-between pb-2 border-b border-[#272727]/40 dark:border-[#272727]/60">
                  <h2 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-white">
                    <Link
                      href={`/tag/${row.tagSlug}`}
                      className="hover:text-red-600 dark:hover:text-red-500 transition hover:underline"
                    >
                      #{row.tagName}
                    </Link>
                  </h2>
                  <Link
                    href={`/tag/${row.tagSlug}`}
                    className="text-xs sm:text-sm font-medium text-red-600 dark:text-red-400 hover:underline"
                  >
                    Xem tất cả →
                  </Link>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-6">
                  {row.videos.map((video) => (
                    <VideoCard key={video.id} video={video} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="py-16 text-center text-gray-500 dark:text-gray-400">
            <p>Chưa có video nào trong thể loại này.</p>
          </div>
        )}
      </div>
    </>
  );
}
