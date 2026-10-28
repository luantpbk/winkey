import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { HashtagClient } from './hashtag-client';

interface HashtagPageProps {
  params: Promise<{ locale: string; tag: string }>;
}

export async function generateMetadata({ params }: HashtagPageProps): Promise<Metadata> {
  const { tag } = await params;
  const decodedTag = decodeURIComponent(tag);
  return {
    title: `#${decodedTag} – Winkey`,
    description: `Khám phá các bài viết và cuộc trò chuyện về #${decodedTag} trên Winkey.`,
    openGraph: {
      title: `#${decodedTag} – Winkey`,
      description: `Khám phá các bài viết và cuộc trò chuyện về #${decodedTag} trên Winkey.`,
    },
  };
}

export default async function HashtagPage({ params }: HashtagPageProps) {
  const { locale, tag } = await params;
  setRequestLocale(locale);
  const decodedTag = decodeURIComponent(tag);

  return <HashtagClient tag={decodedTag} />;
}
