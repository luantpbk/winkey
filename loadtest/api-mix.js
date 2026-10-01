/* global __ENV, __VU, __ITER, open */
import http from 'k6/http';
import { sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const apiErrors = new Rate('api_errors');
const apiDuration = new Trend('api_mix_duration');
const status2xx = new Counter('status_2xx');
const status429 = new Counter('status_429');
const status4xxOther = new Counter('status_4xx_other');
const status5xx = new Counter('status_5xx');

export const options = {
  thresholds: {
    api_errors: ['rate<0.005'], // Target api_errors < 0.5%
    http_req_duration: ['p(95)<500'], // 95th percentile response time < 500 ms
    status_429: ['count==0'], // Must respect rate limits (0 429s)
    'status_4xx_other{endpoint:PUT /v1/videos/:id/like}': ['count>=0'],
    'status_4xx_other{endpoint:POST /v1/videos/:id/comments}': ['count>=0'],
    'status_4xx_other{endpoint:GET /v1/videos}': ['count>=0'],
    'status_4xx_other{endpoint:GET /v1/videos/:id}': ['count>=0'],
    'status_4xx_other{endpoint:GET /v1/videos?sort=trending}': ['count>=0'],
    'status_4xx_other{endpoint:GET /v1/videos/:id/comments}': ['count>=0'],
    'status_4xx_other{endpoint:GET /v1/videos/:id/like}': ['count>=0'],
  },
  scenarios: {
    api_mix: {
      executor: 'constant-vus',
      vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 20,
      duration: __ENV.DURATION || '1m',
    },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';

const isLocalhost =
  TARGET_URL.includes('localhost') ||
  TARGET_URL.includes('127.0.0.1') ||
  TARGET_URL.includes('[::1]');
const defaultPassword = isLocalhost ? 'Password123!' : undefined;
const envPassword = __ENV.LOADTEST_USER_PASSWORD || defaultPassword;

const rawSeedData = (function () {
  try {
    return JSON.parse(open('./seed.json'));
  } catch (err) {
    void err;
    return {};
  }
})();

const videos = new SharedArray('videos', function () {
  return Array.isArray(rawSeedData.videos) ? rawSeedData.videos : [];
});

const users = new SharedArray('users', function () {
  return Array.isArray(rawSeedData.users) ? rawSeedData.users : [];
});

export function setup() {
  try {
    const seedUsers = Array.isArray(rawSeedData.users) ? rawSeedData.users : [];
    const freshUsers = [];

    for (let i = 0; i < seedUsers.length; i++) {
      const u = seedUsers[i];
      const email = u.email || `${u.handle}@example.com`;
      const password = u.password || envPassword;
      if (!password) {
        throw new Error(
          'LOADTEST_USER_PASSWORD environment variable is required when TARGET_URL is not localhost.',
        );
      }
      let loggedIn = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        const res = http.post(`${TARGET_URL}/v1/auth/login`, JSON.stringify({ email, password }), {
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.status === 200) {
          const body = JSON.parse(res.body);
          freshUsers.push({
            id: body.user.id,
            handle: body.user.handle,
            email,
            password,
            token: body.access_token,
          });
          loggedIn = true;
          break;
        } else if (res.status === 429) {
          sleep(61.0);
        } else {
          break;
        }
      }

      if (!loggedIn) {
        if (!isLocalhost) {
          throw new Error(
            `[setup] Login failed for user ${email} on non-localhost target ${TARGET_URL}`,
          );
        }
        freshUsers.push(u);
      }
      sleep(0.15);
    }
    return { users: freshUsers };
  } catch (err) {
    if (!isLocalhost) {
      throw err;
    }
    return { users: [] };
  }
}

export default function (data) {
  const userPool = data && data.users && data.users.length > 0 ? data.users : users;
  const rand = Math.random();
  const selectedVideo = videos.length > 0 ? videos[(__VU + __ITER) % videos.length] : null;
  const selectedUser = userPool.length > 0 ? userPool[(__VU - 1) % userPool.length] : null;

  const authHeaders = selectedUser ? { Authorization: `Bearer ${selectedUser.token}` } : {};
  const jsonAuthHeaders = selectedUser
    ? {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${selectedUser.token}`,
      }
    : { 'Content-Type': 'application/json' };

  let res;
  let endpointName = '';
  const t0 = Date.now();

  if (rand < 0.7) {
    // 70%: feed / watch / search reads
    const readChoice = Math.random();
    if (readChoice < 0.4) {
      endpointName = 'GET /v1/videos';
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    } else if (readChoice < 0.7 && selectedVideo) {
      endpointName = 'GET /v1/videos/:id';
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}`, { headers: authHeaders });
    } else {
      endpointName = 'GET /v1/videos?sort=trending';
      res = http.get(`${TARGET_URL}/v1/videos?sort=trending`, { headers: authHeaders });
    }
  } else if (rand < 0.95) {
    // 25%: like / comment reads
    const socialReadChoice = Math.random();
    if (socialReadChoice < 0.6 && selectedVideo) {
      endpointName = 'GET /v1/videos/:id/comments';
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}/comments`, {
        headers: authHeaders,
      });
    } else if (selectedVideo) {
      endpointName = 'GET /v1/videos/:id/like';
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}/like`, { headers: authHeaders });
    } else {
      endpointName = 'GET /v1/videos';
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    }
  } else {
    // 5%: writes (comment, like) using registered user tokens
    if (!selectedUser || !selectedVideo) {
      endpointName = 'GET /v1/videos';
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    } else {
      const writeChoice = Math.random();
      if (writeChoice < 0.5) {
        endpointName = 'POST /v1/videos/:id/comments';
        const payload = JSON.stringify({
          body: `Load test comment ${Date.now().toString(36)}`,
        });
        res = http.post(`${TARGET_URL}/v1/videos/${selectedVideo.id}/comments`, payload, {
          headers: jsonAuthHeaders,
        });
      } else {
        endpointName = 'PUT /v1/videos/:id/like';
        res = http.put(`${TARGET_URL}/v1/videos/${selectedVideo.id}/like`, null, {
          headers: authHeaders,
        });
      }
    }
  }

  apiDuration.add(Date.now() - t0);
  if (res) {
    const isError = res.status < 200 || res.status >= 400;
    apiErrors.add(isError);

    if (res.status >= 200 && res.status < 300) {
      status2xx.add(1);
    } else if (res.status === 429) {
      status429.add(1, { endpoint: endpointName });
    } else if (res.status >= 400 && res.status < 500) {
      status4xxOther.add(1, { endpoint: endpointName, status: String(res.status) });
    } else if (res.status >= 500) {
      status5xx.add(1, { endpoint: endpointName, status: String(res.status) });
    }
  }

  // Respect rate limits with think time (1.5 to 3.0 seconds)
  sleep(1.5 + Math.random() * 1.5);
}
