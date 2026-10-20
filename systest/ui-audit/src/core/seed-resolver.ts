// systest/ui-audit/src/core/seed-resolver.ts
import fs from 'node:fs';
import path from 'node:path';
import { SeedContext } from '../types.js';

export function loadSeedManifest(): SeedContext {
  const manifestPath = path.resolve(process.cwd(), 'systest/.run/seed-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const data = JSON.parse(content);
      return {
        categorySlug: data.categorySlug || (data.categories && data.categories[0]?.slug) || 'dien-anh',
        tagSlug: data.tagSlug || (data.tags && data.tags[0]?.slug) || 'phim-ngan',
        videoId: data.videoId || (data.videos && data.videos[0]?.id) || '018f0000-0000-7000-8000-000000000001',
        channelHandle: data.channelHandle || (data.channels && data.channels[0]?.handle) || 'sim_curator',
        playlistId: data.playlistId || (data.playlists && data.playlists[0]?.id) || '018f0000-0000-7000-8000-000000000002',
      };
    }
  } catch {
    // Ignore and fallback
  }

  return {
    categorySlug: 'dien-anh',
    tagSlug: 'phim-ngan',
    videoId: '018f0000-0000-7000-8000-000000000001',
    channelHandle: 'sim_curator',
    playlistId: '018f0000-0000-7000-8000-000000000002',
  };
}

export function resolveRoute(routeTemplate: string, seed: SeedContext): string {
  if (!routeTemplate.includes(':seed')) {
    return routeTemplate;
  }

  if (routeTemplate.includes('/the-loai/')) {
    return routeTemplate.replace(':seed', seed.categorySlug);
  }
  if (routeTemplate.includes('/tag/')) {
    return routeTemplate.replace(':seed', seed.tagSlug);
  }
  if (routeTemplate.includes('/c/')) {
    return routeTemplate.replace(':seed', seed.channelHandle);
  }
  if (routeTemplate.includes('/playlist/')) {
    return routeTemplate.replace(':seed', seed.playlistId);
  }

  // Default to videoId for /watch/:seed, /embed/:seed, etc.
  return routeTemplate.replace(':seed', seed.videoId);
}
