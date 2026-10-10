/* global __ENV */
import http from 'k6/http';
import { sleep } from 'k6';
import { Rate } from 'k6/metrics';

const httpReqFailed = new Rate('http_req_failed');

export const options = {
  scenarios: {
    api_read: {
      executor: 'ramping-vus',
      startVUs: __ENV.VUS ? Math.max(1, Math.floor(parseInt(__ENV.VUS, 10) * 0.05)) : 3,
      stages: __ENV.VUS
        ? [
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
  const res = http.get(ep);
  httpReqFailed.add(res.status < 200 || res.status >= 400);
  sleep(0.5 + Math.random() * 1.0);
}
