import type { Video } from '@winkey/api-client';

export interface VideoObjectSchema {
  '@context': 'https://schema.org';
  '@type': 'VideoObject';
  name: string;
  description: string;
  thumbnailUrl: string[];
  uploadDate: string;
  duration: string;
  embedUrl: string;
  url: string;
  interactionStatistic: {
    '@type': 'InteractionCounter';
    interactionType: {
      '@type': 'WatchAction';
    };
    userInteractionCount: number;
  };
  author: {
    '@type': 'Person';
    name: string;
    url: string;
  };
}

export interface BreadcrumbListSchema {
  '@context': 'https://schema.org';
  '@type': 'BreadcrumbList';
  itemListElement: Array<{
    '@type': 'ListItem';
    position: number;
    name: string;
    item: string;
  }>;
}

/**
 * Converts milliseconds duration to ISO 8601 duration format (e.g. PT12M4S, PT1H2M3S, PT45S).
 */
export function msToIsoDuration(durationMs?: number | null): string {
  if (!durationMs || durationMs <= 0) return 'PT0S';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let res = 'PT';
  if (hours > 0) res += `${hours}H`;
  if (minutes > 0 || hours > 0) res += `${minutes}M`;
  res += `${seconds}S`;
  return res;
}

/**
 * Formats a clean meta description of approximately 155 characters.
 */
export function formatMetaDescription(description?: string | null): string {
  if (!description || !description.trim()) {
    return 'Xem video trực tuyến trên Winkey VN với chất lượng cao.';
  }
  const clean = description.replace(/\s+/g, ' ').trim();
  if (clean.length <= 155) return clean;
  return clean.slice(0, 152) + '...';
}

/**
 * Builds Schema.org VideoObject JSON-LD for a video.
 * Returns null if the video is UNLISTED or PRIVATE.
 */
export function buildVideoObjectSchema(
  video: Video,
  baseUrl = 'https://winkey.vn',
): VideoObjectSchema | null {
  if (video.visibility !== 'PUBLIC') {
    return null;
  }

  const thumbUrl = video.playback?.thumbnail_url || `${baseUrl}/og-default.jpg`;
  const watchUrl = `${baseUrl}/watch/${video.id}`;
  const channelUrl = `${baseUrl}/c/${video.owner.handle}`;
  const uploadDate = video.published_at || video.created_at;

  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description: video.description || video.title,
    thumbnailUrl: [thumbUrl],
    uploadDate,
    duration: msToIsoDuration(video.duration_ms),
    embedUrl: watchUrl,
    url: watchUrl,
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: {
        '@type': 'WatchAction',
      },
      userInteractionCount: video.view_count ?? 0,
    },
    author: {
      '@type': 'Person',
      name: video.owner.display_name,
      url: channelUrl,
    },
  };
}

/**
 * Builds Schema.org BreadcrumbList JSON-LD: Trang chủ › channel › video.
 * Returns null if the video is UNLISTED or PRIVATE.
 */
export function buildBreadcrumbListSchema(
  video: Video,
  baseUrl = 'https://winkey.vn',
): BreadcrumbListSchema | null {
  if (video.visibility !== 'PUBLIC') {
    return null;
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Trang chủ',
        item: baseUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: video.owner.display_name,
        item: `${baseUrl}/c/${video.owner.handle}`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: video.title,
        item: `${baseUrl}/watch/${video.id}`,
      },
    ],
  };
}
