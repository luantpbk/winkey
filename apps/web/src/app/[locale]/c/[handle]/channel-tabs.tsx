'use client';

import React, { useState, useEffect } from 'react';
import type { PublicProfile, VideoSummary, Playlist } from '@winkey/api-client';
import { api } from '../../../../lib/api-client';
import { VideoCard } from '../../../../components/video/video-card';
import { Link } from '../../../../i18n/routing';
import { formatRelativeTime } from '../../../../lib/format';
import { ListVideo, Lock, EyeOff, Globe, Loader2 } from 'lucide-react';
import { useAuth } from '../../../../lib/auth/auth-context';

export interface ChannelTabsProps {
  profile: PublicProfile;
  initialVideos: VideoSummary[];
}

export function ChannelTabs({ profile, initialVideos }: ChannelTabsProps) {
  const [activeTab, setActiveTab] = useState<'videos' | 'playlists' | 'about'>('videos');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const { user } = useAuth();
  const isOwner = user?.id === profile.id;

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
              ? 'border-b-2 border-red-600 text-red-600 font-bold'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          Video
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('playlists')}
          data-testid="tab-channel-playlists"
          className={`px-4 py-3 transition ${
            activeTab === 'playlists'
              ? 'border-b-2 border-red-600 text-red-600 font-bold'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
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
              ? 'border-b-2 border-red-600 text-red-600 font-bold'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
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
            <div className="flex flex-col items-center justify-center py-20 text-center text-gray-500 dark:text-gray-400">
              <p className="text-base">Kênh này chưa có video nào.</p>
            </div>
          )}
        </>
      )}

      {/* Tab: Playlists */}
      {activeTab === 'playlists' && (
        <div data-testid="channel-playlists-section">
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
                    <span className="text-xs text-zinc-500">
                      Cập nhật {formatRelativeTime(pl.updated_at)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center text-gray-500 dark:text-gray-400">
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
          <div className="pt-4 border-t border-zinc-800 text-xs text-zinc-500">
            <span>Kênh chính thức trên Winkey VN</span>
          </div>
        </div>
      )}
    </div>
  );
}
