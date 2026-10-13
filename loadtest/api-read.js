/* global __ENV */
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const httpReqFailed = new Rate('http_req_failed');
// /v1/search is rate limited per client IP (video-svc SEARCH_RATE_LIMIT, 60/min). Every load VU shares
// the generator's single IP, so 429 there is the limiter working, not a failure (LT2 #355 run 2).
// It is counted separately and kept out of http_req_failed; every other endpoint still counts 429.
const searchRateLimited = new Counter('search_rate_limited');
const searchExpected = http.expectedStatuses({ min: 200, max: 399 }, 429);

export const options = {
  scenarios: {
    api_read: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: __ENV.VUS
        ? [
            {
              duration:
                __ENV.RAMP_DURATION ||
                (__ENV.DURATION && /^[0-9]+s$/.test(__ENV.DURATION) ? '1s' : '1m'),
              target: Math.max(1, Math.floor(parseInt(__ENV.VUS, 10) * 0.05)),
            },
            {
              duration: __ENV.DURATION || '1m',
              target: Math.max(1, Math.floor(parseInt(__ENV.VUS, 10) * 0.05)),
            },
          ]
        : [
            { duration: '5m', target: 3 },
            { duration: '5m', target: 10 },
            { duration: '5m', target: 25 },
            { duration: '5m', target: 50 },
            { duration: '15m', target: 50 },
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
  let videoIds = [];
  const listRes = http.get(`${target}/v1/videos?sort=newest&limit=50`);
  if (listRes.status === 200) {
    try {
      const body = JSON.parse(listRes.body);
      const list = Array.isArray(body) ? body : body.videos || body.items || [];
      videoIds = list.map((item) => item.id).filter(Boolean);
    } catch {
      /* ignore */
    }
  }
  if (videoIds.length === 0) {
    throw new Error('Failed to fetch video pool in setup()');
  }

  const cinemaRes = http.get(`${target}/v1/cinema/catalog`);
  const hasCinema = cinemaRes.status === 200;

  return { videoIds, hasCinema };
}

export default function (data) {
  const videoIds = (data && data.videoIds) || [];
  if (videoIds.length === 0) {
    const res = http.get(`${TARGET_URL}/readyz`);
    httpReqFailed.add(res.status < 200 || res.status >= 400);
    sleep(1);
    return;
  }
  const hasCinema = Boolean(data && data.hasCinema);
  const selectedId = videoIds[Math.floor(Math.random() * videoIds.length)];

  const endpoints = [
    `${TARGET_URL}/v1/videos?sort=newest&limit=20`,
    `${TARGET_URL}/v1/videos/${selectedId}`,
    `${TARGET_URL}/v1/videos/${selectedId}/related`,
    `${TARGET_URL}/v1/videos/${selectedId}/comments`,
    `${TARGET_URL}/v1/search?q=winkey`,
  ];

  if (hasCinema) {
    endpoints.push(`${TARGET_URL}/v1/cinema/catalog`);
  }

  const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
  const isSearch = ep.includes('/v1/search');
  const res = http.get(ep, isSearch ? { responseCallback: searchExpected } : {});
  if (isSearch && res.status === 429) {
    searchRateLimited.add(1);
  } else {
    httpReqFailed.add(res.status < 200 || res.status >= 400);
  }
  sleep(0.5 + Math.random() * 1.0);
}
