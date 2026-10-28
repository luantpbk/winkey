'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { PostComment } from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { Link } from '../../../i18n/routing';
import { formatRelativeTime } from '../../../lib/format';
import {
  MessageSquare,
  Send,
  MoreHorizontal,
  Edit2,
  Trash2,
  ShieldAlert,
  Loader2,
  ChevronDown,
  ChevronUp,
  X,
  Flag,
} from 'lucide-react';
import { useAuth } from '../../../lib/auth/auth-context';
import { ReportDialog } from '../../moderation/report-dialog';

export interface PostCommentsProps {
  postId: string;
}

export function PostComments({ postId }: PostCommentsProps) {
  const { user, isAuthenticated } = useAuth();
  const [comments, setComments] = useState<PostComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [newCommentBody, setNewCommentBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchComments = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, response } = await api.social.GET('/v1/posts/{post_id}/comments', {
        params: {
          path: { post_id: postId },
          query: { limit: 20 },
        },
      });
      if (response.ok && data) {
        setComments(data.items || []);
        setNextCursor(data.next_cursor || null);
      }
    } catch {
      setComments([]);
    } finally {
      setIsLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const { data, response } = await api.social.GET('/v1/posts/{post_id}/comments', {
        params: {
          path: { post_id: postId },
          query: { cursor: nextCursor, limit: 20 },
        },
      });
      if (response.ok && data) {
        setComments((prev) => [...prev, ...(data.items || [])]);
        setNextCursor(data.next_cursor || null);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleCreateComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentBody.trim() || isSubmitting) return;

    if (!isAuthenticated) {
      alert('Vui lòng đăng nhập để bình luận.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const { data, response, error } = await api.social.POST('/v1/posts/{post_id}/comments', {
        params: { path: { post_id: postId } },
        body: { body: newCommentBody.trim() },
      });

      if (response.ok && data) {
        setComments((prev) => [data, ...prev]);
        setNewCommentBody('');
      } else {
        if (response.status === 429) {
          setErrorMsg(
            'Bạn đang bình luận quá nhanh (tối đa 10 bình luận/phút). Vui lòng thử lại sau.',
          );
        } else {
          setErrorMsg(error?.detail || 'Không thể đăng bình luận.');
        }
      }
    } catch {
      setErrorMsg('Lỗi kết nối khi gửi bình luận.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-800 pb-3">
        <MessageSquare className="w-5 h-5 text-red-500" />
        <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
          Bình luận ({comments.length})
        </h3>
      </div>

      {/* Composer */}
      <form onSubmit={handleCreateComment} className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-red-600 text-white font-bold flex items-center justify-center shrink-0">
            {user?.display_name?.charAt(0) || user?.handle?.charAt(0) || 'U'}
          </div>
          <div className="flex-1 space-y-2">
            <textarea
              rows={2}
              value={newCommentBody}
              onChange={(e) => setNewCommentBody(e.target.value)}
              placeholder="Viết bình luận của bạn..."
              className="w-full p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-red-500 resize-none"
            />
            {errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!newCommentBody.trim() || isSubmitting}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-red-600/10 transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>Bình luận</span>
              </button>
            </div>
          </div>
        </div>
      </form>

      {/* Comments List */}
      {isLoading ? (
        <div className="py-8 text-center text-xs text-zinc-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-red-500" />
          <span>Đang tải bình luận...</span>
        </div>
      ) : comments.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-400">
          Chưa có bình luận nào. Hãy là người đầu tiên bình luận!
        </div>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => (
            <PostCommentItem
              key={comment.id}
              comment={comment}
              postId={postId}
              onCommentDeleted={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
              onCommentUpdated={(updated) =>
                setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
              }
            />
          ))}

          {nextCursor && (
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="px-4 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:text-red-500 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-xl transition-colors inline-flex items-center gap-1.5"
              >
                {isLoadingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                <span>Xem thêm bình luận</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface PostCommentItemProps {
  comment: PostComment;
  postId: string;
  onCommentDeleted: (id: string) => void;
  onCommentUpdated: (comment: PostComment) => void;
}

function PostCommentItem({
  comment,
  postId,
  onCommentDeleted,
  onCommentUpdated,
}: PostCommentItemProps) {
  const { user } = useAuth();
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);
  const [replies, setReplies] = useState<PostComment[]>([]);
  const [showReplies, setShowReplies] = useState(false);
  const [isLoadingReplies, setIsLoadingReplies] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);

  const isAuthor = user?.id === comment.author?.id;
  const isStaff = user?.roles?.some((r) => r === 'admin' || r === 'moderator') ?? false;

  const fetchReplies = async () => {
    setIsLoadingReplies(true);
    try {
      const { data, response } = await api.social.GET('/v1/post-comments/{comment_id}/replies', {
        params: { path: { comment_id: comment.id } },
      });
      if (response.ok && data) {
        setReplies(data.items || []);
        setShowReplies(true);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingReplies(false);
    }
  };

  const handleCreateReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyBody.trim() || isSubmittingReply) return;

    setIsSubmittingReply(true);
    try {
      const { data, response } = await api.social.POST('/v1/posts/{post_id}/comments', {
        params: { path: { post_id: postId } },
        body: { body: replyBody.trim(), parent_id: comment.id },
      });

      if (response.ok && data) {
        setReplies((prev) => [...prev, data]);
        setShowReplies(true);
        setReplyBody('');
        setShowReplyForm(false);
        onCommentUpdated({ ...comment, reply_count: comment.reply_count + 1 });
      }
    } catch {
      alert('Không thể đăng câu trả lời.');
    } finally {
      setIsSubmittingReply(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editBody.trim() || isSavingEdit) return;

    setIsSavingEdit(true);
    try {
      const { data, response } = await api.social.PATCH('/v1/post-comments/{comment_id}', {
        params: { path: { comment_id: comment.id } },
        body: { body: editBody.trim() },
      });

      if (response.ok && data) {
        setIsEditing(false);
        onCommentUpdated(data);
      }
    } catch {
      alert('Không thể lưu chỉnh sửa bình luận.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Bạn có chắc chắn muốn xoá bình luận này?')) return;
    try {
      const { response } = await api.social.DELETE('/v1/post-comments/{comment_id}', {
        params: { path: { comment_id: comment.id } },
      });
      if (response.ok || response.status === 204) {
        onCommentDeleted(comment.id);
      }
    } catch {
      alert('Không thể xoá bình luận.');
    }
  };

  const handleModerate = async (action: 'HIDE' | 'RESTORE') => {
    try {
      const { data, response } = await api.social.PUT('/v1/post-comments/{comment_id}/moderation', {
        params: { path: { comment_id: comment.id } },
        body: { status: action === 'HIDE' ? 'HIDDEN' : 'VISIBLE' },
      });
      if (response.ok && data) {
        onCommentUpdated(data);
      }
    } catch {
      alert('Thao tác kiểm duyệt bình luận thất bại.');
    }
  };

  if (comment.status === 'DELETED') {
    return (
      <div className="py-2.5 px-3 bg-zinc-50 dark:bg-zinc-950/40 rounded-xl text-xs text-zinc-400 italic">
        Bình luận này đã bị xoá.
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 text-xs sm:text-sm">
      {/* Avatar */}
      {comment.author?.handle ? (
        <Link href={`/@${comment.author.handle}`} className="shrink-0 mt-0.5">
          {comment.author.avatar_url ? (
            <img
              src={comment.author.avatar_url}
              alt={comment.author.display_name}
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-zinc-700 text-white font-bold flex items-center justify-center text-xs">
              {comment.author.display_name?.charAt(0) || 'U'}
            </div>
          )}
        </Link>
      ) : (
        <div className="w-8 h-8 rounded-full bg-zinc-700 text-white font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">
          ?
        </div>
      )}

      {/* Main body */}
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="p-3 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl relative group">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {comment.author?.handle ? (
                <Link
                  href={`/@${comment.author.handle}`}
                  className="font-bold text-zinc-900 dark:text-zinc-100 hover:underline"
                >
                  {comment.author.display_name}
                </Link>
              ) : (
                <span className="font-bold text-zinc-500">Người dùng</span>
              )}
              <span className="text-[11px] text-zinc-400">
                {formatRelativeTime(comment.created_at)}
              </span>
              {comment.edited_at && (
                <span className="text-[10px] text-zinc-400 italic">(đã sửa)</span>
              )}
              {comment.status === 'HIDDEN' && (
                <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-500/15 text-amber-500">
                  Đã ẩn
                </span>
              )}
            </div>

            {/* Menu */}
            {(comment.can_edit || comment.can_delete || isStaff) && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowMenu((prev) => !prev)}
                  className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded"
                  aria-label="Tùy chọn bình luận"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg py-1 z-30 text-xs">
                    {comment.can_edit && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditing(true);
                          setShowMenu(false);
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                      >
                        <Edit2 className="w-3 h-3" />
                        <span>Sửa</span>
                      </button>
                    )}
                    {comment.can_delete && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          handleDelete();
                        }}
                        className="w-full px-3 py-1.5 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 flex items-center gap-2"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Xoá</span>
                      </button>
                    )}
                    {isStaff && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          handleModerate(comment.status === 'HIDDEN' ? 'RESTORE' : 'HIDE');
                        }}
                        className="w-full px-3 py-1.5 text-left text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/20 flex items-center gap-2"
                      >
                        <ShieldAlert className="w-3 h-3" />
                        <span>{comment.status === 'HIDDEN' ? 'Hiện' : 'Ẩn'}</span>
                      </button>
                    )}
                    {!isAuthor && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          setShowReportDialog(true);
                        }}
                        className="w-full px-3 py-1.5 text-left text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                      >
                        <Flag className="w-3 h-3" />
                        <span>Báo cáo</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Edit form or Body */}
          {isEditing ? (
            <form onSubmit={handleSaveEdit} className="space-y-2 pt-1">
              <textarea
                rows={2}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                className="w-full p-2 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-white"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-2.5 py-1 text-xs text-zinc-500"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={isSavingEdit || !editBody.trim()}
                  className="px-3 py-1 bg-red-600 text-white rounded text-xs font-semibold"
                >
                  Lưu
                </button>
              </div>
            </form>
          ) : (
            <p className="text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words">
              {comment.body}
            </p>
          )}
        </div>

        {/* Action bar under comment */}
        <div className="flex items-center gap-3 px-2 text-xs text-zinc-400">
          <button
            type="button"
            onClick={() => setShowReplyForm((prev) => !prev)}
            className="hover:text-red-500 font-semibold"
          >
            Trả lời
          </button>

          {comment.reply_count > 0 && (
            <button
              type="button"
              onClick={() => {
                if (!showReplies && replies.length === 0) {
                  fetchReplies();
                } else {
                  setShowReplies((prev) => !prev);
                }
              }}
              className="hover:text-zinc-200 font-semibold flex items-center gap-1"
            >
              {showReplies ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              <span>{comment.reply_count} câu trả lời</span>
            </button>
          )}
        </div>

        {/* Reply Composer */}
        {showReplyForm && (
          <form onSubmit={handleCreateReply} className="flex items-center gap-2 pt-1 pl-2">
            <input
              type="text"
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder="Trả lời bình luận này..."
              className="flex-1 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-red-500"
            />
            <button
              type="submit"
              disabled={isSubmittingReply || !replyBody.trim()}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold"
            >
              Gửi
            </button>
            <button
              type="button"
              onClick={() => setShowReplyForm(false)}
              className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        )}

        {/* Replies list */}
        {showReplies && (
          <div className="pl-4 sm:pl-6 border-l-2 border-zinc-200 dark:border-zinc-800 space-y-3 pt-2">
            {isLoadingReplies ? (
              <div className="py-2 text-xs text-zinc-500 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Đang tải câu trả lời...</span>
              </div>
            ) : (
              replies.map((reply) => (
                <PostCommentItem
                  key={reply.id}
                  comment={reply}
                  postId={postId}
                  onCommentDeleted={(id) => setReplies((prev) => prev.filter((r) => r.id !== id))}
                  onCommentUpdated={(updated) =>
                    setReplies((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
                  }
                />
              ))
            )}
          </div>
        )}
        {/* Report Dialog */}
        <ReportDialog
          isOpen={showReportDialog}
          onClose={() => setShowReportDialog(false)}
          targetType="POST_COMMENT"
          targetId={comment.id}
          targetTitle={`Bình luận của ${comment.author?.display_name || comment.author?.handle || 'Người dùng'}`}
        />
      </div>
    </div>
  );
}
