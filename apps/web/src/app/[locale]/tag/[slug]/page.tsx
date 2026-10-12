import React from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { TagSummary, VideoPage } from '@winkey/api-client';
import { TagVideosClient } from '../../../../components/tag/tag-videos-client';
import {
  buildTagCollectionPageSchema,
  buildTagBreadcrumbSchema,
} from '../../../../lib/seo/tag-schema';
import { jsonLd } from '../../../../lib/seo/json-ld';

interface TagPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function getTag(slug: string): Promise<TagSummary | null> {
  const decoded = safeDecodeURIComponent(slug);
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  const res = await fetch(`${baseUrl}/v1/tags/${encodeURIComponent(decoded)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch tag: HTTP ${res.status}`);
  }
  return await res.json();
}

async function getTagVideos(slug: string, limit = 24): Promise<VideoPage> {
  const decoded = safeDecodeURIComponent(slug);
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  const res = await fetch(
    `${baseUrl}/v1/videos?tag=${encodeURIComponent(decoded)}&limit=${limit}`,
    {
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch tag videos: HTTP ${res.status}`);
  }
  return await res.json();
}

function formatTagDescription(
  locale: string,
  tagName: string,
  videoCount: number,
  titles: string[],
): string {
  const isEn = locale === 'en';
  let desc = isEn
    ? `Watch ${videoCount} videos about ${tagName} on Winkey`
    : `Xem ${videoCount} video về ${tagName} trên Winkey`;

  if (titles.length > 0) {
    desc += `: ${titles.join(', ')}`;
  }

  if (desc.length <= 155) return desc;
  return desc.slice(0, 152) + '...';
}

export async function generateMetadata({ params }: TagPageProps): Promise<Metadata> {
  const { locale, slug: rawSlug } = await params;
  const slug = safeDecodeURIComponent(rawSlug);
  const tag = await getTag(slug);

  if (!tag) {
    return {
      title: 'Thẻ không tồn tại',
      robots: { index: false, follow: false },
    };
  }

  const videosPage = await getTagVideos(tag.slug, 24);
  const videoItems = videosPage.items || [];
  const firstVideo = videoItems[0];
  const thumbUrl = firstVideo?.thumbnail_url || 'https://winkey.vn/og-default.jpg';

  const isEn = locale === 'en';
  const title = isEn
    ? `${tag.name} – Videos about ${tag.name}`
    : `${tag.name} – Video về ${tag.name}`;

  const titles = videoItems
    .slice(0, 5)
    .map((v) => v.title)
    .filter(Boolean);
  const description = formatTagDescription(locale, tag.name, tag.video_count, titles);
  const canonicalUrl = `https://winkey.vn/tag/${tag.slug}`;

  const robots =
    tag.video_count >= 2 ? { index: true, follow: true } : { index: false, follow: true };

  return {
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    robots,
    openGraph: {
      title,
      description,
      url: canonicalUrl,
      images: [
        {
          url: thumbUrl,
          width: 1280,
          height: 720,
          alt: tag.name,
        },
      ],
      siteName: 'Winkey',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [thumbUrl],
    },
  };
}

export default async function TagPage({ params }: TagPageProps) {
  const { locale, slug: rawSlug } = await params;
  setRequestLocale(locale);

  const slug = safeDecodeURIComponent(rawSlug);
  const tag = await getTag(slug);

  if (!tag) {
    notFound();
  }

  // If path parameter is not the canonical slug, permanent redirect 308
  if (tag.slug !== slug) {
    permanentRedirect(locale === 'en' ? `/en/tag/${tag.slug}` : `/tag/${tag.slug}`);
  }

  const videosPage = await getTagVideos(tag.slug, 24);
  const initialVideos = videosPage.items || [];

  const t = await getTranslations('tag');
  const titles = initialVideos
    .slice(0, 5)
    .map((v) => v.title)
    .filter(Boolean);
  const metaDescription = formatTagDescription(locale, tag.name, tag.video_count, titles);

  const collectionSchema = buildTagCollectionPageSchema(
    tag,
    initialVideos,
    metaDescription,
    'https://winkey.vn',
  );
  const breadcrumbSchema = buildTagBreadcrumbSchema(tag, 'https://winkey.vn');

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

      <div className="w-full max-w-7xl mx-auto px-4 py-8 flex flex-col gap-6">
        {/* Header with Google-crawled h1 and intro line */}
        <header className="flex flex-col gap-2 pb-4 border-b border-[#272727] dark:border-[#272727] border-gray-200">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            #{tag.name}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('intro', { count: tag.video_count, name: tag.name })}
          </p>
        </header>

        {/* Video Card Grid & Client Pagination */}
        <TagVideosClient
          initialVideos={initialVideos}
          initialCursor={videosPage?.next_cursor ?? null}
          tagSlug={tag.slug}
        />
      </div>
    </>
  );
}
