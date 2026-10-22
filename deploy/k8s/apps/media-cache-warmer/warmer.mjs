#!/usr/bin/env node
/**
 * Media Cache Warmer (Winkey Edge Cache Pre-warming Job)
 *
 * Runs as a Kubernetes CronJob every 15 minutes to pre-populate Nginx proxy_cache:
 * - Start-of-video: H.264/AV1 master + variant playlists + init + first 15 segments (~60s)
 * - Hot trending videos (top 5 by views): full 720p + default audio (H.264 master only)
 * - Idempotency: Parse H.264 master -> first variant -> first segment -> GET check -> X-Cache-Status: HIT => skip
 * - Global rate limiter: Shared token bucket across all concurrent workers (<= 5 MB/s)
 * - Run budget: WARM_MAX_BYTES_PER_RUN (3 GiB)
 * - Hardened container: read-only filesystem, non-root user (1000), unprivileged
 */

// Configuration
function getMediaBaseUrl() {
  return (process.env.MEDIA_BASE_URL || 'https://media.winkey.vn').replace(/\/+$/, '');
}
function getApiBaseUrl() {
  return (process.env.API_BASE_URL || 'https://winkey.vn').replace(/\/+$/, '');
}
const MAX_CONCURRENCY = Math.min(Number(process.env.MAX_CONCURRENCY) || 4, 8);
const RATE_LIMIT_BPS = Number(process.env.RATE_LIMIT_BPS) || 5 * 1024 * 1024; // 5 MB/s
const WARM_SEGMENTS_COUNT = Number(process.env.WARM_SEGMENTS_COUNT) || 15; // ~60s
const WARM_MAX_BYTES_PER_RUN = Number(process.env.WARM_MAX_BYTES_PER_RUN) || 3 * 1024 * 1024 * 1024; // 3 GiB
const HOT_VIDEOS_LIMIT = Number(process.env.HOT_VIDEOS_LIMIT) || 20;
const HOT_FULL_LIMIT = Number(process.env.HOT_FULL_LIMIT) || 5; // top 5 trending get full 720p

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

function resetStats() {
  stats.startTime = Date.now();
  stats.videosScanned = 0;
  stats.videosSkipped = 0;
  stats.videosWarmed = 0;
  stats.filesDownloaded = 0;
  stats.bytesTransferred = 0;
  stats.cacheHits = 0;
  stats.cacheMisses = 0;
  stats.errors = 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Shared Token Bucket Rate Limiter
 * Enforces a global bytes/second budget across all concurrent workers.
 */
class GlobalRateLimiter {
  constructor(rateBytesPerSec) {
    this.rateBps = rateBytesPerSec;
    this.maxTokens = rateBytesPerSec; // burst budget: 1 second
    this.tokens = rateBytesPerSec;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs > 0) {
      const addedTokens = (elapsedMs * this.rateBps) / 1000;
      this.tokens = Math.min(this.maxTokens, this.tokens + addedTokens);
      this.lastRefill = now;
    }
  }

  async acquire(bytes) {
    while (true) {
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const needed = bytes - this.tokens;
      const waitMs = Math.ceil((needed / this.rateBps) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(waitMs, 500))));
    }
  }
}

const rateLimiter = new GlobalRateLimiter(RATE_LIMIT_BPS);

/**
 * Rate-limited fetch of a media resource.
 * Streams body to dev/null and meters through global token bucket.
 */
async function fetchMediaWithRateLimit(url) {
  const start = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
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
      const chunkSize = value.byteLength;
      bytes += chunkSize;
      stats.bytesTransferred += chunkSize;

      // Meter chunk through shared rate limiter
      await rateLimiter.acquire(chunkSize);
    }
  }

  stats.filesDownloaded++;
  return { bytes, cacheStatus, durationMs: Date.now() - start };
}

/**
 * Parse an HLS master playlist.
 * Distinguishes video variant playlists from audio rendition playlists.
 */
function parseMasterM3u8(content, baseUrl) {
  const lines = content.split('\n').map((l) => l.trim());
  const videoVariants = [];
  const audioVariants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        videoVariants.push(new URL(lines[i + 1], baseUrl).href);
      }
    } else if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        audioVariants.push(new URL(uriMatch[1], baseUrl).href);
      }
    }
  }

  return { videoVariants, audioVariants };
}

/**
 * Parse an HLS rendition playlist (video or audio) and extract init segment and media segments.
 */
function parseRenditionM3u8(content, baseUrl) {
  const lines = content.split('\n').map((l) => l.trim());
  const segments = [];
  let initUri = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MAP:')) {
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

  return { segments, initUri };
}

/**
 * Concurrency worker pool (max concurrent workers <= MAX_CONCURRENCY).
 */
