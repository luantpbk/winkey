'use client';

import React from 'react';
import type { VideoSummary } from '@winkey/api-client';
import type { HydratedPostVideo } from '../../../lib/video/hydrate-posts-videos';
import { Link } from '../../../i18n/routing';
import { Play, Eye } from 'lucide-react';
import { formatCompactNumber, formatDuration } from '../../../lib/format';
import { PostSocialVideoPlayer } from './post-social-player';

export interface PostVideoEmbedProps {
  video: HydratedPostVideo | null;
  videoId?: string;
}

export function PostVideoEmbed({ video, videoId }: PostVideoEmbedProps) {
  if (!video) return null;

  const targetId = video.id || videoId;
  if (!targetId) return null;

  // When purpose is SOCIAL, play inline with HLS player (SOC-2b, ADR-049)
  if (video.purpose === 'SOCIAL') {
    return <PostSocialVideoPlayer videoId={targetId} initialVideo={video} />;
  }

  // FILM stays a card linking to the watch page
  return (
    <div
      data-testid="post-film-embed"
      className="mt-3 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950"
    >
      <Link
        href={`/watch?v=${targetId}`}
        className="block group"
        aria-label={`Xem video: ${video.title}`}
      >
        <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
          {video.thumbnail_url ? (
            <img
              src={video.thumbnail_url}
              alt={video.title}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-600">
              <Play className="w-12 h-12" />
            </div>
          )}

          {/* Play button overlay */}
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-red-600/90 group-hover:bg-red-600 text-white flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
              <Play className="w-6 h-6 fill-current translate-x-0.5" />
            </div>
          </div>

          {/* Duration badge */}
          {typeof video.duration_ms === 'number' && video.duration_ms > 0 && (
            <span className="absolute bottom-2 right-2 px-2 py-0.5 text-xs font-semibold bg-black/80 text-white rounded-md">
              {formatDuration(video.duration_ms)}
            </span>
          )}
        </div>

        <div className="p-3.5 space-y-1 bg-zinc-900/40">
          <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 line-clamp-2 group-hover:text-red-500 transition-colors">
            {video.title}
          </h4>
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>{video.owner?.display_name || video.owner?.handle}</span>
            {typeof video.view_count === 'number' && (
              <>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Eye className="w-3.5 h-3.5" />
                  {formatCompactNumber(video.view_count)} lượt xem
                </span>
              </>
            )}
          </div>
        </div>
      </Link>
    </div>
  );
}
