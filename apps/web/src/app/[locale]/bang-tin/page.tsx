import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { FeedClient } from './feed-client';

interface FeedPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: FeedPageProps): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === 'vi' ? 'Bảng tin – Winkey' : 'Feed – Winkey',
    description:
      locale === 'vi'
        ? 'Theo dõi bài viết, chia sẻ trạng thái, hình ảnh và video từ cộng đồng sáng tạo Winkey.'
        : 'Explore posts, share updates, photos, and videos from the Winkey creator community.',
    openGraph: {
      title: locale === 'vi' ? 'Bảng tin – Winkey' : 'Feed – Winkey',
      type: 'website',
    },
  };
}

export default async function FeedPage({ params }: FeedPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <FeedClient />;
}
