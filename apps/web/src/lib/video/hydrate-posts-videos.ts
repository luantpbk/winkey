import type { VideoSummary } from '@winkey/api-client';
import { api } from '../api-client';

export type HydratedPostVideo = VideoSummary & {
  purpose?: 'FILM' | 'SOCIAL';
  playback?: {
    hls_url: string;
    thumbnail_url: string;
    renditions?: any[];
  } | null;
  width?: number | null;
  height?: number | null;
};

/**
 * Hydrates embedded Winkey video summaries for a list of video IDs using ONE batchGetVideos call.
 * Silently drops any unreadable/missing videos (ADR-024, ADR-049, SOC-2b).
 */
export async function hydrateVideosForPosts(
  videoIds: (string | null | undefined)[],
): Promise<Map<string, HydratedPostVideo>> {
  const uniqueIds = Array.from(new Set(videoIds.filter((id): id is string => Boolean(id)))).slice(
    0,
    50,
  );

  const videoMap = new Map<string, HydratedPostVideo>();
  if (uniqueIds.length === 0) return videoMap;

  try {
    const res = await api.video.GET('/v1/videos/batch', {
      params: { query: { ids: uniqueIds } },
      querySerializer: { array: { style: 'form', explode: false } },
    });
    if (res.data?.items) {
      for (const v of res.data.items) {
        videoMap.set(v.id, v as HydratedPostVideo);
      }
    }
  } catch {
    // Ignore error and return partial/empty map
  }

  return videoMap;
}
