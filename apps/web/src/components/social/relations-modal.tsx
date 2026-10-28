'use client';

import React, { useState, useEffect } from 'react';
import { X, Lock, Users, UserPlus } from 'lucide-react';
import { Link } from '../../i18n/routing';
import { api } from '../../lib/api-client';
import type { PublicProfile } from '@winkey/api-client';

export interface RelationsModalProps {
  isOpen: boolean;
  channelId: string;
  channelHandle?: string;
  type: 'followers' | 'following';
  onClose: () => void;
}

interface RelationItemData {
  user: PublicProfile;
  followed_at?: string;
  since?: string;
}

export function RelationsModal({
  isOpen,
  channelId,
  channelHandle: _channelHandle,
  type,
  onClose,
}: RelationsModalProps) {
  const [items, setItems] = useState<RelationItemData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isPrivate, setIsPrivate] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !channelId) return;

    let isMounted = true;
    setIsLoading(true);
    setIsPrivate(false);
    setErrorMessage(null);
    setItems([]);

    async function loadInitial() {
      try {
        if (type === 'followers') {
          const res = await api.social.GET('/v1/channels/{channel_id}/followers', {
            params: { path: { channel_id: channelId } },
          });
          if (!isMounted) return;
          if (res.response.status === 403) {
            setIsPrivate(true);
          } else if (res.response.ok && res.data) {
            setItems(res.data.items || []);
            setNextCursor(res.data.next_cursor ?? null);
          } else {
            setErrorMessage('Không thể tải danh sách.');
          }
        } else {
          const res = await api.social.GET('/v1/channels/{channel_id}/following', {
            params: { path: { channel_id: channelId } },
          });
          if (!isMounted) return;
          if (res.response.status === 403) {
            setIsPrivate(true);
          } else if (res.response.ok && res.data) {
            setItems(res.data.items || []);
            setNextCursor(res.data.next_cursor ?? null);
          } else {
            setErrorMessage('Không thể tải danh sách.');
          }
        }
      } catch {
        if (isMounted) {
          setErrorMessage('Lỗi kết nối máy chủ.');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitial();

    return () => {
      isMounted = false;
    };
  }, [isOpen, channelId, type]);

  const handleLoadMore = async () => {
    if (!nextCursor || isLoading) return;

    try {
      if (type === 'followers') {
        const res = await api.social.GET('/v1/channels/{channel_id}/followers', {
          params: {
            path: { channel_id: channelId },
            query: { cursor: nextCursor },
          },
        });
        if (res.response.ok && res.data) {
          setItems((prev) => [...prev, ...(res.data?.items || [])]);
          setNextCursor(res.data?.next_cursor ?? null);
        }
      } else {
        const res = await api.social.GET('/v1/channels/{channel_id}/following', {
          params: {
            path: { channel_id: channelId },
            query: { cursor: nextCursor },
          },
        });
        if (res.response.ok && res.data) {
          setItems((prev) => [...prev, ...(res.data?.items || [])]);
          setNextCursor(res.data?.next_cursor ?? null);
        }
      }
    } catch {
      // Ignored
    }
  };

  if (!isOpen) return null;

  const title = type === 'followers' ? 'Người theo dõi' : 'Đang theo dõi';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="relations-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-md bg-[#18181b] border border-zinc-800 rounded-2xl p-6 text-white shadow-2xl flex flex-col gap-4 max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            {type === 'followers' ? (
              <Users className="w-5 h-5 text-red-500" />
            ) : (
              <UserPlus className="w-5 h-5 text-red-500" />
            )}
            <h2 id="relations-modal-title" className="text-lg font-bold">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-[160px] max-h-[50vh] pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <div className="h-6 w-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : isPrivate ? (
            <div className="flex flex-col items-center justify-center text-center p-6 space-y-3">
              <div className="p-3 bg-zinc-800 rounded-full text-zinc-400">
                <Lock className="w-8 h-8" />
              </div>
              <p className="text-sm font-semibold text-zinc-200">Tài khoản này là riêng tư</p>
              <p className="text-xs text-zinc-400 max-w-xs">
                Chỉ những người được phê duyệt theo dõi mới có thể xem danh sách này.
              </p>
            </div>
          ) : errorMessage ? (
            <div className="text-center py-8 text-xs text-red-400">{errorMessage}</div>
          ) : items.length === 0 ? (
            <div className="text-center py-8 text-xs text-zinc-400">
              {type === 'followers' ? 'Chưa có người theo dõi nào.' : 'Chưa theo dõi ai.'}
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {items.map((item, idx) => {
                const u = item.user;
                return (
                  <div
                    key={`${u.handle}-${idx}`}
                    className="flex items-center justify-between py-3 hover:bg-zinc-800/40 px-2 rounded-xl transition"
                  >
                    <Link
                      href={`/c/${u.handle}`}
                      onClick={onClose}
                      className="flex items-center gap-3 min-w-0"
                    >
                      {u.avatar_url ? (
                        <img
                          src={u.avatar_url}
                          alt={u.display_name}
                          className="w-10 h-10 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-red-600 font-bold text-white flex items-center justify-center text-sm shrink-0">
                          {u.display_name.charAt(0)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate hover:underline">
                          {u.display_name}
                        </p>
                        <p className="text-xs text-zinc-400 truncate">@{u.handle}</p>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          )}

          {nextCursor && !isLoading && !isPrivate && (
            <div className="pt-3 text-center">
              <button
                type="button"
                onClick={handleLoadMore}
                className="px-4 py-1.5 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-zinc-800 rounded-lg transition"
              >
                Tải thêm
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
