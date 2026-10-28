import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import type { Post, VideoSummary } from '@winkey/api-client';
import { PostViewClient } from './post-view-client';

interface PostPageProps {
  params: Promise<{ locale: string; id: string }>;
}

async function getPost(id: string): Promise<Post | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/posts/${id}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getVideo(videoId: string): Promise<VideoSummary | null> {
  const baseUrl = process.env.API_INTERNAL_URL || 'http://localhost:8080';
  try {
    const res = await fetch(`${baseUrl}/v1/videos/${videoId}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PostPageProps): Promise<Metadata> {
  const { id } = await params;
  const post = await getPost(id);

  if (!post || post.status === 'DELETED') {
    return {
      title: 'Bài viết không tồn tại',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const isPublic = post.visibility === 'PUBLIC';
  const authorName = post.author?.display_name || post.author?.handle || 'Người dùng';

  // Title from the first 60 characters
  let title = post.body?.trim();
  if (title) {
    title = title.length > 60 ? `${title.slice(0, 57)}...` : title;
  } else {
    title = `Bài viết của ${authorName}`;
  }

  // Description from the first 160 characters
  let description = post.body?.trim() || `Bài viết được đăng bởi ${authorName} trên Winkey.`;
  if (description.length > 160) {
    description = `${description.slice(0, 157)}...`;
  }

  // Followers-only posts MUST have noindex (ADR-049 / SOC-2a)
  if (!isPublic) {
    return {
      title: `${title} – Winkey`,
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const firstImageUrl = post.images?.[0]?.url;
  const canonicalUrl = `https://winkey.vn/bai-viet/${post.id}`;

  return {
    title: `${title} – Winkey`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title,
      description,
      type: 'article',
      url: canonicalUrl,
      images: firstImageUrl ? [{ url: firstImageUrl, alt: title }] : undefined,
    },
    twitter: {
      card: firstImageUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      images: firstImageUrl ? [firstImageUrl] : undefined,
    },
  };
}

export default async function PostPage({ params }: PostPageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const post = await getPost(id);
  if (!post || post.status === 'DELETED') {
    notFound();
  }

  let hydratedVideo: VideoSummary | null = null;
  if (post.video_id) {
    hydratedVideo = await getVideo(post.video_id);
  }

  return <PostViewClient initialPost={post} hydratedVideo={hydratedVideo} />;
}
