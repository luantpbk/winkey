'use client';

import React, { useState } from 'react';
import type { Post, VideoSummary } from '@winkey/api-client';
import { useRouter, Link } from '../../../../i18n/routing';
import { PostCard } from '../../../../components/social/posts/post-card';
import { PostComments } from '../../../../components/social/posts/post-comments';
import { TrendingHashtagsWidget } from '../../../../components/social/posts/trending-hashtags-widget';
import { ArrowLeft } from 'lucide-react';

export interface PostViewClientProps {
  initialPost: Post;
  hydratedVideo?: VideoSummary | null;
}

export function PostViewClient({ initialPost, hydratedVideo }: PostViewClientProps) {
  const router = useRouter();
  const [post, setPost] = useState<Post>(initialPost);

  const handlePostDeleted = () => {
    router.push('/bang-tin');
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Main Column */}
        <main className="flex-1 w-full max-w-2xl mx-auto space-y-4">
          {/* Back to feed button */}
          <Link
            href="/bang-tin"
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition py-1"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Quay lại bảng tin</span>
          </Link>

          {/* Post Card */}
          <PostCard
            post={post}
            hydratedVideo={hydratedVideo}
            onPostUpdated={setPost}
            onPostDeleted={handlePostDeleted}
          />

          {/* Post Comments Section */}
          <PostComments postId={post.id} />
        </main>

        {/* Right Sidebar */}
        <aside className="hidden lg:block w-72 shrink-0 sticky top-16 space-y-4">
          <TrendingHashtagsWidget limit={6} />
        </aside>
      </div>
    </div>
  );
}
