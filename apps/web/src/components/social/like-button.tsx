'use client';

import React, { useState, useEffect } from 'react';
import { ThumbsUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';

import { useRealtimeRoom } from '../../lib/realtime/realtime-context';

export interface LikeButtonProps {
  videoId: string;
  initialLikeCount?: number;
}

export function LikeButton({ videoId, initialLikeCount = 0 }: LikeButtonProps) {
  const t = useTranslations('social');
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();

  const [liked, setLiked] = useState<boolean>(false);
  const [likeCount, setLikeCount] = useState<number>(initialLikeCount);
  const [isPending, setIsPending] = useState<boolean>(false);
  const isPendingRef = React.useRef(isPending);
  isPendingRef.current = isPending;

  const fetchLikeState = React.useCallback(async () => {
    try {
      const { data, response } = await api.social.GET('/v1/videos/{video_id}/like', {
        params: { path: { video_id: videoId } },
      });
      if (response.ok && data) {
        setLiked(data.liked);
        setLikeCount(data.like_count);
      }
    } catch {
      // Ignore background fetch error, keep default
    }
  }, [videoId]);

  useEffect(() => {
    fetchLikeState();
  }, [fetchLikeState]);

  // Subscribe to video:{id} room for realtime like.count updates
  useRealtimeRoom(
    `video:${videoId}`,
    (event) => {
      if (event.event === 'like.count') {
        // Do not fight an in-flight optimistic toggle of the same user
        if (!isPendingRef.current) {
          setLikeCount(event.data.like_count);
        }
      }
    },
    () => {
      // Re-fetch REST state after socket reconnects
      fetchLikeState();
    },
  );

  const handleToggleLike = async () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    if (isPending) return;

    const previousLiked = liked;
    const previousCount = likeCount;

    // Optimistic toggle
    const nextLiked = !liked;
    const nextCount = nextLiked ? previousCount + 1 : Math.max(0, previousCount - 1);
    setLiked(nextLiked);
    setLikeCount(nextCount);
    setIsPending(true);

    try {
      if (nextLiked) {
        const { data, response } = await api.social.PUT('/v1/videos/{video_id}/like', {
          params: { path: { video_id: videoId } },
        });
        if (!response.ok || !data) {
          // Rollback
          setLiked(previousLiked);
          setLikeCount(previousCount);
        } else {
          setLiked(data.liked);
          setLikeCount(data.like_count);
        }
      } else {
        const { data, response } = await api.social.DELETE('/v1/videos/{video_id}/like', {
          params: { path: { video_id: videoId } },
        });
        if (!response.ok || !data) {
          // Rollback
          setLiked(previousLiked);
          setLikeCount(previousCount);
        } else {
          setLiked(data.liked);
          setLikeCount(data.like_count);
        }
      }
    } catch {
      // Rollback on network exception
      setLiked(previousLiked);
      setLikeCount(previousCount);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggleLike}
      aria-label={liked ? t('liked') : t('like')}
      aria-pressed={liked}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-600 ${
        liked
          ? 'bg-red-600/20 text-red-500 border border-red-500/40'
          : 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-gray-800 dark:text-gray-200 hover:bg-[#383838]'
      }`}
    >
      <ThumbsUp className={`h-4 w-4 ${liked ? 'fill-current' : ''}`} />
      <span>{likeCount.toLocaleString()}</span>
    </button>
  );
}
