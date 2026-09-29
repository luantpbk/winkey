'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, MoreVertical, Edit2, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import type { Comment } from '@winkey/api-client';
import { formatRelativeTime } from '../../lib/format';
import { CommentComposer } from './comment-composer';
import { api } from '../../lib/api-client';
import { useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { mapSocialError } from './error-utils';

export interface CommentItemProps {
  comment: Comment;
  topLevelParentId?: string;
  onCommentUpdated?: (updated: Comment) => void;
  onCommentDeleted?: (commentId: string) => void;
  onReplyCreated?: (newReply: Comment) => void;
}

export function CommentItem({
  comment,
  topLevelParentId,
  onCommentUpdated,
  onCommentDeleted,
  onReplyCreated,
}: CommentItemProps) {
  const t = useTranslations('social');
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();

  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [showReplyComposer, setShowReplyComposer] = useState<boolean>(false);
  const [showMenu, setShowMenu] = useState<boolean>(false);

  // Replies state (only relevant for top-level comments)
  const isTopLevel = comment.parent_id === null;
  const [showReplies, setShowReplies] = useState<boolean>(false);
  const [replies, setReplies] = useState<Comment[]>([]);
  const [repliesCursor, setRepliesCursor] = useState<string | null>(null);
  const [isLoadingReplies, setIsLoadingReplies] = useState<boolean>(false);

  const isDeleted = comment.status === 'DELETED';
  const isHidden = comment.status === 'HIDDEN';

  // Do not render hidden comments
  if (isHidden) return null;

  // Replying always attaches to top-level parent:
  // If this comment is already a reply, its top-level parent is topLevelParentId || comment.parent_id
  const targetParentId = isTopLevel
    ? comment.id
    : topLevelParentId || comment.parent_id || comment.id;

  const loadReplies = async (cursor?: string | null) => {
    setIsLoadingReplies(true);
    try {
      const { data, response } = await api.social.GET('/v1/comments/{comment_id}/replies', {
        params: {
          path: { comment_id: comment.id },
          query: { cursor: cursor || undefined, limit: 10 },
        },
      });
      if (response.ok && data) {
        if (cursor) {
          setReplies((prev) => [...prev, ...data.items]);
        } else {
          setReplies(data.items);
        }
        setRepliesCursor(data.next_cursor);
      }
    } catch {
      // Ignore background fetch error
    } finally {
      setIsLoadingReplies(false);
    }
  };

  const toggleReplies = () => {
    if (!showReplies) {
      setShowReplies(true);
      if (replies.length === 0) {
        loadReplies();
      }
    } else {
      setShowReplies(false);
    }
  };

  const handleEditSubmit = async (newText: string) => {
    try {
      const { data, response } = await api.social.PATCH('/v1/comments/{comment_id}', {
        params: { path: { comment_id: comment.id } },
        body: { body: newText },
      });

      if (response.ok && data) {
        setIsEditing(false);
        if (onCommentUpdated) onCommentUpdated(data);
        return { success: true };
      }

      return {
        success: false,
        error: mapSocialError(response.status, null, t, 'editError'),
      };
    } catch {
      return {
        success: false,
        error: t('networkError'),
      };
    }
  };

  const handleDelete = async () => {
    setShowMenu(false);
    if (!confirm(t('deleteConfirm'))) return;

    try {
      const { response } = await api.social.DELETE('/v1/comments/{comment_id}', {
        params: { path: { comment_id: comment.id } },
      });

      if (response.ok) {
        if (onCommentDeleted) {
          onCommentDeleted(comment.id);
        }
      } else {
        alert(mapSocialError(response.status, null, t, 'deleteError'));
      }
    } catch {
      alert(t('networkError'));
    }
  };

  const handleReplySubmit = async (replyText: string) => {
    try {
      const { data, response } = await api.social.POST('/v1/videos/{video_id}/comments', {
        params: { path: { video_id: comment.video_id } },
        body: { body: replyText, parent_id: targetParentId },
      });

      if (response.ok && data) {
        setShowReplyComposer(false);
        if (isTopLevel) {
          setReplies((prev) => [...prev, data]);
          setShowReplies(true);
        }
        if (onReplyCreated) {
          onReplyCreated(data);
        }
        return { success: true };
      }

      const retryAfter = response.headers.get('retry-after');
      return {
        success: false,
        error: mapSocialError(response.status, retryAfter, t, 'replyError'),
      };
    } catch {
      return {
        success: false,
        error: t('networkError'),
      };
    }
  };

  const handleReplyClick = () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }
    setShowReplyComposer((prev) => !prev);
  };

  return (
    <div className="flex flex-col gap-2 py-3 border-b border-[#222] dark:border-[#222] border-gray-100 last:border-0">
      {/* Tombstone for deleted comments */}
      {isDeleted ? (
        <div className="flex items-center gap-3 py-2 text-xs italic text-gray-500 dark:text-gray-400 bg-gray-50/50 dark:bg-zinc-900/40 px-3 rounded-lg">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-800 text-gray-400">
            ?
          </div>
          <span>{t('deletedTombstone')}</span>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {/* Author avatar */}
          <div className="shrink-0 mt-0.5">
            {comment.author?.avatar_url ? (
              <img
                src={comment.author.avatar_url}
                alt={comment.author.display_name}
                className="h-9 w-9 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-white font-bold text-xs">
                {comment.author?.display_name ? comment.author.display_name.charAt(0) : '?'}
              </div>
            )}
          </div>

          {/* Comment content */}
          <div className="flex-1 min-w-0">
            {/* Author info & timestamp */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-xs text-gray-900 dark:text-white">
                  {comment.author?.display_name || t('anonymousUser')}
                </span>
                {comment.author?.handle && (
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    @{comment.author.handle}
                  </span>
                )}
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  {formatRelativeTime(comment.created_at)}
                </span>
                {comment.edited_at && (
                  <span className="text-[10px] text-gray-500 italic">{t('edited')}</span>
                )}
              </div>

              {/* Edit / Delete menu */}
              {(comment.can_edit || comment.can_delete) && !isEditing && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowMenu(!showMenu)}
                    aria-label={t('commentOptions')}
                    className="p-1 rounded-full text-gray-400 hover:text-gray-200 hover:bg-[#333] transition"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>

                  {showMenu && (
                    <div className="absolute right-0 top-6 z-20 min-w-[120px] rounded-xl bg-[#222] border border-[#333] py-1 shadow-2xl text-xs">
                      {comment.can_edit && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsEditing(true);
                            setShowMenu(false);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-gray-200 hover:bg-[#333]"
                        >
                          <Edit2 className="h-3.5 w-3.5 text-blue-400" />
                          <span>{t('edit')}</span>
                        </button>
                      )}
                      {comment.can_delete && (
                        <button
                          type="button"
                          onClick={handleDelete}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-red-400 hover:bg-[#333]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>{t('delete')}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Comment Body or Inline Editor */}
            {isEditing ? (
              <div className="mt-2">
                <CommentComposer
                  initialValue={comment.body}
                  submitLabel={t('save')}
                  autoFocus
                  onCancel={() => setIsEditing(false)}
                  onSubmit={handleEditSubmit}
                />
              </div>
            ) : (
              <p className="mt-1 text-xs text-gray-800 dark:text-gray-200 whitespace-pre-line break-words leading-relaxed">
                {comment.body}
              </p>
            )}

            {/* Actions: Reply trigger button */}
            {!isEditing && (
              <div className="flex items-center gap-4 mt-2">
                <button
                  type="button"
                  onClick={handleReplyClick}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-white transition"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span>{t('reply')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reply Composer */}
      {!isDeleted && showReplyComposer && (
        <div className="ml-10 mt-2 pl-3 border-l-2 border-red-600/40">
          <CommentComposer
            isReply
            autoFocus
            onCancel={() => setShowReplyComposer(false)}
            onSubmit={handleReplySubmit}
          />
        </div>
      )}

      {/* Replies Thread (Only for top-level comments with reply_count > 0 or existing replies) */}
      {isTopLevel && (comment.reply_count > 0 || replies.length > 0) && (
        <div className="ml-10 mt-1">
          <button
            type="button"
            onClick={toggleReplies}
            className="flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-400 transition py-1"
          >
            {showReplies ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                <span>{t('hideReplies')}</span>
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                <span>
                  {t('showReplies', { count: Math.max(comment.reply_count, replies.length) })}
                </span>
              </>
            )}
          </button>

          {/* Expanded Replies list */}
          {showReplies && (
            <div className="flex flex-col gap-2 mt-2 pl-3 border-l-2 border-[#2b2b2b]">
              {replies.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  topLevelParentId={comment.id}
                  onCommentUpdated={(updated) => {
                    setReplies((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
                  }}
                  onCommentDeleted={(delId) => {
                    setReplies((prev) =>
                      prev.map((r) => (r.id === delId ? { ...r, status: 'DELETED', body: '' } : r)),
                    );
                  }}
                  onReplyCreated={(newReply) => {
                    setReplies((prev) => [...prev, newReply]);
                  }}
                />
              ))}

              {/* Load more replies button */}
              {repliesCursor && (
                <button
                  type="button"
                  disabled={isLoadingReplies}
                  onClick={() => loadReplies(repliesCursor)}
                  className="self-start text-xs font-medium text-gray-400 hover:text-white transition py-1"
                >
                  {isLoadingReplies ? t('loading') : t('loadMoreReplies')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
