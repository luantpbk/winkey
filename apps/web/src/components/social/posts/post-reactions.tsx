'use client';

import React, { useState, useRef, useEffect } from 'react';
import type { ReactionKind, ReactionCount, ReactionItem } from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { ThumbsUp, X } from 'lucide-react';
import { Link } from '../../../i18n/routing';
import { formatCompactNumber } from '../../../lib/format';

export const REACTION_CONFIG: Record<
  ReactionKind,
  { label: string; emoji: string; color: string; activeColor: string }
> = {
  LIKE: { label: 'Thích', emoji: '👍', color: 'text-blue-500', activeColor: 'text-blue-500' },
  LOVE: { label: 'Yêu thích', emoji: '❤️', color: 'text-red-500', activeColor: 'text-red-500' },
  HAHA: { label: 'Haha', emoji: '😆', color: 'text-amber-500', activeColor: 'text-amber-500' },
  WOW: { label: 'Wow', emoji: '😮', color: 'text-amber-500', activeColor: 'text-amber-500' },
  SAD: { label: 'Buồn', emoji: '😢', color: 'text-amber-500', activeColor: 'text-amber-500' },
  ANGRY: {
    label: 'Phẫn nộ',
    emoji: '😡',
    color: 'text-orange-600',
    activeColor: 'text-orange-600',
  },
};

export interface PostReactionsProps {
  postId: string;
  initialMyReaction: ReactionKind | null;
  initialReactionCount: number;
  initialTopReactions: ReactionCount[];
  isAuthenticated?: boolean;
  onRequireAuth?: () => void;
}

