'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Post, VideoSummary } from '@winkey/api-client';
import { api } from '../../../../lib/api-client';
import { PostCard } from '../../../../components/social/posts/post-card';
import { TrendingHashtagsWidget } from '../../../../components/social/posts/trending-hashtags-widget';
import { hydrateVideosForPosts } from '../../../../lib/video/hydrate-posts-videos';
import { Hash, Loader2, ArrowLeft, AlertCircle } from 'lucide-react';
import { Link } from '../../../../i18n/routing';
import { A11Y_COLORS } from '../../../../lib/a11y-tokens';

export interface HashtagClientProps {
  tag: string;
}

export function HashtagClient({ tag }: HashtagClientProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [videosMap, setVideosMap] = useState<Map<string, VideoSummary>>(new Map());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPosts = useCallback(
    async (cursor?: string | null, isInitial = false) => {
      if (isInitial) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const res = await api.social.GET('/v1/hashtags/{tag}/posts', {
          params: {
            path: { tag },
            query: { cursor: cursor || undefined, limit: 15 },
          },
        });

        if (res.response.ok && res.data) {
          const newPosts = res.data.items || [];
          setNextCursor(res.data.next_cursor ?? null);

          if (isInitial) {
            setPosts(newPosts);
          } else {
            setPosts((prev) => [...prev, ...newPosts]);
          }

          // Hydrate embedded videos
          const videoIds = newPosts.map((p) => p.video_id).filter(Boolean);
          if (videoIds.length > 0) {
            const newMap = await hydrateVideosForPosts(videoIds);
            setVideosMap((prev) => {
              const merged = new Map(prev);
              newMap.forEach((v, k) => merged.set(k, v));
              return merged;
            });
          }
        } else {
          setError('Không thể tải danh sách bài viết theo hashtag.');
        }
      } catch {
        setError('Lỗi kết nối khi tải bài viết.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [tag],
  );

  useEffect(() => {
    void loadPosts(undefined, true);
  }, [loadPosts]);

  // Infinite scroll
  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (!sentinelRef.current || loading || loadingMore || !nextCursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextCursor && !loadingMore && !loading) {
          void loadPosts(nextCursor, false);
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loading, loadingMore, loadPosts]);

  return (
    <div className="w-full max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Main Column */}
        <main className="flex-1 w-full max-w-2xl mx-auto space-y-4">
          <Link
            href="/bang-tin"
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition py-1"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Quay lại bảng tin</span>
          </Link>

          {/* Hashtag Header */}
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 shadow-sm flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
              <Hash className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-zinc-900 dark:text-white">
                #{tag}
              </h1>
              <p className={`text-xs ${A11Y_COLORS.textMuted}`}>
                Các bài viết mới nhất gắn thẻ #{tag}
              </p>
            </div>
          </div>

          {/* Posts list */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-400 space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-red-500" />
              <p className="text-xs sm:text-sm">Đang tải bài viết...</p>
            </div>
          ) : error ? (
            <div className="p-6 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 rounded-2xl text-center space-y-2">
              <AlertCircle className="w-7 h-7 text-red-500 mx-auto" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          ) : posts.length === 0 ? (
            <div className="p-10 text-center bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl space-y-2">
              <Hash className="w-10 h-10 text-zinc-400 mx-auto" />
              <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200">
                Chưa có bài viết nào
              </h3>
              <p className={`text-xs sm:text-sm ${A11Y_COLORS.textMuted}`}>
                Chưa có bài viết công khai nào gắn thẻ #{tag}.
              </p>
            </div>
          ) : (
            <div className="space-y-4" data-testid="hashtag-posts-list">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  hydratedVideo={post.video_id ? videosMap.get(post.video_id) || null : null}
                  onPostDeleted={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
                  onPostUpdated={(updated) =>
                    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
                  }
                />
              ))}

              {/* Sentinel */}
              <div ref={sentinelRef} className="py-4 text-center">
                {loadingMore && (
                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                    <span>Đang tải thêm...</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Right Sidebar */}
        <aside className="hidden lg:block w-80 shrink-0 sticky top-16 space-y-4">
          <TrendingHashtagsWidget limit={8} />
        </aside>
      </div>
    </div>
  );
}
