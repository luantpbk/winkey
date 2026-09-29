'use client';

import React, { useState } from 'react';
import type { Video } from '@winkey/api-client';
import { Link } from '../../../../i18n/routing';
import { formatViews, formatRelativeTime } from '../../../../lib/format';
import { ThumbsUp, Share2, Bookmark, Check } from 'lucide-react';

export function WatchClientSection({ video }: { video: Video }) {
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(video.like_count);
  const [subscribed, setSubscribed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleLike = () => {
    setLiked(!liked);
    setLikes((prev) => (liked ? prev - 1 : prev + 1));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Channel row + Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 py-2 border-b border-[#272727] dark:border-[#272727] border-gray-200">
        {/* Channel info */}
        <div className="flex items-center gap-3">
          <Link href={`/c/${video.owner.handle}`} className="shrink-0">
            {video.owner.avatar_url ? (
              <img
                src={video.owner.avatar_url}
                alt={video.owner.display_name}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 font-bold text-white text-sm">
                {video.owner.display_name.charAt(0)}
              </div>
            )}
          </Link>
          <div className="flex flex-col">
            <Link
              href={`/c/${video.owner.handle}`}
              className="font-bold text-sm text-gray-900 dark:text-white hover:underline"
            >
              {video.owner.display_name}
            </Link>
            <span className="text-xs text-gray-500 dark:text-gray-400">@{video.owner.handle}</span>
          </div>

          <button
            onClick={() => setSubscribed(!subscribed)}
            className={`ml-4 rounded-full px-4 py-2 text-xs font-semibold transition ${
              subscribed
                ? 'bg-[#272727] dark:bg-[#272727] bg-gray-200 text-gray-300'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            {subscribed ? 'Đã đăng ký' : 'Đăng ký'}
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleLike}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
              liked
                ? 'bg-red-600/20 text-red-500 border border-red-500/40'
                : 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-gray-800 dark:text-gray-200 hover:bg-[#383838]'
            }`}
          >
            <ThumbsUp className={`h-4 w-4 ${liked ? 'fill-current' : ''}`} />
            <span>{likes.toLocaleString()}</span>
          </button>

          <button
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(window.location.href);
                alert('Đã sao chép liên kết video!');
              }
            }}
            className="flex items-center gap-2 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
          >
            <Share2 className="h-4 w-4" />
            <span>Chia sẻ</span>
          </button>
        </div>
      </div>

      {/* Description Box */}
      <div className="rounded-2xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 p-4 text-sm text-gray-800 dark:text-gray-200">
        <div className="flex items-center gap-2 font-semibold text-xs text-gray-900 dark:text-white mb-2">
          <span>{formatViews(video.view_count)} lượt xem</span>
          <span>•</span>
          <span>{formatRelativeTime(video.published_at)}</span>
        </div>

        <div className={`whitespace-pre-line ${isExpanded ? '' : 'line-clamp-3'}`}>
          {video.description || 'Không có mô tả chi tiết cho video này.'}
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 text-xs font-bold text-gray-500 hover:text-white transition"
        >
          {isExpanded ? 'Thu gọn' : 'Xem thêm'}
        </button>
      </div>
    </div>
  );
}
