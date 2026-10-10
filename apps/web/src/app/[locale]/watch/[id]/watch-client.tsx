'use client';

import React, { useState } from 'react';
import type { Video } from '@winkey/api-client';
import { Link } from '../../../../i18n/routing';
import { formatViews, formatRelativeTime } from '../../../../lib/format';
import { Share2, Flag, Subtitles, Clock, BookmarkPlus, Pencil } from 'lucide-react';
import { LikeButton } from '../../../../components/social/like-button';
import { SubscribeButton } from '../../../../components/social/subscribe-button';
import { ReportDialog } from '../../../../components/moderation/report-dialog';
import { VideoSubtitlesDialog } from '../../../../components/studio/video-subtitles-dialog';
import { SavePlaylistDialog } from '../../../../components/playlist/save-playlist-dialog';
import { addToWatchLater } from '../../../../lib/playlist/playlist-utils';
import { useToast } from '../../../../components/ui/toast';
import { useAuth } from '../../../../lib/auth/auth-context';

export function WatchClientSection({ video }: { video: Video }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showSubtitlesDialog, setShowSubtitlesDialog] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const { showToast } = useToast();
  const { user, isAuthenticated } = useAuth();
  const isOwner = user?.id === video.owner.id;

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

          <div className="ml-4">
            <SubscribeButton channelId={video.owner.id} />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <LikeButton videoId={video.id} initialLikeCount={video.like_count} />

          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined' && navigator.clipboard) {
                navigator.clipboard.writeText(window.location.href);
                alert('Đã sao chép liên kết video!');
              }
            }}
            aria-label="Chia sẻ video"
            className="flex items-center gap-2 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
          >
            <Share2 className="h-4 w-4" />
            <span>Chia sẻ</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!isAuthenticated) {
                showToast({ title: 'Vui lòng đăng nhập để lưu vào Xem sau', type: 'info' });
                return;
              }
              await addToWatchLater(video.id, { showToast });
            }}
            aria-label="Xem sau"
            data-testid="watch-page-watch-later-btn"
            className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
          >
            <Clock className="h-4 w-4" />
            <span>Xem sau</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (!isAuthenticated) {
                showToast({ title: 'Vui lòng đăng nhập để lưu vào danh sách phát', type: 'info' });
                return;
              }
              setShowSaveDialog(true);
            }}
            aria-label="Lưu vào danh sách phát"
            data-testid="watch-page-save-btn"
            className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
          >
            <BookmarkPlus className="h-4 w-4" />
            <span>Lưu</span>
          </button>

          {isOwner && (
            <>
              <Link
                href={`/studio/videos/${video.id}/edit`}
                aria-label="Chỉnh sửa video"
                data-testid="owner-edit-video-btn"
                className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:text-white transition"
              >
                <Pencil className="h-4 w-4 text-red-500" />
                <span>Chỉnh sửa</span>
              </Link>

              <button
                type="button"
                onClick={() => setShowSubtitlesDialog(true)}
                aria-label="Quản lý phụ đề"
                data-testid="owner-manage-subtitles"
                className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:text-white transition"
              >
                <Subtitles className="h-4 w-4 text-red-500" />
                <span>Phụ đề</span>
              </button>
            </>
          )}

          {!isOwner && (
            <button
              type="button"
              onClick={() => setShowReportDialog(true)}
              aria-label="Báo cáo video"
              className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:text-red-500 transition"
            >
              <Flag className="h-3.5 w-3.5 text-red-500" />
              <span>Báo cáo</span>
            </button>
          )}
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
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 text-xs font-bold text-gray-500 hover:text-white transition"
        >
          {isExpanded ? 'Thu gọn' : 'Xem thêm'}
        </button>
      </div>

      {/* Report Video Dialog */}
      <ReportDialog
        isOpen={showReportDialog}
        onClose={() => setShowReportDialog(false)}
        targetType="VIDEO"
        targetId={video.id}
        targetTitle={video.title}
      />

      {/* Owner Subtitles Dialog */}
      <VideoSubtitlesDialog
        videoId={video.id}
        isOpen={showSubtitlesDialog}
        onClose={() => setShowSubtitlesDialog(false)}
      />

      {/* Save to Playlist Dialog */}
      <SavePlaylistDialog
        videoId={video.id}
        isOpen={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
      />
    </div>
  );
}
