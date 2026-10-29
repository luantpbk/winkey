'use client';

import React, { useState } from 'react';
import type { Post, VideoSummary } from '@winkey/api-client';
import type { HydratedPostVideo } from '../../../lib/video/hydrate-posts-videos';
import { api } from '../../../lib/api-client';
import { Link, useRouter } from '../../../i18n/routing';
import { formatRelativeTime } from '../../../lib/format';
import { PostBodyText } from './post-body-text';
import { PostImages } from './post-images';
import { PostVideoEmbed } from './post-video-embed';
import { PostReactions } from './post-reactions';
import {
  Globe,
  Users,
  MoreHorizontal,
  MessageCircle,
  Share2,
  Repeat,
  Quote,
  Copy,
  Check,
  Edit2,
  Trash2,
  Flag,
  ShieldAlert,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../../../lib/auth/auth-context';
import { ReportDialog } from '../../moderation/report-dialog';

export interface PostCardProps {
  post: Post;
  hydratedVideo?: HydratedPostVideo | VideoSummary | null;
  onPostUpdated?: (updated: Post) => void;
  onPostDeleted?: (postId: string) => void;
  onQuoteReshare?: (post: Post) => void;
  showCommentsInline?: boolean;
}

export function PostCard({
  post,
  hydratedVideo,
  onPostUpdated,
  onPostDeleted,
  onQuoteReshare,
  showCommentsInline: _showCommentsInline = false,
}: PostCardProps) {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [hasCopiedLink, setHasCopiedLink] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(post.body);
  const [editVisibility, setEditVisibility] = useState(post.visibility);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const authorName = post.author?.display_name || post.author?.handle || 'Người dùng Winkey';
  const authorHandle = post.author?.handle;
  const isAuthor = user?.id === post.author?.id;
  const isStaff = user?.roles?.some((r) => r === 'admin' || r === 'moderator') ?? false;

  const canReshare =
    post.visibility === 'PUBLIC' && !post.reshare_unavailable && post.status === 'VISIBLE';

  const handleCopyLink = async () => {
    try {
      const url = `${window.location.origin}/bai-viet/${post.id}`;
      await navigator.clipboard.writeText(url);
      setHasCopiedLink(true);
      setTimeout(() => setHasCopiedLink(false), 2000);
      setShowShareMenu(false);
    } catch {
      // ignore
    }
  };

  const handlePlainReshare = async () => {
    if (!isAuthenticated) {
      router.push('/login');
      return;
    }
    setShowShareMenu(false);
    try {
      const { data, response } = await api.social.POST('/v1/posts', {
        body: {
          body: '',
          reshare_of: post.id,
          visibility: 'PUBLIC',
        },
      });
      if (response.ok && data) {
        alert('Đã chia sẻ bài viết lên trang cá nhân!');
      } else if (response.status === 409) {
        alert('Bạn đã chia sẻ bài viết này rồi.');
      } else {
        alert('Không thể chia sẻ bài viết.');
      }
    } catch {
      alert('Lỗi kết nối khi chia sẻ bài viết.');
    }
  };

  const handleDelete = async () => {
    if (!confirm('Bạn có chắc chắn muốn xoá bài viết này?')) return;
    setIsDeleting(true);
    try {
      const { response } = await api.social.DELETE('/v1/posts/{post_id}', {
        params: { path: { post_id: post.id } },
      });
      if (response.ok || response.status === 204) {
        onPostDeleted?.(post.id);
      } else {
        alert('Không thể xoá bài viết.');
      }
    } catch {
      alert('Lỗi kết nối khi xoá bài viết.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingEdit(true);
    setEditError(null);

    try {
      const { data, response, error } = await api.social.PATCH('/v1/posts/{post_id}', {
        params: { path: { post_id: post.id } },
        body: {
          body: editBody.trim(),
          visibility: editVisibility,
        },
      });

      if (response.ok && data) {
        setIsEditing(false);
        onPostUpdated?.(data);
      } else {
        setEditError(error?.detail || 'Không thể lưu bài viết.');
      }
    } catch {
      setEditError('Lỗi kết nối khi lưu bài viết.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleModerate = async (action: 'HIDE' | 'RESTORE') => {
    if (
      !confirm(
        action === 'HIDE' ? 'Ẩn bài viết này khỏi cộng đồng?' : 'Khôi phục hiển thị bài viết?',
      )
    ) {
      return;
    }
    try {
      const { data, response } = await api.social.PUT('/v1/posts/{post_id}/moderation', {
        params: { path: { post_id: post.id } },
        body: { status: action === 'HIDE' ? 'HIDDEN' : 'VISIBLE' },
      });
      if (response.ok && data) {
        onPostUpdated?.(data);
      }
    } catch {
      alert('Thao tác kiểm duyệt thất bại.');
    }
  };

  return (
    <article
      data-testid={`post-card-${post.id}`}
      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm space-y-3.5 transition-colors"
    >
      {/* Header: Author & Options */}
      <div className="flex items-start justify-between gap-3">
        {/* Author info */}
        <div className="flex items-center gap-3 min-w-0">
          {authorHandle ? (
            <Link
              href={`/c/${authorHandle}`}
              className="shrink-0 relative focus:outline-none focus:ring-2 focus:ring-red-500 rounded-full"
            >
              {post.author?.avatar_url ? (
                <img
                  src={post.author.avatar_url}
                  alt={authorName}
                  className="w-10 h-10 rounded-full object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-red-600 text-white font-bold flex items-center justify-center">
                  {authorName.charAt(0).toUpperCase()}
                </div>
              )}
            </Link>
          ) : (
            <div className="w-10 h-10 rounded-full bg-zinc-700 text-white font-bold flex items-center justify-center">
              ?
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              {authorHandle ? (
                <Link
                  href={`/c/${authorHandle}`}
                  className="font-bold text-sm text-zinc-900 dark:text-zinc-100 hover:underline truncate"
                >
                  {authorName}
                </Link>
              ) : (
                <span className="font-bold text-sm text-zinc-500">{authorName}</span>
              )}
              {authorHandle && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate">
                  @{authorHandle}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
              <Link
                href={`/bai-viet/${post.id}`}
                className="hover:underline hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <time dateTime={post.created_at}>{formatRelativeTime(post.created_at)}</time>
              </Link>

              <span>•</span>

              <div
                className="flex items-center gap-1"
                title={
                  post.visibility === 'PUBLIC'
                    ? 'Bài viết công khai'
                    : 'Chỉ người theo dõi mới xem được'
                }
              >
                {post.visibility === 'PUBLIC' ? (
                  <Globe className="w-3.5 h-3.5" />
                ) : (
                  <Users className="w-3.5 h-3.5" />
                )}
              </div>

              {post.edited_at && (
                <>
                  <span>•</span>
                  <span className="italic">Đã chỉnh sửa</span>
                </>
              )}

              {post.status === 'HIDDEN' && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-500">
                  Đã ẩn bởi kiểm duyệt
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Post Options Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowMenu((prev) => !prev)}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Tùy chọn bài viết"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl py-1 z-30 text-xs">
              {post.can_edit && (
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(true);
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  <span>Chỉnh sửa bài viết</span>
                </button>
              )}

              {post.can_delete && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    handleDelete();
                  }}
                  disabled={isDeleting}
                  className="w-full px-3 py-2 text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xoá bài viết</span>
                </button>
              )}

              {isStaff && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    handleModerate(post.status === 'HIDDEN' ? 'RESTORE' : 'HIDE');
                  }}
                  className="w-full px-3 py-2 text-left text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center gap-2"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>{post.status === 'HIDDEN' ? 'Khôi phục bài viết' : 'Ẩn bài viết'}</span>
                </button>
              )}

              {!isAuthor && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    setShowReportDialog(true);
                  }}
                  className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>Báo cáo bài viết</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  handleCopyLink();
                }}
                className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Sao chép liên kết</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Edit Form */}
      {isEditing ? (
        <form onSubmit={handleSaveEdit} className="space-y-3 pt-2">
          <textarea
            rows={3}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="w-full p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-red-500"
          />
          <div className="flex items-center justify-between">
            <select
              value={editVisibility}
              onChange={(e) => setEditVisibility(e.target.value as any)}
              className="px-2 py-1 text-xs bg-zinc-100 dark:bg-zinc-800 rounded-lg text-zinc-700 dark:text-zinc-300"
            >
              <option value="PUBLIC">Công khai</option>
              <option value="FOLLOWERS">Người theo dõi</option>
            </select>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-lg"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={
                  isSavingEdit ||
                  (editBody.trim().length === 0 && !post.images?.length && !post.video_id)
                }
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold disabled:opacity-50"
              >
                {isSavingEdit ? 'Đang lưu...' : 'Lưu thay đổi'}
              </button>
            </div>
          </div>
          {editError && <p className="text-xs text-red-500">{editError}</p>}
        </form>
      ) : (
        /* Body Text */
        post.body && (
          <PostBodyText body={post.body} mentions={post.mentions} hashtags={post.hashtags} />
        )
      )}

      {/* Images Grid */}
      {post.images && post.images.length > 0 && (
        <PostImages images={post.images} authorName={authorName} />
      )}

      {/* Embedded Video */}
      {post.video_id && <PostVideoEmbed video={hydratedVideo || null} videoId={post.video_id} />}

      {/* Reshared Post */}
      {post.reshare_of && (
        <div className="mt-3">
          {post.reshare_unavailable ? (
            <div className="p-4 bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex items-center gap-2.5 text-xs text-zinc-500">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <span>Bài viết này không còn khả dụng (đã bị xoá hoặc giới hạn quyền xem).</span>
            </div>
          ) : post.reshared_post ? (
            <div className="p-4 bg-zinc-50 dark:bg-zinc-950/40 border border-zinc-200 dark:border-zinc-800 rounded-2xl space-y-2.5">
              <div className="flex items-center gap-2 text-xs">
                <Link
                  href={`/c/${post.reshared_post.author?.handle}`}
                  className="font-bold text-zinc-900 dark:text-zinc-200 hover:underline"
                >
                  {post.reshared_post.author?.display_name || post.reshared_post.author?.handle}
                </Link>
                <span className="text-zinc-400">@{post.reshared_post.author?.handle}</span>
                <span className="text-zinc-400">•</span>
                <span className="text-zinc-400">
                  {formatRelativeTime(post.reshared_post.created_at)}
                </span>
              </div>
              {post.reshared_post.body && (
                <PostBodyText
                  body={post.reshared_post.body}
                  mentions={post.reshared_post.mentions}
                  hashtags={post.reshared_post.hashtags}
                />
              )}
              {post.reshared_post.images && post.reshared_post.images.length > 0 && (
                <PostImages
                  images={post.reshared_post.images}
                  authorName={post.reshared_post.author?.display_name}
                />
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Footer: Reactions Bar & Comments & Share */}
      <div className="space-y-2">
        <PostReactions
          postId={post.id}
          initialMyReaction={post.my_reaction}
          initialReactionCount={post.reaction_count}
          initialTopReactions={post.top_reactions}
          isAuthenticated={isAuthenticated}
          onRequireAuth={() => router.push('/login')}
        />

        {/* Action bar: Comment & Share */}
        <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800/60 text-xs text-zinc-500 dark:text-zinc-400">
          {/* Comments link/button */}
          <Link
            href={`/bai-viet/${post.id}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors"
            aria-label={`Bình luận (${post.comment_count})`}
          >
            <MessageCircle className="w-4 h-4" />
            <span>Bình luận</span>
            {post.comment_count > 0 && (
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                ({post.comment_count})
              </span>
            )}
          </Link>

          {/* Share button & dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowShareMenu((prev) => !prev)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors"
              aria-label="Chia sẻ bài viết"
            >
              <Share2 className="w-4 h-4" />
              <span>Chia sẻ</span>
              {post.reshare_count > 0 && (
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                  ({post.reshare_count})
                </span>
              )}
            </button>

            {showShareMenu && (
              <div className="absolute right-0 bottom-full mb-1 w-48 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl py-1 z-30 text-xs">
                {canReshare && (
                  <>
                    <button
                      type="button"
                      onClick={handlePlainReshare}
                      className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                    >
                      <Repeat className="w-3.5 h-3.5" />
                      <span>Chia sẻ ngay</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowShareMenu(false);
                        onQuoteReshare?.(post);
                      }}
                      className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                    >
                      <Quote className="w-3.5 h-3.5" />
                      <span>Trích dẫn bài viết</span>
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="w-full px-3 py-2 text-left text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                >
                  {hasCopiedLink ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="text-emerald-500 font-semibold">Đã sao chép!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Sao chép liên kết</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Report Dialog */}
      <ReportDialog
        isOpen={showReportDialog}
        onClose={() => setShowReportDialog(false)}
        targetType="POST"
        targetId={post.id}
        targetTitle={`Bài viết của ${authorName}`}
      />
    </article>
  );
}
