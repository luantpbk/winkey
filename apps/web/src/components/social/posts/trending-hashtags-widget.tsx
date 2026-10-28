'use client';

import React, { useEffect, useState } from 'react';
import { TrendingUp, Hash, Loader2 } from 'lucide-react';
import type { TrendingHashtag } from '@winkey/api-client';
import { api } from '../../../lib/api-client';
import { Link } from '../../../i18n/routing';
import { A11Y_COLORS } from '../../../lib/a11y-tokens';

export interface TrendingHashtagsWidgetProps {
  limit?: number;
  className?: string;
}

export function TrendingHashtagsWidget({
  limit = 10,
  className = '',
}: TrendingHashtagsWidgetProps) {
  const [hashtags, setHashtags] = useState<TrendingHashtag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function loadTrending() {
      setLoading(true);
      setError(false);
      try {
        const res = await api.social.GET('/v1/hashtags/trending', {
          params: { query: { limit } },
        });
        if (mounted) {
          if (res.response.ok && res.data?.items) {
            setHashtags(res.data.items);
          } else {
            setError(true);
          }
        }
      } catch {
        if (mounted) setError(true);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadTrending();
    return () => {
      mounted = false;
    };
  }, [limit]);

  return (
    <div
      data-testid="trending-hashtags-widget"
      className={`rounded-2xl border border-zinc-200 dark:border-zinc-800/80 bg-white/70 dark:bg-zinc-900/60 p-4 backdrop-blur-md shadow-sm ${className}`}
    >
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-zinc-200 dark:border-zinc-800">
        <TrendingUp className="w-4 h-4 text-red-500" />
        <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Chủ đề thịnh hành</h2>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-zinc-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : error ? (
        <p className="text-xs text-zinc-400 py-3 text-center">Không thể tải chủ đề thịnh hành.</p>
      ) : hashtags.length === 0 ? (
        <p className="text-xs text-zinc-400 py-3 text-center">Chưa có chủ đề nổi bật hôm nay.</p>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800/50">
          {hashtags.map((item, index) => (
            <Link
              key={item.slug}
              href={`/hashtag/${item.slug}`}
              data-testid={`trending-hashtag-item-${item.slug}`}
              className="group flex items-center justify-between py-2.5 px-1 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 rounded-lg transition"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-zinc-400 w-4 text-center">
                  {index + 1}
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 group-hover:text-red-500 transition truncate">
                    #{item.tag}
                  </span>
                  <span className={`text-[11px] ${A11Y_COLORS.textMuted}`}>
                    {item.post_count.toLocaleString('vi-VN')} bài viết
                  </span>
                </div>
              </div>
              <Hash className="w-3.5 h-3.5 text-zinc-400 group-hover:text-red-500 transition shrink-0 opacity-60 group-hover:opacity-100" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
