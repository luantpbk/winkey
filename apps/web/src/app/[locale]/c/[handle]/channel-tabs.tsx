'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { PublicProfile, VideoSummary, Playlist, Post } from '@winkey/api-client';
import { api } from '../../../../lib/api-client';
import { VideoCard } from '../../../../components/video/video-card';
import { PostCard } from '../../../../components/social/posts/post-card';
import { PostComposer } from '../../../../components/social/posts/post-composer';
import { hydrateVideosForPosts } from '../../../../lib/video/hydrate-posts-videos';
import { Link } from '../../../../i18n/routing';
import { formatRelativeTime } from '../../../../lib/format';
import { ListVideo, Lock, EyeOff, Globe, Loader2, Plus } from 'lucide-react';
import { useAuth } from '../../../../lib/auth/auth-context';
import { CreatePlaylistDialog } from '../../../../components/playlist/create-playlist-dialog';
import { A11Y_COLORS } from '../../../../lib/a11y-tokens';

export interface ChannelTabsProps {
  profile: PublicProfile;
  initialVideos: VideoSummary[];
}

export function ChannelTabs({ profile, initialVideos }: ChannelTabsProps) {
  const [activeTab, setActiveTab] = useState<'videos' | 'posts' | 'playlists' | 'about'>('videos');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);

  // Posts state
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [postsLoaded, setPostsLoaded] = useState(false);
  const [postsCursor, setPostsCursor] = useState<string | null>(null);
  const [isPrivateRestricted, setIsPrivateRestricted] = useState(false);
  const [postsVideosMap, setPostsVideosMap] = useState<Map<string, VideoSummary>>(new Map());

  const { user } = useAuth();
  const isOwner = user?.id === profile.id;
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const postsSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTab === 'posts' && !postsLoaded) {
      setLoadingPosts(true);
      setIsPrivateRestricted(false);
      api.social
        .GET('/v1/channels/{channel_id}/posts', {
          params: { path: { channel_id: profile.id }, query: { limit: 15 } },
        })
        .then(async (res) => {
          if (res.response.status === 403) {
            setIsPrivateRestricted(true);
          } else if (res.data?.items) {
            const items = res.data.items;
            setPosts(items);
            setPostsCursor(res.data.next_cursor ?? null);

            // Hydrate videos
            const videoIds = items.map((p) => p.video_id).filter(Boolean);
            if (videoIds.length > 0) {
              const vMap = await hydrateVideosForPosts(videoIds);
              setPostsVideosMap(vMap);
            }
          }
          setPostsLoaded(true);
        })
        .catch((err) => {
          console.error('Failed to load channel posts:', err);
        })
        .finally(() => {
          setLoadingPosts(false);
        });
    }
  }, [activeTab, postsLoaded, profile.id]);

  const loadMorePosts = async () => {
    if (!postsCursor || loadingMorePosts) return;
    setLoadingMorePosts(true);
    try {
      const res = await api.social.GET('/v1/channels/{channel_id}/posts', {
        params: {
          path: { channel_id: profile.id },
          query: { cursor: postsCursor, limit: 15 },
        },
      });
      if (res.data?.items) {
        const newItems = res.data.items;
        setPosts((prev) => [...prev, ...newItems]);
        setPostsCursor(res.data.next_cursor ?? null);

        const videoIds = newItems.map((p) => p.video_id).filter(Boolean);
        if (videoIds.length > 0) {
          const vMap = await hydrateVideosForPosts(videoIds);
          setPostsVideosMap((prev) => {
            const merged = new Map(prev);
            vMap.forEach((v, k) => merged.set(k, v));
            return merged;
          });
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingMorePosts(false);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (!postsSentinelRef.current || loadingPosts || loadingMorePosts || !postsCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && postsCursor && !loadingMorePosts && !loadingPosts) {
          void loadMorePosts();
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );
    observer.observe(postsSentinelRef.current);
    return () => observer.disconnect();
  }, [postsCursor, loadingPosts, loadingMorePosts]);

  useEffect(() => {
    if (activeTab === 'playlists' && !playlistsLoaded) {
      setLoadingPlaylists(true);
      api.social
        .GET('/v1/channels/{channel_id}/playlists', {
          params: { path: { channel_id: profile.id } },
        })
        .then((res) => {
          if (res.data?.items) {
            setPlaylists(res.data.items);
          }
          setPlaylistsLoaded(true);
        })
        .catch((err) => {
          console.error('Failed to load channel playlists:', err);
        })
        .finally(() => {
          setLoadingPlaylists(false);
        });
    }
  }, [activeTab, playlistsLoaded, profile.id]);

  return (
    <div className="flex flex-col gap-6">
      {/* Navigation Tabs */}
      <div className="flex border-b border-[#272727] dark:border-[#272727] border-gray-200 text-sm font-semibold">
        <button
          type="button"
          onClick={() => setActiveTab('videos')}
          data-testid="tab-channel-videos"
          className={`px-4 py-3 transition ${
            activeTab === 'videos'
              ? `border-b-2 ${A11Y_COLORS.activeTabBorder} ${A11Y_COLORS.brandText} font-bold`
              : `${A11Y_COLORS.textSecondary} hover:text-gray-900 dark:hover:text-white`
          }`}
        >
          Video
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('posts')}
          data-testid="tab-channel-posts"
          className={`px-4 py-3 transition ${
            activeTab === 'posts'
              ? `border-b-2 ${A11Y_COLORS.activeTabBorder} ${A11Y_COLORS.brandText} font-bold`
              : `${A11Y_COLORS.textSecondary} hover:text-gray-900 dark:hover:text-white`
          }`}
        >
          Bài viết
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('playlists')}
          data-testid="tab-channel-playlists"
          className={`px-4 py-3 transition ${
            activeTab === 'playlists'
              ? `border-b-2 ${A11Y_COLORS.activeTabBorder} ${A11Y_COLORS.brandText} font-bold`
              : `${A11Y_COLORS.textSecondary} hover:text-gray-900 dark:hover:text-white`
          }`}
        >
          Danh sách phát
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('about')}
          data-testid="tab-channel-about"
          className={`px-4 py-3 transition ${
            activeTab === 'about'
              ? `border-b-2 ${A11Y_COLORS.activeTabBorder} ${A11Y_COLORS.brandText} font-bold`
              : `${A11Y_COLORS.textSecondary} hover:text-gray-900 dark:hover:text-white`
          }`}
        >
          Giới thiệu
        </button>
      </div>

      {/* Tab: Videos */}
      {activeTab === 'videos' && (
        <>
          {initialVideos.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-8">
              {initialVideos.map((video) => (
                <VideoCard key={video.id} video={video} surface="channel" />
              ))}
            </div>
          ) : (
            <div
              className={`flex flex-col items-center justify-center py-20 text-center ${A11Y_COLORS.textMuted}`}
            >
              <p className="text-base">Kênh này chưa có video nào.</p>
            </div>
          )}
        </>
      )}

      {/* Tab: Posts */}
      {activeTab === 'posts' && (
        <div
          data-testid="channel-posts-section"
          className="flex flex-col gap-4 max-w-2xl mx-auto w-full"
        >
          {/* Owner Composer */}
          {isOwner && (
            <PostComposer
              onPostCreated={(newPost) => setPosts((prev) => [newPost, ...prev])}
              placeholder="Chia sẻ bài viết trên kênh của bạn..."
            />
          )}

          {isPrivateRestricted ? (
            <div className="flex flex-col items-center justify-center text-center p-8 space-y-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl w-full">
              <div className="p-3 bg-zinc-100 dark:bg-zinc-800 rounded-full text-zinc-500">
                <Lock className="w-8 h-8" />
              </div>
              <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                Tài khoản này là riêng tư
              </p>
              <p className="text-xs text-zinc-500 max-w-xs">
                Chỉ những người được phê duyệt theo dõi mới có thể xem các bài viết của tài khoản
                này.
              </p>
            </div>
          ) : loadingPosts ? (
            <div className="flex items-center justify-center py-20 text-zinc-400">
              <Loader2 className="h-8 w-8 animate-spin text-red-500" />
            </div>
          ) : posts.length > 0 ? (
            <div className="space-y-4">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  hydratedVideo={post.video_id ? postsVideosMap.get(post.video_id) || null : null}
                  onPostUpdated={(updated) =>
                    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
                  }
                  onPostDeleted={(deletedId) =>
                    setPosts((prev) => prev.filter((p) => p.id !== deletedId))
                  }
                />
              ))}

              <div ref={postsSentinelRef} className="py-2 text-center">
                {loadingMorePosts && (
                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                    <span>Đang tải thêm...</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              className={`flex flex-col items-center justify-center py-20 text-center ${A11Y_COLORS.textMuted}`}
            >
              <p className="text-base">Kênh này chưa có bài viết nào.</p>
            </div>
          )}
        </div>
      )}

      {/* Tab: Playlists */}
      {activeTab === 'playlists' && (
        <div data-testid="channel-playlists-section" className="flex flex-col gap-4">
          {/* Owner only "Tạo danh sách" button */}
          {isOwner && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowCreateDialog(true)}
                data-testid="channel-create-playlist-btn"
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full ${A11Y_COLORS.brandSolidBg} text-xs font-semibold shadow-md transition`}
              >
                <Plus className="h-4 w-4" />
                <span>Tạo danh sách</span>
              </button>
            </div>
          )}

          {loadingPlaylists ? (
            <div className="flex items-center justify-center py-20 text-zinc-400">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : playlists.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {playlists.map((pl) => (
                <Link
                  key={pl.id}
                  href={`/playlist/${pl.id}`}
                  data-testid={`channel-playlist-card-${pl.id}`}
                  className="group flex flex-col gap-3 rounded-2xl p-2.5 bg-zinc-900/40 hover:bg-zinc-800/80 border border-zinc-800/60 hover:border-zinc-700 transition"
                >
                  <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-zinc-800 shadow-md">
                    <div className="h-full w-full bg-gradient-to-br from-zinc-800 via-zinc-900 to-black flex items-center justify-center">
                      <ListVideo className="h-10 w-10 text-zinc-600 group-hover:text-red-500 transition" />
                    </div>
                    {/* Badge right overlay */}
                    <div className="absolute inset-y-0 right-0 w-2/5 bg-black/70 backdrop-blur-xs flex flex-col items-center justify-center text-white text-xs font-semibold gap-1 p-2">
                      <ListVideo className="h-5 w-5" />
                      <span>{pl.item_count} video</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 px-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-white line-clamp-1 group-hover:text-red-500 transition">
                        {pl.kind === 'WATCH_LATER' ? 'Xem sau' : pl.title}
                      </h3>
                      {isOwner && (
                        <span className="text-zinc-500 shrink-0">
                          {pl.visibility === 'PRIVATE' || pl.kind === 'WATCH_LATER' ? (
                            <Lock className="h-3.5 w-3.5 text-red-400" />
                          ) : pl.visibility === 'UNLISTED' ? (
                            <EyeOff className="h-3.5 w-3.5 text-amber-400" />
                          ) : (
                            <Globe className="h-3.5 w-3.5 text-emerald-400" />
                          )}
                        </span>
                      )}
                    </div>
                    <span className={`text-xs ${A11Y_COLORS.textMuted}`}>
                      Cập nhật {formatRelativeTime(pl.updated_at)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div
              className={`flex flex-col items-center justify-center py-20 text-center ${A11Y_COLORS.textMuted}`}
            >
              <p className="text-base">Kênh này chưa có danh sách phát nào.</p>
            </div>
          )}
        </div>
      )}

      {/* Tab: About */}
      {activeTab === 'about' && (
        <div className="flex flex-col gap-4 max-w-2xl py-4 text-sm text-gray-300">
          <h3 className="text-base font-bold text-white">Mô tả</h3>
          <p className="whitespace-pre-line leading-relaxed text-zinc-400">
            Kênh chính thức của {profile.display_name} (@{profile.handle}) trên Winkey VN.
          </p>
          <div className={`pt-4 border-t border-zinc-800 text-xs ${A11Y_COLORS.textMuted}`}>
            <span>Kênh chính thức trên Winkey VN</span>
          </div>
        </div>
      )}

      {/* Create Playlist Dialog */}
      <CreatePlaylistDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={(newPl) => {
          setPlaylists((prev) => [newPl, ...prev]);
        }}
        navigateOnSuccess={true}
      />
    </div>
  );
}
