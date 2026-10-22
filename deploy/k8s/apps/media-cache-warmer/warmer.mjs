#!/usr/bin/env node
/**
 * Media Cache Warmer (Winkey Edge Cache Pre-warming Job)
 *
 * Runs as a Kubernetes CronJob every 15 minutes to pre-populate Nginx proxy_cache:
 * - Start of video: master + variant playlists + init segments + first 15 segments (~60s)
 * - Hot videos (top 20 trending over 7 days): full 720p + default audio
 * - Idempotency: HTTP HEAD seg_00000.m4s -> X-Cache-Status: HIT => skip
 * - QoS: concurrency <= 4, rate limit <= 5 MB/s
 * - Disk Guard: Aborts if cache disk usage exceeds 80% of max_size (32GB / 40GB)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Configuration
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || 'https://media.winkey.vn').replace(/\/+$/, '');
const API_BASE_URL = (process.env.API_BASE_URL || 'https://winkey.vn').replace(/\/+$/, '');
const CACHE_DIR = process.env.CACHE_DIR || '/nginx-cache';
const MAX_CACHE_BYTES = Number(process.env.MAX_CACHE_BYTES) || 40 * 1024 * 1024 * 1024; // 40GB
const MAX_CONCURRENCY = Math.min(Number(process.env.MAX_CONCURRENCY) || 4, 8);
const RATE_LIMIT_BPS = Number(process.env.RATE_LIMIT_BPS) || 5 * 1024 * 1024; // 5 MB/s
const WARM_SEGMENTS_COUNT = Number(process.env.WARM_SEGMENTS_COUNT) || 15; // ~60s
const HOT_VIDEOS_LIMIT = Number(process.env.HOT_VIDEOS_LIMIT) || 20;
const NEW_VIDEOS_HOURS = Number(process.env.NEW_VIDEOS_HOURS) || 24;
const MEDIA_LINK_SECRET = process.env.MEDIA_LINK_SECRET || '';

const USER_AGENT = 'WinkeyCacheWarmer/1.0 (+https://winkey.vn)';

// Metrics
const stats = {
  startTime: Date.now(),
  videosScanned: 0,
  videosSkipped: 0,
  videosWarmed: 0,
  filesDownloaded: 0,
  bytesTransferred: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Check cache disk usage to prevent exhausting edge SSD.
 * Aborts if usage > 80% of max_size.
 */
function checkDiskGuard() {
  let usedBytes = 0;
  let totalBytes = MAX_CACHE_BYTES;

  if (fs.existsSync(CACHE_DIR)) {
    try {
      // 1. Check filesystem statfs
      const statFs = fs.statfsSync(CACHE_DIR);
      const fsTotal = statFs.blocks * statFs.bsize;
      const fsFree = statFs.bavail * statFs.bsize;
      const fsUsed = fsTotal - fsFree;
      const fsPercent = (fsUsed / fsTotal) * 100;
      if (fsPercent >= 85) {
        console.warn(`[DISK GUARD] Filesystem usage at ${fsPercent.toFixed(1)}% (>=85%). Aborting warm.`);
        return false;
      }
    } catch (_) {}

    try {
      // 2. Measure actual cache directory bytes
      function scanDir(current) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            usedBytes += fs.statSync(fullPath).size;
          }
        }
      }
      scanDir(CACHE_DIR);
    } catch (err) {
      console.warn(`[DISK GUARD] Could not scan directory ${CACHE_DIR}: ${err.message}`);
    }
  }

  const thresholdBytes = MAX_CACHE_BYTES * 0.8; // 80% (32GB)
  const percentOfMax = (usedBytes / MAX_CACHE_BYTES) * 100;

  console.log(
    `[DISK GUARD] Current cache usage: ${formatBytes(usedBytes)} / ${formatBytes(MAX_CACHE_BYTES)} (${percentOfMax.toFixed(1)}%, limit: 80.0%)`
  );

  if (usedBytes >= thresholdBytes) {
    console.warn(`[DISK GUARD] Cache directory usage ${formatBytes(usedBytes)} exceeds 80% threshold. Aborting warm.`);
    return false;
  }
  return true;
}

/**
 * Sign URL if secret is provided (SEC1-b / ADR-017)
 */
function signMediaUrl(vid, targetPath, secret, expireSeconds = 86400) {
  if (!secret) return targetPath;
  const exp = Math.floor(Date.now() / 1000) + expireSeconds;
  // Format: $exp/v/$vid/ $media_link_secret
  const hash = crypto
    .createHash('md5')
    .update(`${exp}/v/${vid}/ ${secret}`)
    .digest('base64url');
  return `/s/${exp}/${hash}/${targetPath.replace(/^\/+/, '')}`;
}

