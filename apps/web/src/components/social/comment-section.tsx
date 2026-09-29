'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { Comment, Problem } from '@winkey/api-client';
import { CommentComposer } from './comment-composer';
import { CommentItem } from './comment-item';
import { api } from '../../lib/api-client';

export interface CommentSectionProps {
  videoId: string;
}

export function CommentSection({ videoId }: CommentSectionProps) {
  const t = useTranslations('social');

  const [comments, setComments] = useState<Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const fetchComments = useCallback(
    async (cursor?: string | null, isInitial = false) => {
      if (isInitial) setIsLoading(true);
      else setIsLoadingMore(true);
      setErrorNotice(null);

      try {
        const { data, response } = await api.social.GET('/v1/videos/{video_id}/comments', {
          params: {
            path: { video_id: videoId },
            query: { cursor: cursor || undefined, limit: 15 },
          },
        });

        if (response.ok && data) {
          if (cursor) {
            setComments((prev) => [...prev, ...data.items]);
          } else {
            setComments(data.items);
          }
          setNextCursor(data.next_cursor);
        } else {
          setErrorNotice('Không thể tải bình luận. Vui lòng tải lại trang.');
        }
      } catch {
        setErrorNotice('Lỗi mạng khi tải bình luận.');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [videoId],
  );

  useEffect(() => {
    fetchComments(null, true);
  }, [fetchComments]);

  const handleCreateTopLevelComment = async (text: string) => {
    // Optimistic temporary comment
    const tempId = `optimistic-${Date.now()}`;
    const optimisticComment: Comment = {
      id: tempId,
      video_id: videoId,
      parent_id: null,
      author: null, // Will be filled from response or current profile
      body: text,
      status: 'VISIBLE',
      reply_count: 0,
      created_at: new Date().toISOString(),
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };

    // Optimistically insert at top of comments list
    setComments((prev) => [optimisticComment, ...prev]);

    try {
      const { data, error, response } = await api.social.POST('/v1/videos/{video_id}/comments', {
        params: { path: { video_id: videoId } },
        body: { body: text },
      });

      if (response.ok && data) {
        // Replace optimistic comment with real server response
        setComments((prev) => prev.map((c) => (c.id === tempId ? data : c)));
        // Refetch the first page as specified in brief
        void fetchComments(null, false);
        return { success: true };
      }

      // Rollback optimistic comment on failure
      setComments((prev) => prev.filter((c) => c.id !== tempId));

      const problem = error as Problem | undefined;
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || '30';
        return {
          success: false,
          error: t('rateLimited', { seconds: retryAfter }),
        };
      }

      return {
        success: false,
        error: problem?.detail || problem?.title || 'Không thể đăng bình luận',
      };
    } catch (err: unknown) {
      // Rollback on network failure
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Lỗi kết nối khi gửi bình luận',
      };
    }
  };

  return (
    <section aria-label={t('comments')} className="flex flex-col gap-5 mt-4">
      {/* Header with count */}
      <div className="flex items-center gap-3">
        <h2 className="text-base sm:text-lg font-bold text-gray-900 dark:text-white">
          {t('commentsCount', { count: comments.length })}
        </h2>
      </div>

      {/* Top-level comment composer */}
      <CommentComposer onSubmit={handleCreateTopLevelComment} />

      {/* Error alert notice */}
      {errorNotice && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500">
          {errorNotice}
        </div>
      )}

      {/* Loading state skeleton */}
      {isLoading ? (
        <div className="flex flex-col gap-4 py-4 animate-pulse">
          <div className="h-10 w-full bg-gray-200 dark:bg-zinc-800 rounded-xl" />
          <div className="h-10 w-full bg-gray-200 dark:bg-zinc-800 rounded-xl" />
          <div className="h-10 w-3/4 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
        </div>
      ) : (
        /* Comments list */
        <div className="flex flex-col gap-1">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              onCommentUpdated={(updated) => {
                setComments((prev) =>
                  prev.map((item) => (item.id === updated.id ? updated : item)),
                );
              }}
              onCommentDeleted={(delId) => {
                setComments((prev) =>
                  prev.map((item) =>
                    item.id === delId ? { ...item, status: 'DELETED', body: '' } : item,
                  ),
                );
              }}
              onReplyCreated={() => {
                // If a reply was created under this top-level comment, increment reply_count
                setComments((prev) =>
                  prev.map((item) =>
                    item.id === c.id ? { ...item, reply_count: item.reply_count + 1 } : item,
                  ),
                );
              }}
            />
          ))}

          {/* Load more comments */}
          {nextCursor && (
            <div className="flex justify-center mt-3">
              <button
                type="button"
                disabled={isLoadingMore}
                onClick={() => fetchComments(nextCursor, false)}
                className="rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 hover:bg-[#383838] px-5 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 transition"
              >
                {isLoadingMore ? t('loading') : t('loadMoreComments')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
