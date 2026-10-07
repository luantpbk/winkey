/* global __ENV, open */
import http from 'k6/http';
import { sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Custom metrics as required by LT2 / QOE2 specification
const rebufferRatioTrend = new Trend('rebuffer_ratio'); // stalls NOT caused by a seek (P2 gate criterion)
const rebufferRatioInclSeekTrend = new Trend('rebuffer_ratio_incl_seek'); // informational (incl seek stalls)
const startupTimeTrend = new Trend('startup_time');
const httpReqFailed = new Rate('http_req_failed');

const totalStallTimeMs = new Counter('total_stall_time_ms');
const totalWatchTimeMs = new Counter('total_watch_time_ms');

const executorType = __ENV.EXECUTOR || 'ramping-vus';

export const options = {
  thresholds: {
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

function resolveUrl(relativeUrl, baseUrl) {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  if (relativeUrl.startsWith('/')) {
    const match = baseUrl.match(/^(https?:\/\/[^/]+)/);
    const origin = match ? match[1] : '';
    return origin + relativeUrl;
  }
  const lastSlash = baseUrl.lastIndexOf('/');
  if (lastSlash !== -1) {
    return baseUrl.substring(0, lastSlash + 1) + relativeUrl;
  }
  return baseUrl + '/' + relativeUrl;
}

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
      if (durMatch) {
        currentDuration = parseFloat(durMatch[1]);
      }
    } else if (line && !line.startsWith('#')) {
      segments.push({
        duration: currentDuration,
        url: resolveUrl(line, baseUrl),
      });
    }
  }
  return segments;
}

export function setup() {
  if (seedVideos.length > 0) {
    return { videos: seedVideos };
  }
  // Production / non-seeded mode: fetch public READY videos via API
  const res = http.get(`${TARGET_URL}/v1/videos?sort=newest&limit=50`);
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      const items = Array.isArray(body.items) ? body.items : [];
      const videoList = items.map((v) => ({
        id: v.id,
        hls_url:
          v.playback && v.playback.hls_url ? v.playback.hls_url : `/v1/videos/${v.id}/master.m3u8`,
      }));
      return { videos: videoList };
    } catch {
      // ignore
    }
  }
  return { videos: [] };
}

export default function (data) {
  const videoPool = data && data.videos && data.videos.length > 0 ? data.videos : seedVideos;

  if (videoPool.length === 0) {
    const res = http.get(`${TARGET_URL}/readyz`);
    httpReqFailed.add(res.status !== 200);
    sleep(1);
    return;
  }

  // 20% of viewers pick from a "hot" video pool (top 20% of videos)
  const hotCount = Math.max(1, Math.floor(videoPool.length * 0.2));
  const isHotViewer = Math.random() < 0.2;
  const selectedVideo = isHotViewer
    ? videoPool[Math.floor(Math.random() * hotCount)]
    : videoPool[Math.floor(Math.random() * videoPool.length)];

  const tStart = Date.now();

  // 1. GET watch API
  const watchRes = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}`);
  httpReqFailed.add(watchRes.status !== 200);
  if (watchRes.status !== 200) {
    sleep(1);
    return;
  }

  let videoMeta;
  try {
    videoMeta = JSON.parse(watchRes.body);
  } catch {
    sleep(1);
    return;
  }

  const hlsUrl =
    videoMeta.playback && videoMeta.playback.hls_url
      ? resolveUrl(videoMeta.playback.hls_url, TARGET_URL)
      : resolveUrl(selectedVideo.hls_url, TARGET_URL);

  // 2. GET master playlist
  const masterRes = http.get(hlsUrl);
  httpReqFailed.add(masterRes.status !== 200);
  if (masterRes.status !== 200) {
    sleep(1);
    return;
  }

  const variants = parseMasterPlaylist(masterRes.body, hlsUrl);
  if (variants.length === 0) {
    sleep(1);
    return;
  }

  // Player ABR: Start at middle rendition
  let variantIdx = Math.floor(variants.length / 2);

  // Fetch variant playlist
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

  // Fetch first segment to measure startup time
  const seg0Res = http.get(segments[0].url);
  httpReqFailed.add(seg0Res.status !== 200);
  const startupTime = Date.now() - tStart;
  startupTimeTrend.add(startupTime);

  // 10% chance of random seek during session
  const willSeek = Math.random() < 0.1;
  let seekSegmentIndex = -1;
  if (willSeek && segments.length > 2) {
    seekSegmentIndex = Math.floor(Math.random() * (segments.length - 1)) + 1;
  }

  // Target watch time for session: 120 s to 300 s (2 to 5 minutes)
  const targetWatchTime = 120 + Math.random() * 180;
  const TARGET_BUFFER = 10.0;

  let currentBuffer = segments[0].duration;
  let stallTimeNoSeek = 0.0;
  let stallTimeSeekOnly = 0.0;
  let totalWatchTime = segments[0].duration;

  let lastBytes = seg0Res.body ? seg0Res.body.length : 0;
  let lastDlTimeSec = (seg0Res.timings.duration || 100) / 1000.0;

  let segIdx = 1;

  while (totalWatchTime < targetWatchTime) {
    if (segIdx >= segments.length) {
      segIdx = 0; // Loop playlist if video is shorter than target watch session
    }

    let isSeekPoint = false;
    if (willSeek && segIdx === seekSegmentIndex) {
      currentBuffer = 0.0; // Seek flushes current buffer
      isSeekPoint = true;
    }

    // ABR logic: Evaluate measured throughput against available renditions
    const measuredBps = (lastBytes * 8) / Math.max(0.01, lastDlTimeSec);
    if (measuredBps > variants[variantIdx].bandwidth * 1.2 && variantIdx < variants.length - 1) {
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

  // Record TWO ratios as specified in LT2 brief:
  // 1. rebuffer_ratio: non-seek stalls (P2 criterion gate)
  // 2. rebuffer_ratio_incl_seek: informational (includes seek stalls)
  const watchTimeNoZero = Math.max(0.001, totalWatchTime);
  const ratioNoSeek = stallTimeNoSeek / watchTimeNoZero;
  const ratioInclSeek = (stallTimeNoSeek + stallTimeSeekOnly) / watchTimeNoZero;

  rebufferRatioTrend.add(ratioNoSeek);
  rebufferRatioInclSeekTrend.add(ratioInclSeek);

  totalStallTimeMs.add(Math.round(stallTimeNoSeek * 1000));
  totalWatchTimeMs.add(Math.round(totalWatchTime * 1000));
}