/**
 * Rate-limited fetch of a media resource.
 * Streams body to dev/null and enforces maximum bytes/sec.
 */
async function fetchMediaWithRateLimit(url) {
  const start = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  const cacheStatus = res.headers.get('x-cache-status') || 'UNKNOWN';
  if (cacheStatus === 'HIT') {
    stats.cacheHits++;
  } else {
    stats.cacheMisses++;
  }

  let bytes = 0;
  if (res.body) {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;

      // Rate limit enforcement (leaky-bucket pacing)
      const elapsedSec = (Date.now() - start) / 1000;
      const expectedSec = bytes / RATE_LIMIT_BPS;
      if (expectedSec > elapsedSec) {
        const delayMs = (expectedSec - elapsedSec) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  stats.filesDownloaded++;
  stats.bytesTransferred += bytes;
  return { bytes, cacheStatus, durationMs: Date.now() - start };
}

/**
 * Idempotency check: send HEAD request to check if segment 0 is cached.
 */
async function isVideoStartCached(testUrl) {
  try {
    const res = await fetch(testUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
    });
    return res.headers.get('x-cache-status') === 'HIT';
  } catch (_) {
    return false;
  }
}

/**
 * Parse an HLS playlist (master or rendition index) and extract child URLs.
 */
function parseM3u8(content, baseUrl) {
  const lines = content.split('\n').map((l) => l.trim());
  const variants = [];
  const segments = [];
  let initUri = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:') || line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      // Audio or video rendition
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        variants.push(new URL(uriMatch[1], baseUrl).href);
      } else if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        variants.push(new URL(lines[i + 1], baseUrl).href);
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const mapMatch = line.match(/URI="([^"]+)"/);
      if (mapMatch) {
        initUri = new URL(mapMatch[1], baseUrl).href;
      }
    } else if (line.startsWith('#EXTINF:')) {
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        segments.push(new URL(lines[i + 1], baseUrl).href);
      }
    }
  }

  return { variants, segments, initUri };
}

/**
 * Concurrency worker pool (max concurrent workers <= MAX_CONCURRENCY).
 */