export function PostReactions({
  postId,
  initialMyReaction,
  initialReactionCount,
  initialTopReactions,
  isAuthenticated = false,
  onRequireAuth,
}: PostReactionsProps) {
  const [myReaction, setMyReaction] = useState<ReactionKind | null>(initialMyReaction);
  const [reactionCount, setReactionCount] = useState<number>(initialReactionCount);
  const [topReactions, setTopReactions] = useState<ReactionCount[]>(initialTopReactions);
  const [showPicker, setShowPicker] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [dialogTab, setDialogTab] = useState<'ALL' | ReactionKind>('ALL');
  const [reactionsList, setReactionsList] = useState<ReactionItem[]>([]);
  const [isLoadingReactions, setIsLoadingReactions] = useState(false);

  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    if (showPicker) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [showPicker]);

  const handleMouseEnter = () => {
    hoverTimerRef.current = setTimeout(() => {
      setShowPicker(true);
    }, 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
  };

  const executeSetReaction = async (kind: ReactionKind) => {
    if (!isAuthenticated) {
      onRequireAuth?.();
      return;
    }

    setShowPicker(false);

    // Save previous state for rollback
    const prevReaction = myReaction;
    const prevCount = reactionCount;
    const prevTop = [...topReactions];

    // Optimistic update
    const isNew = prevReaction === null;
    const newCount = isNew ? prevCount + 1 : prevCount;
    setMyReaction(kind);
    setReactionCount(newCount);

    try {
      const { data, response } = await api.social.PUT('/v1/posts/{post_id}/reaction', {
        params: { path: { post_id: postId } },
        body: { reaction: kind },
      });

      if (response.ok && data) {
        setMyReaction(data.my_reaction);
        setReactionCount(data.reaction_count);
        setTopReactions(data.top_reactions || []);
      } else {
        // Rollback
        setMyReaction(prevReaction);
        setReactionCount(prevCount);
        setTopReactions(prevTop);
      }
    } catch {
      // Rollback
      setMyReaction(prevReaction);
      setReactionCount(prevCount);
      setTopReactions(prevTop);
    }
  };

  const executeRemoveReaction = async () => {
    if (!isAuthenticated || myReaction === null) return;

    setShowPicker(false);

    const prevReaction = myReaction;
    const prevCount = reactionCount;
    const prevTop = [...topReactions];

    // Optimistic remove
    setMyReaction(null);
    setReactionCount(Math.max(0, prevCount - 1));

    try {
      const { data, response } = await api.social.DELETE('/v1/posts/{post_id}/reaction', {
        params: { path: { post_id: postId } },
      });

      if (response.ok && data) {
        setMyReaction(data.my_reaction);
        setReactionCount(data.reaction_count);
        setTopReactions(data.top_reactions || []);
      } else {
        // Rollback
        setMyReaction(prevReaction);
        setReactionCount(prevCount);
        setTopReactions(prevTop);
      }
    } catch {
      // Rollback
      setMyReaction(prevReaction);
      setReactionCount(prevCount);
      setTopReactions(prevTop);
    }
  };

  const handleMainButtonClick = () => {
    if (!isAuthenticated) {
      onRequireAuth?.();
      return;
    }
    if (myReaction) {
      executeRemoveReaction();
    } else {
      executeSetReaction('LIKE');
    }
  };

  const openReactionsDialog = async () => {
    setShowDialog(true);
    fetchReactionsForTab(dialogTab);
  };

  const fetchReactionsForTab = async (tab: 'ALL' | ReactionKind) => {
    setIsLoadingReactions(true);
    try {
      const query: { limit: number; reaction?: ReactionKind } = { limit: 50 };
      if (tab !== 'ALL') {
        query.reaction = tab;
      }
      const { data, response } = await api.social.GET('/v1/posts/{post_id}/reactions', {
        params: {
          path: { post_id: postId },
          query,
        },
      });

      if (response.ok && data) {
        setReactionsList(data.items || []);
      }
    } catch {
      setReactionsList([]);
    } finally {
      setIsLoadingReactions(false);
    }
  };

  const handleTabChange = (tab: 'ALL' | ReactionKind) => {
    setDialogTab(tab);
    fetchReactionsForTab(tab);
  };

  const activeConfig = myReaction ? REACTION_CONFIG[myReaction] : null;

  return (
    <div className="flex items-center justify-between pt-3 border-t border-zinc-100 dark:border-zinc-800/80 text-xs text-zinc-500 dark:text-zinc-400">
      {/* Top reactions summary */}
      <div className="flex items-center gap-1.5">
        {reactionCount > 0 && (
          <button
            type="button"
            onClick={openReactionsDialog}
            className="flex items-center gap-1 hover:underline focus:outline-none"
            aria-label={`${reactionCount} lượt bày tỏ cảm xúc`}
          >
            <div className="flex -space-x-1 items-center">
              {topReactions.slice(0, 3).map((item) => (
                <span
                  key={item.reaction}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs shadow-sm ring-1 ring-zinc-900"
                >
                  {REACTION_CONFIG[item.reaction]?.emoji || '👍'}
                </span>
              ))}
            </div>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300 ml-1">
              {formatCompactNumber(reactionCount)}
            </span>
          </button>
        )}
      </div>

      {/* Reaction trigger with popover */}
      <div
        className="relative"
        ref={pickerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Reaction picker popover */}
        {showPicker && (
          <div
            role="toolbar"
            aria-label="Chọn cảm xúc"
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-1.5 bg-white dark:bg-zinc-800 rounded-full shadow-2xl border border-zinc-200 dark:border-zinc-700 flex items-center gap-1 z-30 animate-in fade-in zoom-in-95 duration-150"
          >
            {(Object.keys(REACTION_CONFIG) as ReactionKind[]).map((kind) => {
              const cfg = REACTION_CONFIG[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => executeSetReaction(kind)}
                  className="w-9 h-9 flex items-center justify-center text-xl rounded-full hover:scale-125 transition-transform duration-150 focus:outline-none focus:ring-2 focus:ring-red-500"
                  aria-label={cfg.label}
                  title={cfg.label}
                >
                  <span>{cfg.emoji}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Main button */}
        <button
          type="button"
          onClick={handleMainButtonClick}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors font-medium ${
            activeConfig ? activeConfig.activeColor : 'text-zinc-600 dark:text-zinc-400'
          }`}
          aria-label={activeConfig ? `Bỏ bày tỏ cảm xúc ${activeConfig.label}` : 'Thích bài viết'}
        >
          {activeConfig ? (
            <span className="text-base">{activeConfig.emoji}</span>
          ) : (
            <ThumbsUp className="w-4 h-4" />
          )}
          <span>{activeConfig ? activeConfig.label : 'Thích'}</span>
        </button>
      </div>

      {/* Reactions Dialog */}
      {showDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reactions-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setShowDialog(false)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-100 dark:border-zinc-800">
              <h3
                id="reactions-dialog-title"
                className="text-base font-bold text-zinc-900 dark:text-zinc-100"
              >
                Người đã bày tỏ cảm xúc ({reactionCount})
              </h3>
              <button
                type="button"
                onClick={() => setShowDialog(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-white transition-colors"
                aria-label="Đóng"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Kind tabs */}
            <div className="flex border-b border-zinc-100 dark:border-zinc-800 px-3 overflow-x-auto no-scrollbar gap-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => handleTabChange('ALL')}
                className={`py-2.5 px-3 border-b-2 transition-colors shrink-0 ${
                  dialogTab === 'ALL'
                    ? 'border-red-500 text-red-500 font-bold'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                Tất cả ({reactionCount})
              </button>
              {topReactions.map((item) => (
                <button
                  key={item.reaction}
                  type="button"
                  onClick={() => handleTabChange(item.reaction)}
                  className={`py-2.5 px-2.5 border-b-2 transition-colors shrink-0 flex items-center gap-1 ${
                    dialogTab === item.reaction
                      ? 'border-red-500 text-red-500 font-bold'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  <span>{REACTION_CONFIG[item.reaction]?.emoji}</span>
                  <span>{item.count}</span>
                </button>
              ))}
            </div>

            {/* List */}
            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              {isLoadingReactions ? (
                <div className="py-8 text-center text-xs text-zinc-500 flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
                  <span>Đang tải...</span>
                </div>
              ) : reactionsList.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">
                  Chưa có ai bày tỏ cảm xúc ở mục này.
                </div>
              ) : (
                reactionsList.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <Link
                      href={`/@${item.user.handle}`}
                      className="flex items-center gap-3 group"
                      onClick={() => setShowDialog(false)}
                    >
                      {item.user.avatar_url ? (
                        <img
                          src={item.user.avatar_url}
                          alt={item.user.display_name}
                          className="w-10 h-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-red-600 text-white font-bold flex items-center justify-center">
                          {item.user.display_name?.charAt(0) || 'U'}
                        </div>
                      )}
                      <div>
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 group-hover:underline block">
                          {item.user.display_name}
                        </span>
                        <span className="text-xs text-zinc-500">@{item.user.handle}</span>
                      </div>
                    </Link>
                    <span className="text-lg" title={REACTION_CONFIG[item.reaction]?.label}>
                      {REACTION_CONFIG[item.reaction]?.emoji}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
