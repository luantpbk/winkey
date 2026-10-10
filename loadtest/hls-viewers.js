import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const stallMsNoseek = new Counter('stall_ms_noseek');
const stallMsSeek = new Counter('stall_ms_seek');
const watchMsCounter = new Counter('watch_ms');
const httpReqFailed = new Rate('http_req_failed');

export const options = {
  scenarios: {
    hls_viewers: {
      executor: 'ramping-vus',
      startVUs: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 50,
      stages: __ENV.VUS
        ? [{ duration: __ENV.DURATION || '1m', target: parseInt(__ENV.VUS, 10) }]
        : [
            { duration: '5m', target: 50 },
            { duration: '5m', target: 200 },
            { duration: '5m', target: 500 },
            { duration: '5m', target: 1000 },
            { duration: '15m', target: 1000 },
          ],
    },
  },
  thresholds: {
    http_req_failed: [
      'rate<0.01',
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '1m' },
    ],
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';

export function setup() {
  const target = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
  let videos = [];
  const urls = [`${target}/v1/videos?sort=newest&limit=50`, `${target}/v1/videos?sort=trending`];
  for (const u of urls) {
    const res = http.get(u);
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        const list = Array.isArray(body) ? body : body.videos || body.items || [];
        for (const item of list) {
          if (!item.visibility || item.visibility === 'PUBLIC') videos.push(item);
        }
      } catch (_) {}
    }
  }
  if (videos.length === 0) {
    videos = [{ id: 'demo-1', hls_url: '/hls/demo/master.m3u8' }];
  }
  return { videos };
}

function resolveUrl(relativeUrl, baseUrl) {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
  if (relativeUrl.startsWith('/')) {
    const match = baseUrl.match(/^(https?:\/\/[^/]+)/);
    return (match ? match[1] : '') + relativeUrl;
  }
  const lastSlash = baseUrl.lastIndexOf('/');
  return (lastSlash !== -1 ? baseUrl.substring(0, lastSlash + 1) : baseUrl + '/') + relativeUrl;
}

function parseMasterPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const variants = [];
  let bw = 1000000;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/);
      if (match) bw = parseInt(match[1], 10);
    } else if (trimmed && !trimmed.startsWith('#')) {
      variants.push({ bandwidth: bw, url: resolveUrl(trimmed, baseUrl) });
    }
  }
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  return variants;
}

function parseVariantPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const segments = [];
  let dur = 2.0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const match = trimmed.match(/#EXTINF:([\d.]+)/);
      if (match) dur = parseFloat(match[1]);
    } else if (trimmed && !trimmed.startsWith('#')) {
      segments.push({ duration: dur, url: resolveUrl(trimmed, baseUrl) });
    }
  }
  return segments;
}

