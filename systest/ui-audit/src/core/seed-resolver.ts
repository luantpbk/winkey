// systest/ui-audit/src/core/seed-resolver.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeedContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadSeedManifest(): SeedContext {
  const candidatePaths = [
    path.resolve(process.cwd(), 'systest/.run/seed-manifest.json'),
    path.resolve(process.cwd(), '.run/seed-manifest.json'),
    path.resolve(__dirname, '../../../../systest/.run/seed-manifest.json'),
    path.resolve(__dirname, '../../../.run/seed-manifest.json'),
    path.resolve(__dirname, '../../.run/seed-manifest.json'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, 'utf-8');
        const data = JSON.parse(content);
        return {
          categorySlug:
            data.categorySlug ||
            (data.categories && data.categories[0]?.slug) ||
            'phim',
          tagSlug:
            data.tagSlug ||
            (data.videos && data.videos[0]?.tags && data.videos[0].tags[0]) ||
            'kham-pha',
          videoId:
            data.videoId ||
            (data.videos && data.videos[0]?.id) ||
            '01a1590b-caf1-7b7c-a503-ba02ce0730e2',
          channelHandle:
            data.channelHandle ||
            data.curator?.handle ||
            (data.channels && data.channels[0]?.handle) ||
            'sim_curator',
          playlistId:
            data.playlistId ||
            (data.playlists && data.playlists[0]?.id) ||
            '01a1590b-ca93-785c-8979-56d1f974cb38',
        };
      } catch (err) {
        console.warn(`[seed-resolver] Failed parsing seed-manifest at ${candidate}:`, err);
      }
    }
  }

  return {
    categorySlug: 'phim',
    tagSlug: 'kham-pha',
    videoId: '01a1590b-caf1-7b7c-a503-ba02ce0730e2',
    channelHandle: 'sim_curator',
    playlistId: '01a1590b-ca93-785c-8979-56d1f974cb38',
  };
}

export function resolveRoute(routeTemplate: string, seed?: SeedContext): string {
  if (!routeTemplate.includes(':seed')) {
    return routeTemplate;
  }
  const s = seed || loadSeedManifest();

  if (routeTemplate.includes('/the-loai/')) {
    return routeTemplate.replace(':seed', s.categorySlug);
  }
  if (routeTemplate.includes('/tag/')) {
    return routeTemplate.replace(':seed', s.tagSlug);
  }
  if (routeTemplate.includes('/c/')) {
    return routeTemplate.replace(':seed', s.channelHandle);
  }
  if (routeTemplate.includes('/playlist/')) {
    return routeTemplate.replace(':seed', s.playlistId);
  }

  // Default to videoId for /watch/:seed, /embed/:seed, etc.
  return routeTemplate.replace(':seed', s.videoId);
}