async function runConcurrent(items, concurrency, taskFn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (index < items.length) {
      if (stats.bytesTransferred >= WARM_MAX_BYTES_PER_RUN) {
        break;
      }
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
 * Check idempotency:
 * 1. Fetch H.264 master playlist
 * 2. Select target variant:
 *    - For hot-full: 720p variant (fallback to first video variant)
 *    - For start-only: first video variant
 * 3. Extract test media segment URL:
 *    - For hot-full: LAST segment of 720p playlist
 *    - For start-only: FIRST segment of video playlist
 * 4. Perform plain GET request with User-Agent
 * 5. If X-Cache-Status is HIT -> return true (already cached)
 */
async function checkVideoCached(hlsUrl, isHotFull) {
  try {
    const masterRes = await fetch(hlsUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!masterRes.ok) return { cached: false };
    const masterContent = await masterRes.text();
    const { videoVariants } = parseMasterM3u8(masterContent, hlsUrl);
    if (videoVariants.length === 0) return { cached: false };

    let targetVariant = videoVariants[0];
    if (isHotFull) {
      const v720 = videoVariants.find((v) => v.includes('720p'));
      if (v720) targetVariant = v720;
    }

    const varRes = await fetch(targetVariant, { headers: { 'User-Agent': USER_AGENT } });
    if (!varRes.ok) return { cached: false };
    const varContent = await varRes.text();
    const { segments } = parseRenditionM3u8(varContent, targetVariant);
    if (segments.length === 0) return { cached: false };

    // Hot-full checks the LAST segment of 720p; start-only checks the FIRST segment
    const testSegmentUrl = isHotFull ? segments[segments.length - 1] : segments[0];

    // Plain GET request matching Nginx proxy_cache key "$scheme$request_method$host$uri"
    const segRes = await fetch(testSegmentUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      },
    });

    const cacheStatus = segRes.headers.get('x-cache-status') || 'MISS';

    // Consume body to free socket and allow Nginx to complete caching if MISS
    if (segRes.body) {
      const reader = segRes.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    return {
      cached: cacheStatus === 'HIT',
      testSegmentUrl,
      cacheStatus,
      isHotFull,
    };
  } catch (err) {
    console.warn(`[IDEMPOTENT] Failed checking cache status: ${err.message}`);
    return { cached: false };
  }
}

/**
 * Warm a single video.
 */
async function warmVideo(video, isHotFull) {
  console.log(`\n--> [VIDEO ${video.id}] "${video.title}" (Hot Full 720p: ${isHotFull})`);

  // 1. Fetch playback details from video API
  let playback;
  try {
    const res = await fetch(`${getApiBaseUrl()}/v1/videos/${video.id}`, {
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

  // 2. Idempotency Check: derive test segment from H.264 master and check via GET
  const cacheCheck = await checkVideoCached(playback.hls_url, isHotFull);
  if (cacheCheck.cached) {
    const label = isHotFull ? '720p last segment' : 'first segment';
    console.log(`[IDEMPOTENT] Video ${video.id} ${label} is already cached (HIT). Skipping.`);
    stats.videosSkipped++;
    stats.cacheHits++;
    return;
  }

  if (cacheCheck.cacheStatus === 'MISS') {
    stats.cacheMisses++;
    stats.filesDownloaded++;
  }

  // 3. Queue assets for warming
  const urlsToWarm = new Set();

  // A. H.264 Master and renditions
  try {
    console.log(`  Downloading H.264 master: ${playback.hls_url}`);
    const masterRes = await fetch(playback.hls_url, { headers: { 'User-Agent': USER_AGENT } });
    if (masterRes.ok) {
      urlsToWarm.add(playback.hls_url);
      const masterContent = await masterRes.text();
      const { videoVariants, audioVariants } = parseMasterM3u8(masterContent, playback.hls_url);

      const allVariants = [...videoVariants, ...audioVariants];
      for (const variantUrl of allVariants) {
        urlsToWarm.add(variantUrl);

        try {
          const varRes = await fetch(variantUrl, { headers: { 'User-Agent': USER_AGENT } });
          if (!varRes.ok) continue;
          const varContent = await varRes.text();
          const { segments, initUri } = parseRenditionM3u8(varContent, variantUrl);

          if (initUri) urlsToWarm.add(initUri);

          const is720pOrAudio = variantUrl.includes('720p') || variantUrl.includes('audio');
          if (isHotFull && is720pOrAudio) {
            // Full 720p + audio for top 5 hot videos
            segments.forEach((s) => urlsToWarm.add(s));
          } else {
            // Start-only: first 15 segments (~60s)
            segments.slice(0, WARM_SEGMENTS_COUNT).forEach((s) => urlsToWarm.add(s));
          }
        } catch (e) {
          console.warn(`  Failed parsing variant ${variantUrl}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn(`  Failed fetching H.264 master ${playback.hls_url}: ${e.message}`);
  }

  // B. AV1 Master and renditions (start-only, never full)
  if (playback.hls_av1_url) {
    try {
      console.log(`  Downloading AV1 master: ${playback.hls_av1_url}`);
      const av1Res = await fetch(playback.hls_av1_url, { headers: { 'User-Agent': USER_AGENT } });
      if (av1Res.ok) {
        urlsToWarm.add(playback.hls_av1_url);
        const av1Content = await av1Res.text();
        const { videoVariants, audioVariants } = parseMasterM3u8(av1Content, playback.hls_av1_url);

        const allVariants = [...videoVariants, ...audioVariants];
        for (const variantUrl of allVariants) {
          urlsToWarm.add(variantUrl);
          try {
            const varRes = await fetch(variantUrl, { headers: { 'User-Agent': USER_AGENT } });
            if (!varRes.ok) continue;
            const varContent = await varRes.text();
            const { segments, initUri } = parseRenditionM3u8(varContent, variantUrl);
            if (initUri) urlsToWarm.add(initUri);
            // AV1 is always start-only
            segments.slice(0, WARM_SEGMENTS_COUNT).forEach((s) => urlsToWarm.add(s));
          } catch (e) {
            console.warn(`  Failed parsing AV1 variant ${variantUrl}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`  Failed fetching AV1 master ${playback.hls_av1_url}: ${e.message}`);
    }
  }

  // Remove test segment if already downloaded during idempotency check
  if (cacheCheck.testSegmentUrl) {
    urlsToWarm.delete(cacheCheck.testSegmentUrl);
  }

  const urlList = Array.from(urlsToWarm);
  console.log(`  Queueing ${urlList.length} media assets for video ${video.id}...`);

  // 4. Download queued assets with concurrency <= MAX_CONCURRENCY and global rate limiter
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
  console.log(
    `Media URL: ${getMediaBaseUrl()} | Global Rate Limit: ${formatBytes(RATE_LIMIT_BPS)}/s | Concurrency: ${MAX_CONCURRENCY}`,
  );
  console.log(
    `Run Budget: ${formatBytes(WARM_MAX_BYTES_PER_RUN)} | Hot Full Limit: ${HOT_FULL_LIMIT} videos`,
  );
  console.log(`=======================================================`);

  // 1. Fetch Top Trending Videos
  const hotFullVideoIds = new Set();
  const candidateVideos = new Map();
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/v1/videos?limit=${HOT_VIDEOS_LIMIT}&sort=trending`,
      {
        headers: { 'User-Agent': USER_AGENT },
      },
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items)) {
        data.items.slice(0, HOT_FULL_LIMIT).forEach((item) => hotFullVideoIds.add(item.id));
        data.items.forEach((item) => candidateVideos.set(item.id, item));
      }
    }
  } catch (err) {
    console.warn(`[WARMER] Warning: Could not fetch trending videos: ${err.message}`);
  }
  console.log(
    `[WARMER] Loaded ${candidateVideos.size} trending videos (Top ${hotFullVideoIds.size} eligible for full 720p).`,
  );

  // 2. Catalogue Sweep: Newest 50 public videos (start-only unless also top-trending)
  try {
    const res = await fetch(`${getApiBaseUrl()}/v1/videos?limit=50&sort=newest`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          if (!candidateVideos.has(item.id)) {
            candidateVideos.set(item.id, item);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[WARMER] Error fetching catalogue sweep videos: ${err.message}`);
  }

  console.log(`[WARMER] Total ${candidateVideos.size} candidate videos to evaluate.`);
  stats.videosScanned = candidateVideos.size;

  // 3. Process candidate videos sequentially
  for (const [vid, video] of candidateVideos.entries()) {
    if (stats.bytesTransferred >= WARM_MAX_BYTES_PER_RUN) {
      console.warn(
        `[WARMER] Run budget ${formatBytes(WARM_MAX_BYTES_PER_RUN)} reached (${formatBytes(stats.bytesTransferred)} transferred). Halting.`,
      );
      break;
    }

    const isHotFull = hotFullVideoIds.has(vid);
    await warmVideo(video, isHotFull);
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
  console.log(
    `Total transferred:       ${formatBytes(stats.bytesTransferred)} / budget ${formatBytes(WARM_MAX_BYTES_PER_RUN)}`,
  );
  console.log(`Average throughput:      ${avgSpeed}`);
  console.log(`Cache MISS / HIT ratio:  ${stats.cacheMisses} MISS / ${stats.cacheHits} HIT`);
  console.log(`Errors encountered:      ${stats.errors}`);
  console.log(`=========================================================`);
}

export {
  parseMasterM3u8,
  parseRenditionM3u8,
  checkVideoCached,
  warmVideo,
  main,
  stats,
  resetStats,
  GlobalRateLimiter,
};

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error(`[FATAL] Cache Warmer crashed:`, err);
    process.exit(1);
  });
}
