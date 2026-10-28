'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Post, VideoSummary } from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../lib/auth/auth-context';
import { PostComposer } from '../../../components/social/posts/post-composer';
import { PostCard } from '../../../components/social/posts/post-card';
import { TrendingHashtagsWidget } from '../../../components/social/posts/trending-hashtags-widget';
import { hydrateVideosForPosts } from '../../../lib/video/hydrate-posts-videos';
import { Loader2, Users, Compass, RefreshCw, AlertCircle } from 'lucide-react';
import { Link } from '../../../i18n/routing';
import { A11Y_COLORS } from '../../../lib/a11y-tokens';

type FeedTab = 'following' | 'explore';

export function FeedClient() {
  const { isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState<FeedTab>(isAuthenticated ? 'following' : 'explore');
  const [posts, setPosts] = useState<Post[]>([]);
  const [videosMap, setVideosMap] = useState<Map<string, VideoSummary>>(new Map());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotedPost, setQuotedPost] = useState<Post | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // Sync tab if user logs in or out
  useEffect(() => {
    if (!isAuthenticated && activeTab === 'following') {
      setActiveTab('explore');
    }
  }, [isAuthenticated, activeTab]);

  const loadFeed = useCallback(
    async (tab: FeedTab, cursor?: string | null, isInitial = false) => {
      if (isInitial) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        let resData: { items: Post[]; next_cursor?: string | null } | undefined;
        let responseStatus = 200;
        let errorCode: string | undefined;

        if (tab === 'following') {
          if (!isAuthenticated) {
            setPosts([]);
            setLoading(false);
            setLoadingMore(false);
            return;
          }
          const res = await api.social.GET('/v1/feed/following', {
            params: { query: { cursor: cursor || undefined, limit: 15 } },
          });
          responseStatus = res.response.status;
          errorCode = (res.error as any)?.code;
          if (res.response.ok && res.data) {
            resData = res.data;
          }
        } else {
          const res = await api.social.GET('/v1/feed/explore', {
            params: { query: { cursor: cursor || undefined, limit: 15 } },
          });
          responseStatus = res.response.status;
          errorCode = (res.error as any)?.code;
          if (res.response.ok && res.data) {
            resData = res.data;
          }
        }

        // Handle CURSOR_EXPIRED: reload from start
        if (errorCode === 'CURSOR_EXPIRED' || responseStatus === 410) {
          console.warn('Feed cursor expired, reloading from top...');
          void loadFeed(tab, undefined, true);
          return;
        }

        if (resData?.items) {
          const newPosts = resData.items;
          const next = resData.next_cursor ?? null;
          setNextCursor(next);

          if (isInitial) {
            setPosts(newPosts);
          } else {
            setPosts((prev) => [...prev, ...newPosts]);
          }

          // Hydrate embedded videos for new posts
          const videoIds = newPosts.map((p) => p.video_id).filter(Boolean);
          if (videoIds.length > 0) {
            const newMap = await hydrateVideosForPosts(videoIds);
            setVideosMap((prev) => {
              const merged = new Map(prev);
              newMap.forEach((v, k) => merged.set(k, v));
              return merged;
            });
          }
        } else if (!resData) {
          setError('Không thể tải bảng tin. Vui lòng thử lại sau.');
        }
      } catch (err: any) {
        if (err?.code === 'CURSOR_EXPIRED') {
          void loadFeed(tab, undefined, true);
          return;
        }
        setError('Lỗi kết nối khi tải bảng tin.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [isAuthenticated],
  );

  // Reload on tab change
  useEffect(() => {
    setNextCursor(null);
    void loadFeed(activeTab, undefined, true);
  }, [activeTab, loadFeed]);

  // Infinite scroll observer
  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (!sentinelRef.current || loading || loadingMore || !nextCursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextCursor && !loadingMore && !loading) {
          void loadFeed(activeTab, nextCursor, false);
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loading, loadingMore, activeTab, loadFeed]);

  const handlePostCreated = (newPost: Post) => {
    setPosts((prev) => [newPost, ...prev]);
    setQuotedPost(null);
  };

  const handlePostUpdated = (updatedPost: Post) => {
    setPosts((prev) => prev.map((p) => (p.id === updatedPost.id ? updatedPost : p)));
  };

  const handlePostDeleted = (deletedPostId: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== deletedPostId));
  };

  const handleQuoteReshare = (post: Post) => {
    setQuotedPost(post);
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Main Feed Column */}
        <main className="flex-1 w-full max-w-2xl mx-auto space-y-4">
          {/* Feed Tabs Header */}
          <div className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md sticky top-14 z-20 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1 w-full">
              <button
                type="button"
                onClick={() => setActiveTab('following')}
                data-testid="feed-tab-following"
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition ${
                  activeTab === 'following'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Đang theo dõi</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('explore')}
                data-testid="feed-tab-explore"
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition ${
                  activeTab === 'explore'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                }`}
              >
                <Compass className="w-4 h-4" />
                <span>Khám phá</span>
              </button>
            </div>
          </div>

          {/* Composer (for signed-in users) */}
          {isAuthenticated && (
            <div ref={composerRef} className="pt-1">
              <PostComposer
                onPostCreated={handlePostCreated}
                reshareOf={quotedPost}
                onCancelReshare={() => setQuotedPost(null)}
                placeholder="Bạn đang nghĩ gì hôm nay?"
              />
            </div>
          )}

          {/* Feed Content */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-400 space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-red-500" />
              <p className="text-xs sm:text-sm">Đang tải bảng tin...</p>
            </div>
          ) : error ? (
            <div className="p-6 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 rounded-2xl text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <button
                type="button"
                onClick={() => void loadFeed(activeTab, undefined, true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-xl text-xs font-semibold hover:bg-red-700 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Thử lại</span>
              </button>
            </div>
          ) : activeTab === 'following' && !isAuthenticated ? (
            <div className="p-8 text-center bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl space-y-3">
              <Users className="w-10 h-10 text-zinc-400 mx-auto" />
              <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200">
                Đăng nhập để xem bảng tin người theo dõi
              </h3>
              <p className={`text-xs sm:text-sm ${A11Y_COLORS.textMuted} max-w-sm mx-auto`}>
                Theo dõi các nhà sáng tạo yêu thích để cập nhật những bài viết mới nhất của họ.
              </p>
              <div className="pt-2">
                <Link
                  href="/login"
                  className="inline-block px-5 py-2.5 bg-red-600 text-white rounded-xl text-xs sm:text-sm font-semibold hover:bg-red-700 transition"
                >
                  Đăng nhập ngay
                </Link>
              </div>
            </div>
          ) : posts.length === 0 ? (
            <div className="p-10 text-center bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl space-y-3">
              {activeTab === 'following' ? (
                <>
                  <Users className="w-10 h-10 text-zinc-400 mx-auto" />
                  <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200">
                    Chưa có bài viết nào
                  </h3>
                  <p className={`text-xs sm:text-sm ${A11Y_COLORS.textMuted} max-w-sm mx-auto`}>
                    Bạn chưa theo dõi ai hoặc những người bạn theo dõi chưa đăng bài viết nào. Hãy
                    khám phá và theo dõi thêm các nhà sáng tạo!
                  </p>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab('explore')}
                      className="px-4 py-2 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-xl text-xs sm:text-sm font-semibold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                    >
                      Khám phá bài viết
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Compass className="w-10 h-10 text-zinc-400 mx-auto" />
                  <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-200">
                    Chưa có bài viết nổi bật
                  </h3>
                  <p className={`text-xs sm:text-sm ${A11Y_COLORS.textMuted} max-w-sm mx-auto`}>
                    Các bài viết thịnh hành trong tuần sẽ xuất hiện tại đây.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4" data-testid="feed-posts-list">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  hydratedVideo={post.video_id ? videosMap.get(post.video_id) || null : null}
                  onPostUpdated={handlePostUpdated}
                  onPostDeleted={handlePostDeleted}
                  onQuoteReshare={handleQuoteReshare}
                />
              ))}

              {/* Infinite scroll sentinel / loading indicator */}
              <div ref={sentinelRef} className="py-4 text-center">
                {loadingMore ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                    <span>Đang tải thêm bài viết...</span>
                  </div>
                ) : nextCursor ? (
                  <button
                    type="button"
                    onClick={() => void loadFeed(activeTab, nextCursor, false)}
                    className="px-4 py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition"
                  >
                    Tải thêm
                  </button>
                ) : (
                  <p className="text-xs text-zinc-400">Bạn đã xem hết bảng tin.</p>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Right Sidebar: Trending & Recommendations */}
        <aside className="hidden lg:block w-80 shrink-0 sticky top-16 space-y-4">
          <TrendingHashtagsWidget limit={8} />

          <div className="p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 text-xs text-zinc-500 dark:text-zinc-400 space-y-2">
            <h4 className="font-semibold text-zinc-700 dark:text-zinc-300">Về Bảng tin Winkey</h4>
            <p>
              Chia sẻ suy nghĩ, hình ảnh và video với bạn bè và người theo dõi. Nội dung của bạn
              tuân thủ Tiêu chuẩn cộng đồng Winkey.
            </p>
            <div className="pt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400">
              <Link href="/dieu-khoan" className="hover:underline">
                Điều khoản
              </Link>
              <Link href="/quyen-rieng-tu" className="hover:underline">
                Quyền riêng tư
              </Link>
              <Link href="/quy-tac-cong-dong" className="hover:underline">
                Quy tắc
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