export default function (data) {
  const videos = (data && data.videos) || [];
  if (videos.length === 0) {
    const res = http.get(`${TARGET_URL}/readyz`);
    httpReqFailed.add(res.status < 200 || res.status >= 400);
    sleep(1);
    return;
  }

  const hotCount = Math.max(1, Math.floor(videos.length * 0.2));
  const selected =
    Math.random() < 0.2
      ? videos[Math.floor(Math.random() * hotCount)]
      : videos[Math.floor(Math.random() * videos.length)];

  const watchRes = http.get(`${TARGET_URL}/v1/videos/${selected.id}`);
  httpReqFailed.add(watchRes.status < 200 || watchRes.status >= 400);
  if (watchRes.status < 200 || watchRes.status >= 400) {
    sleep(1);
    return;
  }

  let videoMeta = {};
  try {
    videoMeta = JSON.parse(watchRes.body);
  } catch (_) {}

  const hlsUrl = resolveUrl(
    (videoMeta.playback && videoMeta.playback.hls_url) ||
      selected.hls_url ||
      '/hls/demo/master.m3u8',
    TARGET_URL,
  );

  const masterRes = http.get(hlsUrl);
  httpReqFailed.add(masterRes.status < 200 || masterRes.status >= 400);
  if (masterRes.status < 200 || masterRes.status >= 400) {
    sleep(1);
    return;
  }

  const variants = parseMasterPlaylist(masterRes.body, hlsUrl);
  if (variants.length === 0) {
    sleep(1);
    return;
  }

  let varIdx = Math.floor(variants.length / 2);
  let varRes = http.get(variants[varIdx].url);
  httpReqFailed.add(varRes.status < 200 || varRes.status >= 400);
  if (varRes.status < 200 || varRes.status >= 400) {
    sleep(1);
    return;
  }

  let segments = parseVariantPlaylist(varRes.body, variants[varIdx].url);
  if (segments.length === 0) {
    sleep(1);
    return;
  }

  const seg0Res = http.get(segments[0].url);
  httpReqFailed.add(seg0Res.status < 200 || seg0Res.status >= 400);

  const targetWatchTime = 30 + Math.random() * 60;
  let currentBuffer = segments[0].duration;
  let totalWatchTime = segments[0].duration;
  let segIdx = 1;
  const seekIdx = Math.random() < 0.1 ? Math.floor(Math.random() * (segments.length - 1)) + 1 : -1;

  watchMsCounter.add(Math.round(segments[0].duration * 1000));

  while (totalWatchTime < targetWatchTime) {
    if (segIdx >= segments.length) segIdx = 0;
    let isSeekStall = false;
    if (segIdx === seekIdx) {
      currentBuffer = 0.0;
      isSeekStall = true;
    }

    const seg = segments[segIdx] || segments[0];
    const segRes = http.get(seg.url);
    httpReqFailed.add(segRes.status < 200 || segRes.status >= 400);

    const dlTimeSec = (segRes.timings.duration || 100) / 1000.0;
    if (dlTimeSec > currentBuffer) {
      const stallSec = dlTimeSec - currentBuffer;
      const stallMs = Math.round(stallSec * 1000);
      const watchMs = Math.round(currentBuffer * 1000);
      if (isSeekStall) {
        stallMsSeek.add(stallMs);
      } else {
        stallMsNoseek.add(stallMs);
      }
      watchMsCounter.add(watchMs);
      totalWatchTime += currentBuffer;
      currentBuffer = 0.0;
    } else {
      currentBuffer -= dlTimeSec;
      const watchMs = Math.round(dlTimeSec * 1000);
      watchMsCounter.add(watchMs);
      totalWatchTime += dlTimeSec;
    }

    currentBuffer += seg.duration;

    if (currentBuffer > 10.0) {
      const sleepSec = currentBuffer - 10.0;
      sleep(sleepSec);
      currentBuffer -= sleepSec;
      watchMsCounter.add(Math.round(sleepSec * 1000));
      totalWatchTime += sleepSec;
    }
    segIdx++;
  }
}

export function handleSummary(data) {
  const stallNoseek =
    (data.metrics.stall_ms_noseek && data.metrics.stall_ms_noseek.values.count) || 0;
  const stallSeek = (data.metrics.stall_ms_seek && data.metrics.stall_ms_seek.values.count) || 0;
  const watch = (data.metrics.watch_ms && data.metrics.watch_ms.values.count) || 0;
  const httpFailed =
    (data.metrics.http_req_failed && data.metrics.http_req_failed.values.rate) || 0;

  const rebuffer_ratio = stallNoseek / (watch + stallNoseek || 1);
  const rebuffer_ratio_incl_seek =
    (stallNoseek + stallSeek) / (watch + stallNoseek + stallSeek || 1);
  const passed = rebuffer_ratio < 0.01 && httpFailed < 0.01;

  const summary = {
    rebuffer_ratio,
    rebuffer_ratio_incl_seek,
    http_req_failed: httpFailed,
    passed,
    watch_ms: watch,
    stall_ms_noseek: stallNoseek,
    stall_ms_seek: stallSeek,
  };

  const output = JSON.stringify(summary, null, 2);
  console.log(
    `[LT2 SUMMARY] ${passed ? 'PASS' : 'FAIL'} - rebuffer_ratio: ${(rebuffer_ratio * 100).toFixed(2)}%, http_req_failed: ${(httpFailed * 100).toFixed(2)}%`,
  );

  return {
    'results/lt2-summary.json': output,
    stdout: output + '\n',
  };
}
