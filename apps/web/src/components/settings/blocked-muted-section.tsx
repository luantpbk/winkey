'use client';

import React, { useState, useEffect } from 'react';
import { UserX, VolumeX } from 'lucide-react';
import { Link } from '../../i18n/routing';
import { api } from '../../lib/api-client';
import type { PublicProfile } from '@winkey/api-client';

interface RelationUserItem {
  user: PublicProfile;
  since: string;
}

export function BlockedMutedSection() {
  const [activeTab, setActiveTab] = useState<'blocked' | 'muted'>('blocked');
  const [blockedUsers, setBlockedUsers] = useState<RelationUserItem[]>([]);
  const [mutedUsers, setMutedUsers] = useState<RelationUserItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadData() {
      setIsLoading(true);
      try {
        const [blocksRes, mutesRes] = await Promise.all([
          api.social.GET('/v1/me/blocks', {}),
          api.social.GET('/v1/me/mutes', {}),
        ]);
        if (!isMounted) return;
        if (blocksRes.response.ok && blocksRes.data) {
          setBlockedUsers((blocksRes.data.items as RelationUserItem[]) || []);
        }
        if (mutesRes.response.ok && mutesRes.data) {
          setMutedUsers((mutesRes.data.items as RelationUserItem[]) || []);
        }
      } catch {
        // Ignored
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    void loadData();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleUnblock = async (userId: string) => {
    setActionInProgress(userId);
    try {
      const res = await api.social.DELETE('/v1/me/blocks/{user_id}', {
        params: { path: { user_id: userId } },
      });
      if (res.response.ok) {
        setBlockedUsers((prev) => prev.filter((item) => item.user.id !== userId));
      }
    } catch {
      // Ignored
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUnmute = async (userId: string) => {
    setActionInProgress(userId);
    try {
      const res = await api.social.DELETE('/v1/me/mutes/{user_id}', {
        params: { path: { user_id: userId } },
      });
      if (res.response.ok) {
        setMutedUsers((prev) => prev.filter((item) => item.user.id !== userId));
      }
    } catch {
      // Ignored
    } finally {
      setActionInProgress(null);
    }
  };

  const currentList = activeTab === 'blocked' ? blockedUsers : mutedUsers;

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#18181b] p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
            {activeTab === 'blocked' ? (
              <UserX className="h-5 w-5" />
            ) : (
              <VolumeX className="h-5 w-5" />
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
              Chặn và tắt tiếng
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Quản lý danh sách các tài khoản bạn đã chặn hoặc tắt thông báo.
            </p>
          </div>
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('blocked')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'blocked'
                ? 'bg-white dark:bg-[#18181b] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
            }`}
          >
            Đã chặn ({blockedUsers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('muted')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'muted'
                ? 'bg-white dark:bg-[#18181b] text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
            }`}
          >
            Đã tắt tiếng ({mutedUsers.length})
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <div className="h-6 w-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : currentList.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
          {activeTab === 'blocked'
            ? 'Bạn chưa chặn người dùng nào.'
            : 'Bạn chưa tắt tiếng người dùng nào.'}
        </div>
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {currentList.map(({ user }) => (
            <div
              key={user.handle}
              className="flex items-center justify-between py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 px-2 rounded-xl transition"
            >
              <Link href={`/c/${user.handle}`} className="flex items-center gap-3 min-w-0">
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.display_name}
                    className="w-10 h-10 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-red-600 font-bold text-white flex items-center justify-center text-sm shrink-0">
                    {user.display_name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-white truncate hover:underline">
                    {user.display_name}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    @{user.handle}
                  </p>
                </div>
              </Link>

              <div>
                {activeTab === 'blocked' ? (
                  <button
                    type="button"
                    onClick={() => handleUnblock(user.id)}
                    disabled={actionInProgress === user.id}
                    className="px-3 py-1.5 text-xs font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-lg transition disabled:opacity-50"
                  >
                    Bỏ chặn
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUnmute(user.id)}
                    disabled={actionInProgress === user.id}
                    className="px-3 py-1.5 text-xs font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-lg transition disabled:opacity-50"
                  >
                    Bỏ tắt tiếng
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
