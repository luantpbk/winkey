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
    http_req_failed: ['rate<0.01'],
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';

export default function () {
  const endpoints = [
    `${TARGET_URL}/v1/videos?sort=newest&limit=20`,
    `${TARGET_URL}/v1/videos/demo-video-1`,
    `${TARGET_URL}/v1/videos/demo-video-1/related`,
    `${TARGET_URL}/v1/videos/demo-video-1/comments`,
    `${TARGET_URL}/v1/videos/search?q=winkey`,
    `${TARGET_URL}/v1/cinema/catalog`,
  ];

  const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(ep);
  httpReqFailed.add(res.status < 200 || res.status >= 400);
  sleep(0.5 + Math.random() * 1.0);
}
