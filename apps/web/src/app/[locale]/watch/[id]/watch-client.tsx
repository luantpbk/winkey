'use client';

import React, { useState } from 'react';
import type { Video } from '@winkey/api-client';
import { Link, useRouter, usePathname } from '../../../../i18n/routing';
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
import { computePermissions } from '../../../../lib/auth';

export function WatchClientSection({
  video,
  mobileEpisodesSlot,
}: {
  video: Video;
  mobileEpisodesSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isExpanded, setIsExpanded] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showSubtitlesDialog, setShowSubtitlesDialog] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const { showToast } = useToast();
  const { user, can: rawCan, isLoading, isAuthenticated } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);
  const isOwner = user?.id === video.owner.id;

  return (
    <div className="flex flex-col gap-4">
      {/* Channel row + Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 py-2 border-b border-[#272727] dark:border-[#272727] border-gray-200">
        {/* Channel info */}
        <div className="flex items-center justify-between sm:justify-start gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <Link href={`/c/${video.owner.handle}`} className="shrink-0">
              {video.owner.avatar_url ? (
                <img
                  src={video.owner.avatar_url}
                  alt={video.owner.display_name}
                  className="h-10 w-10 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#D9002B] font-bold text-white text-sm">
                  {video.owner.display_name.charAt(0)}
                </div>
              )}
            </Link>
            <div className="flex flex-col min-w-0">
              <Link
                href={`/c/${video.owner.handle}`}
                className="font-bold text-sm text-gray-900 dark:text-white hover:underline truncate"
              >
                {video.owner.display_name}
              </Link>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                @{video.owner.handle}
              </span>
            </div>
          </div>

          <div className="shrink-0 ml-2">
            <SubscribeButton channelId={video.owner.id} />
          </div>
        </div>

        {/* Action buttons (horizontally scrollable, equal 40px height, right fade) */}
        <div className="relative w-full lg:w-auto min-w-0 max-w-full">
          <div
            data-testid="watch-action-bar"
            className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1 scroll-smooth w-full pr-6 lg:pr-0"
          >
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
              data-testid="watch-share-btn"
              className="inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center gap-2 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 text-xs font-semibold text-gray-900 dark:text-white transition"
            >
              <Share2 className="h-4 w-4" />
              <span>Chia sẻ</span>
            </button>

            <button
              type="button"
              disabled={isLoading}
              onClick={async () => {
                if (isLoading) {
                  return;
                }
                if (!isAuthenticated) {
                  showToast({ title: 'Vui lòng đăng nhập để lưu vào Xem sau', type: 'info' });
                  return;
                }
                await addToWatchLater(video.id, { showToast });
              }}
              aria-label="Xem sau"
              data-testid="watch-page-watch-later-btn"
              className="inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 text-xs font-semibold text-gray-900 dark:text-white transition disabled:opacity-50"
            >
              <Clock className="h-4 w-4" />
              <span>Xem sau</span>
            </button>

            <button
              type="button"
              disabled={isLoading}
              onClick={() => {
                if (isLoading) {
                  return;
                }
                if (!isAuthenticated) {
                  const currentPath =
                    pathname && pathname.startsWith('/watch')
                      ? `${pathname}${typeof window !== 'undefined' ? window.location.search : ''}`
                      : `/watch/${video.id}${typeof window !== 'undefined' ? window.location.search : ''}`;
                  router.push(`/login?return_to=${encodeURIComponent(currentPath)}`);
                  return;
                }
                setShowSaveDialog(true);
              }}
              aria-label="Lưu vào danh sách phát"
              data-testid="watch-page-save-btn"
              className="inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 text-xs font-semibold text-gray-900 dark:text-white transition disabled:opacity-50"
            >
              <BookmarkPlus className="h-4 w-4" />
              <span>Lưu</span>
            </button>

            {isOwner && can.studio && (
              <>
                <Link
                  href={`/studio/videos/${video.id}/edit`}
                  aria-label="Chỉnh sửa video"
                  data-testid="owner-edit-video-btn"
                  className="inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 text-xs font-semibold text-gray-900 dark:text-white hover:text-white transition"
                >
                  <Pencil className="h-4 w-4 text-red-500" />
                  <span>Chỉnh sửa</span>
                </Link>

                <button
                  type="button"
                  onClick={() => setShowSubtitlesDialog(true)}
                  aria-label="Quản lý phụ đề"
                  data-testid="owner-manage-subtitles"
                  className="inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-4 text-xs font-semibold text-gray-900 dark:text-white hover:text-white transition"
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
                data-testid="watch-report-btn"
                className="inline-flex h-10 min-w-10 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-3.5 text-xs font-semibold text-gray-900 dark:text-white hover:text-red-500 transition"
              >
                <Flag className="h-4 w-4 text-red-500" />
                <span className="hidden sm:inline">Báo cáo</span>
              </button>
            )}
          </div>

          {/* Right edge fade gradient on overflow */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-white dark:from-[#0f0f0f] to-transparent lg:hidden"
          />
        </div>
      </div>

      {/* Mobile Episode List Slot (under action row on screens < lg) */}
      {mobileEpisodesSlot}

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
          className="mt-2 text-xs font-bold text-gray-600 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white transition"
        >
          {isExpanded ? 'Thu gọn' : 'Xem thêm'}
        </button>

        {/* Tags */}
        {video.tags && video.tags.length > 0 && (
          <div
            data-testid="watch-tag-chips"
            className="mt-3 flex flex-wrap gap-2 pt-3 border-t border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200"
          >
            {video.tags.map((tag, idx) => {
              const slug = video.tag_slugs?.[idx];
              if (slug && slug !== '') {
                return (
                  <Link
                    key={`${tag}-${idx}`}
                    href={`/tag/${slug}`}
                    data-testid={`watch-tag-chip-${idx}`}
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-[#272727] dark:bg-[#272727] bg-gray-200 text-red-500 dark:text-red-400 hover:underline hover:bg-[#333] transition"
                  >
                    #{tag}
                  </Link>
                );
              }
              return (
                <span
                  key={`${tag}-${idx}`}
                  data-testid={`watch-tag-chip-${idx}`}
                  className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-[#272727] dark:bg-[#272727] bg-gray-200 text-gray-400 dark:text-gray-400"
                >
                  #{tag}
                </span>
              );
            })}
          </div>
        )}
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
