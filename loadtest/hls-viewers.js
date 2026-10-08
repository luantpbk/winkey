/* global __ENV, open */
import http from 'k6/http';
import { sleep, fail } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { resolveUrl } from './utils.mjs';

// Custom metrics as required by LT2 / QOE2 specification
const aggregateRebufferRatio = new Rate('aggregate_rebuffer_ratio'); // Primary Gate Criterion (aggregate stall / total)
const rebufferRatioTrend = new Trend('rebuffer_ratio'); // stalls NOT caused by a seek (informational trend)
const rebufferRatioInclSeekTrend = new Trend('rebuffer_ratio_incl_seek'); // informational (incl seek stalls)
const startupTimeTrend = new Trend('startup_time');
const httpReqFailed = new Rate('http_req_failed');

const totalStallTimeMs = new Counter('total_stall_time_ms');
const totalWatchTimeMs = new Counter('total_watch_time_ms');

const executorType = __ENV.EXECUTOR || 'ramping-vus';

export const options = {
  thresholds: {
    aggregate_rebuffer_ratio: ['rate<0.01'], // Primary Gate: aggregate rebuffer ratio < 1%
    rebuffer_ratio: ['p(95)<0.01'], // p95 per VU as informational
    startup_time: ['p(75)<2000'], // startup time p75 < 2 s (2000 ms)
    http_req_failed: ['rate<0.01'], // HTTP error rate < 1%
  },
  scenarios: {
    hls_viewers:
      executorType === 'ramping-vus'
        ? {
            executor: 'ramping-vus',
            startVUs: 50,
            stages: [
              { duration: '5m', target: 50 },
              { duration: '5m', target: 200 },
              { duration: '5m', target: 500 },
              { duration: '5m', target: 1000 },
              { duration: '15m', target: 1000 },
            ],
          }
        : {
            executor: 'constant-vus',
            vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 50,
            duration: __ENV.DURATION || '5m',
          },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'https://winkey.vn';

const seedVideos = new SharedArray('seed_videos', function () {
  try {
    const raw = JSON.parse(open('./seed.json'));
    return Array.isArray(raw.videos) ? raw.videos : [];
  } catch {
    return [];
  }
});

function parseMasterPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const variants = [];
  let currentBandwidth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      currentBandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 1000000;
    } else if (line && !line.startsWith('#')) {
      variants.push({
        bandwidth: currentBandwidth,
        url: resolveUrl(line, baseUrl),
      });
      currentBandwidth = 0;
    }
  }
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  return variants;
}

function parseVariantPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const segments = [];
  let currentDuration = 2.0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      currentDuration = durMatch ? parseFloat(durMatch[1]) : 2.0;
    } else if (line && !line.startsWith('#')) {
      segments.push({
        duration: currentDuration,
        url: resolveUrl(line, baseUrl),
      });
      currentDuration = 2.0;
    }
  }
  return segments;
}

export function setup() {
  let videoList = seedVideos.slice();
  if (videoList.length === 0) {
    const res = http.get(`${TARGET_URL}/v1/videos?sort=newest&limit=50`);
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        videoList = Array.isArray(body.items) ? body.items : [];
      } catch {
        // ignore
      }
    }
  }
  return { videos: videoList };
}