async function runConcurrent(items, concurrency, taskFn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      try {
        await taskFn(current);
      } catch (err) {
        stats.errors++;
        console.warn(`[WARMER] Error downloading ${current}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Warm a single video.
 */
async function warmVideo(video, isHot) {
  console.log(`\n--> [VIDEO ${video.id}] "${video.title}" (Hot: ${isHot})`);

  // 1. Fetch playback details from video API
  let playback;
  try {
    const res = await fetch(`${API_BASE_URL}/v1/videos/${video.id}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    playback = data.playback;
  } catch (err) {
    stats.errors++;
    console.error(`[WARMER] Failed to fetch video info for ${video.id}: ${err.message}`);
    return;
  }

  if (!playback || !playback.hls_url) {
    console.log(`[WARMER] Video ${video.id} has no ready HLS playback stream. Skipping.`);
    return;
  }

  // 2. Determine master playlist URLs (H.264 + AV1 if available)
  const masterUrls = [playback.hls_url];
  if (playback.hls_av1_url) {
    masterUrls.push(playback.hls_av1_url);
  }

  // 3. Idempotency Check: check if first segment is already in cache
  // Master playlist URL structure: .../v/{vid}/.../master.m3u8
  const testSegmentUrl = `${MEDIA_BASE_URL}/v/${video.id}/a2/hls/720p/seg_00000.m4s`;
  if (await isVideoStartCached(testSegmentUrl)) {
    console.log(`[IDEMPOTENT] Video ${video.id} start is already cached (HIT). Skipping.`);
    stats.videosSkipped++;
    return;
  }

  // 4. Check Disk Guard before processing
  if (!checkDiskGuard()) {
    console.warn(`[WARMER] Disk guard tripped. Halting warm operations.`);
    return 'STOP';
  }

  // 5. Download Master Playlists & parse variants
  const urlsToWarm = new Set();

  for (const masterUrl of masterUrls) {
    try {
      console.log(`  Downloading master: ${masterUrl}`);
      const masterRes = await fetch(masterUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!masterRes.ok) continue;
      const masterContent = await masterRes.text();
      const { variants } = parseM3u8(masterContent, masterUrl);

      // Add variant playlists
      for (const variantUrl of variants) {
        urlsToWarm.add(variantUrl);

        try {
          const varRes = await fetch(variantUrl, { headers: { 'User-Agent': USER_AGENT } });
          if (!varRes.ok) continue;
          const varContent = await varRes.text();
          const { segments, initUri } = parseM3u8(varContent, variantUrl);

          if (initUri) urlsToWarm.add(initUri);

          const is720pOrAudio = variantUrl.includes('720p') || variantUrl.includes('audio');
          if (isHot && is720pOrAudio) {
            // Full rendition for hot video
            segments.forEach((s) => urlsToWarm.add(s));
          } else {
            // First 15 segments (~60s) for start warming
            segments.slice(0, WARM_SEGMENTS_COUNT).forEach((s) => urlsToWarm.add(s));
          }
        } catch (e) {
          console.warn(`  Failed parsing variant ${variantUrl}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`  Failed fetching master ${masterUrl}: ${e.message}`);
    }
  }

  const urlList = Array.from(urlsToWarm);
  console.log(`  Queueing ${urlList.length} media assets for video ${video.id}...`);

  // 6. Download all queued assets with concurrency <= MAX_CONCURRENCY and rate limit
  await runConcurrent(urlList, MAX_CONCURRENCY, async (targetUrl) => {
    await fetchMediaWithRateLimit(targetUrl);
  });

  stats.videosWarmed++;
  console.log(`  ✓ Completed warming video ${video.id}.`);
}

/**
 * Main execution routine.
 */
async function main() {
  console.log(`=======================================================`);
  console.log(`Winkey Media Cache Warmer starting at ${new Date().toISOString()}`);
  console.log(`Media URL: ${MEDIA_BASE_URL} | Rate Limit: ${formatBytes(RATE_LIMIT_BPS)}/s | Concurrency: ${MAX_CONCURRENCY}`);
  console.log(`=======================================================`);

  // Check initial disk usage
  if (!checkDiskGuard()) {
    console.error(`[WARMER] Cache disk full prior to start. Exiting.`);
    process.exit(0);
  }

  // 1. Fetch Top 20 Hot / Trending Videos
  const hotVideoIds = new Set();
  try {
    const res = await fetch(`${API_BASE_URL}/v1/videos?limit=${HOT_VIDEOS_LIMIT}&sort=trending`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items)) {
        data.items.forEach((item) => hotVideoIds.add(item.id));
      }
    }
  } catch (err) {
    console.warn(`[WARMER] Warning: Could not fetch trending videos: ${err.message}`);
  }
  console.log(`[WARMER] Loaded ${hotVideoIds.size} hot/trending video candidates.`);

  // 2. Fetch New Videos (published in last 24h)
  const candidateVideos = new Map();
  try {
    const res = await fetch(`${API_BASE_URL}/v1/videos?limit=50&sort=newest`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) {
      const data = await res.json();
      const cutoff = Date.now() - NEW_VIDEOS_HOURS * 3600 * 1000;
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          const pubTime = new Date(item.published_at).getTime();
          if (pubTime >= cutoff || hotVideoIds.has(item.id)) {
            candidateVideos.set(item.id, item);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[WARMER] Error fetching newest videos: ${err.message}`);
  }

  console.log(`[WARMER] Found ${candidateVideos.size} candidate videos to evaluate.`);
  stats.videosScanned = candidateVideos.size;

  // 3. Process candidate videos sequentially
  for (const [vid, video] of candidateVideos.entries()) {
    const isHot = hotVideoIds.has(vid);
    const result = await warmVideo(video, isHot);
    if (result === 'STOP') {
      console.warn(`[WARMER] Stopped by disk guard.`);
      break;
    }
  }

  // 4. Summary Report
  const totalDurationSec = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const avgSpeed =
    stats.bytesTransferred > 0 && totalDurationSec > 0
      ? formatBytes(stats.bytesTransferred / totalDurationSec) + '/s'
      : '0 B/s';

  console.log(`\n================ CACHE WARMER RUN REPORT ================`);
  console.log(`Total duration:          ${totalDurationSec} s`);
  console.log(`Videos scanned:          ${stats.videosScanned}`);
  console.log(`Videos skipped (HIT):    ${stats.videosSkipped}`);
  console.log(`Videos warmed:           ${stats.videosWarmed}`);
  console.log(`Files downloaded:        ${stats.filesDownloaded}`);
  console.log(`Total transferred:       ${formatBytes(stats.bytesTransferred)}`);
  console.log(`Average throughput:      ${avgSpeed}`);
  console.log(`Cache MISS / HIT ratio:  ${stats.cacheMisses} MISS / ${stats.cacheHits} HIT`);
  console.log(`Errors encountered:      ${stats.errors}`);
  console.log(`=========================================================`);

  // Final disk check log
  checkDiskGuard();
}

main().catch((err) => {
  console.error(`[FATAL] Cache Warmer crashed:`, err);
  process.exit(1);
});