export default function (data) {
  const videoPool = data && data.videos && data.videos.length > 0 ? data.videos : seedVideos;
  if (videoPool.length === 0) {
    fail('FAIL: No valid video samples available in video pool for load test');
  }

  // 20% hot video selection, 80% uniform random
  let targetVideo;
  if (Math.random() < 0.2) {
    const hotCount = Math.max(1, Math.floor(videoPool.length * 0.2));
    targetVideo = videoPool[Math.floor(Math.random() * hotCount)];
  } else {
    targetVideo = videoPool[Math.floor(Math.random() * videoPool.length)];
  }

  // Resolve HLS manifest URL via playback.hls_url per OpenAPI contract
  let masterUrl = null;
  if (targetVideo && targetVideo.playback && targetVideo.playback.hls_url) {
    masterUrl = resolveUrl(targetVideo.playback.hls_url, TARGET_URL);
  } else if (targetVideo && targetVideo.id) {
    const detailRes = http.get(`${TARGET_URL}/v1/videos/${targetVideo.id}`);
    if (detailRes.status === 200) {
      try {
        const vData = JSON.parse(detailRes.body);
        const v = vData.video || vData;
        if (v && v.playback && v.playback.hls_url) {
          masterUrl = resolveUrl(v.playback.hls_url, TARGET_URL);
        }
      } catch {
        // ignore
      }
    }
  }

  if (!masterUrl && targetVideo && targetVideo.id) {
    masterUrl = `${TARGET_URL}/v1/videos/${targetVideo.id}/manifest.m3u8`;
  }

  if (!masterUrl) {
    sleep(1);
    return;
  }

  const t0 = Date.now();
  const masterRes = http.get(masterUrl);
  httpReqFailed.add(masterRes.status !== 200);

  if (masterRes.status !== 200) {
    sleep(1);
    return;
  }

  const variants = parseMasterPlaylist(masterRes.body, masterUrl);
  if (variants.length === 0) {
    sleep(1);
    return;
  }

  let variantIdx = 0;
  let variantRes = http.get(variants[variantIdx].url);
  httpReqFailed.add(variantRes.status !== 200);

  if (variantRes.status !== 200) {
    sleep(1);
    return;
  }

  let segments = parseVariantPlaylist(variantRes.body, variants[variantIdx].url);
  if (segments.length === 0) {
    sleep(1);
    return;
  }

  const firstSegRes = http.get(segments[0].url);
  httpReqFailed.add(firstSegRes.status !== 200);
  const startupTime = Date.now() - t0;
  startupTimeTrend.add(startupTime);

  let currentBuffer = segments[0].duration;
  let totalWatchTime = segments[0].duration;
  let stallTimeNoSeek = 0.0;
  let stallTimeSeekOnly = 0.0;
  let lastBytes = firstSegRes.body ? firstSegRes.body.length : 0;
  let lastDlTimeSec = (firstSegRes.timings.duration || 100) / 1000.0;

  const TARGET_BUFFER = 10.0;
  const playDuration = 25.0 + Math.random() * 10.0; // Watch for ~25-35s
  let segIdx = 1;
  const startTime = Date.now();

  while ((Date.now() - startTime) / 1000.0 < playDuration && segIdx < segments.length * 3) {
    const isSeekPoint = Math.random() < 0.1; // 10% seek probability
    if (isSeekPoint) {
      segIdx = Math.floor(Math.random() * segments.length);
      currentBuffer = 0.0;
    }

    const measuredBps = lastDlTimeSec > 0 ? (lastBytes * 8) / lastDlTimeSec : 1000000;

    if (measuredBps > variants[variantIdx].bandwidth * 1.5 && variantIdx < variants.length - 1) {
      variantIdx++;
      variantRes = http.get(variants[variantIdx].url);
      if (variantRes.status === 200) {
        segments = parseVariantPlaylist(variantRes.body, variants[variantIdx].url);
      }
    } else if (measuredBps < variants[variantIdx].bandwidth * 1.1 && variantIdx > 0) {
      variantIdx--;
      variantRes = http.get(variants[variantIdx].url);
      if (variantRes.status === 200) {
        segments = parseVariantPlaylist(variantRes.body, variants[variantIdx].url);
      }
    }

    const segUrl = segments[segIdx] ? segments[segIdx].url : segments[0].url;
    const segDuration = segments[segIdx] ? segments[segIdx].duration : 2.0;

    const segRes = http.get(segUrl);
    httpReqFailed.add(segRes.status !== 200);

    const dlTimeSec = (segRes.timings.duration || 100) / 1000.0;
    lastBytes = segRes.body ? segRes.body.length : 0;
    lastDlTimeSec = dlTimeSec;

    if (dlTimeSec > currentBuffer) {
      const stallSec = dlTimeSec - currentBuffer;
      if (isSeekPoint) {
        stallTimeSeekOnly += stallSec;
      } else {
        stallTimeNoSeek += stallSec;
      }
      totalWatchTime += currentBuffer;
      currentBuffer = 0.0;
    } else {
      currentBuffer -= dlTimeSec;
      totalWatchTime += dlTimeSec;
    }

    currentBuffer += segDuration;

    if (currentBuffer > TARGET_BUFFER) {
      const sleepSec = currentBuffer - TARGET_BUFFER;
      sleep(sleepSec);
      currentBuffer -= sleepSec;
      totalWatchTime += sleepSec;
    }

    segIdx++;
  }

  // Record ratios as specified in LT2 brief:
  const watchTimeNoZero = Math.max(0.001, totalWatchTime);
  const ratioNoSeek = stallTimeNoSeek / watchTimeNoZero;
  const ratioInclSeek = (stallTimeNoSeek + stallTimeSeekOnly) / watchTimeNoZero;

  rebufferRatioTrend.add(ratioNoSeek);
  rebufferRatioInclSeekTrend.add(ratioInclSeek);

  totalStallTimeMs.add(Math.round(stallTimeNoSeek * 1000));
  totalWatchTimeMs.add(Math.round(totalWatchTime * 1000));

  // Feed aggregate_rebuffer_ratio Rate metric (100-ms granularity samples)
  const stallUnits = Math.round(stallTimeNoSeek * 10);
  const watchUnits = Math.round(totalWatchTime * 10);
  for (let i = 0; i < stallUnits; i++) {
    aggregateRebufferRatio.add(true);
  }
  for (let i = 0; i < watchUnits; i++) {
    aggregateRebufferRatio.add(false);
  }
}
