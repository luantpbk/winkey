/* global __ENV, __VU, __ITER, open, console */
import http from 'k6/http';
import { sleep, fail } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const apiErrors = new Rate('api_errors');
const apiDuration = new Trend('api_mix_duration');
const status2xx = new Counter('status_2xx');
const status429 = new Counter('status_429');
const status4xxOther = new Counter('status_4xx_other');
const status5xx = new Counter('status_5xx');

const executorType = __ENV.EXECUTOR || 'ramping-vus';

export const options = {
  thresholds: {
    api_errors: ['rate<0.01'], // Target api_errors < 1%
    http_req_duration: ['p(95)<500'], // 95th percentile response time < 500 ms
    status_429: ['count==0'], // Must respect rate limits (0 429s)
  },
  scenarios: {
    api_mix:
      executorType === 'ramping-vus'
        ? {
            executor: 'ramping-vus',
            startVUs: 3,
            stages: [
              { duration: '5m', target: 3 },
              { duration: '5m', target: 10 },
              { duration: '5m', target: 25 },
              { duration: '5m', target: 50 },
              { duration: '15m', target: 50 },
            ],
          }
        : {
            executor: 'constant-vus',
            vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 5,
            duration: __ENV.DURATION || '1m',
          },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'https://winkey.vn';
const COLLECTOR_URL = __ENV.COLLECTOR_URL || 'http://127.0.0.1:9999';

const isLocalhost =
  TARGET_URL.includes('localhost') ||
  TARGET_URL.includes('127.0.0.1') ||
  TARGET_URL.includes('[::1]');

const defaultPassword = isLocalhost ? 'Password123!' : undefined;
const envPassword = __ENV.LOADTEST_USER_PASSWORD || defaultPassword;

const rawSeedData = (function () {
  try {
    return JSON.parse(open('./seed.json'));
  } catch {
    return {};
  }
})();

const rawLt2Accounts = (function () {
  try {
    return JSON.parse(open('./lt2_accounts.json'));
  } catch {
    return [];
  }
})();

const seedVideos = new SharedArray('seed_videos_api', function () {
  return Array.isArray(rawSeedData.videos) ? rawSeedData.videos : [];
});

const seedUsers = new SharedArray('seed_users_api', function () {
  return Array.isArray(rawSeedData.users) ? rawSeedData.users : [];
});

const preseededAccounts = new SharedArray('preseeded_lt2_accounts', function () {
  return Array.isArray(rawLt2Accounts) ? rawLt2Accounts : [];
});

function refreshInMemoryToken(user) {
  if (!user || !user.email) return null;
  const loginRes = http.post(
    `${TARGET_URL}/v1/auth/login`,
    JSON.stringify({ email: user.email, password: envPassword }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (loginRes.status === 200) {
    try {
      const body = JSON.parse(loginRes.body);
      if (body && body.access_token) {
        user.token = body.access_token;
        console.log(`[workload] Refreshed in-memory token for user ${user.handle}`);
        return body.access_token;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function sendCommentToCollector(commentPayload) {
  const payloadStr = JSON.stringify(commentPayload);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = http.post(`${COLLECTOR_URL}/comment`, payloadStr, {
      headers: { 'Content-Type': 'application/json' },
      timeout: '2s',
    });
    if (res && res.status === 200) {
      return true;
    }
    sleep(0.2 * attempt);
  }
  console.log(
    `[collector] WARNING: Failed to record comment ${commentPayload.id} after 3 retries.`,
  );
  return false;
}

export function setup() {
  if (!envPassword) {
    throw new Error(
      '[setup] LOADTEST_USER_PASSWORD environment variable is strictly required when targeting production / non-localhost.',
    );
  }

  const lt2Accounts = [];
  const accountsToLogin = preseededAccounts.slice();

  if (accountsToLogin.length !== 5) {
    fail(
      `[setup] ERROR: lt2_accounts.json must contain EXACTLY 5 preseeded accounts (found ${accountsToLogin.length}). Fail-closed abort.`,
    );
  }

  console.log(
    `[setup] Logging in ${accountsToLogin.length} preseeded lt2 accounts into memory for workload on target ${TARGET_URL}...`,
  );
  for (let i = 0; i < accountsToLogin.length; i++) {
    const acc = accountsToLogin[i];
    const loginRes = http.post(
      `${TARGET_URL}/v1/auth/login`,
      JSON.stringify({ email: acc.email, password: envPassword }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (loginRes.status === 200) {
      try {
        const body = JSON.parse(loginRes.body);
        if (!body || !body.access_token) {
          fail(`[setup] Login response for ${acc.email} missing access_token. Fail-closed abort.`);
        }
        lt2Accounts.push({
          id: body.user ? body.user.id : acc.handle,
          handle: acc.handle,
          email: acc.email,
          token: body.access_token,
        });
      } catch (err) {
        fail(`[setup] Could not parse login response for ${acc.email}: ${err.message}`);
      }
    } else {
      fail(
        `[setup] ERROR: Memory login failed for preseeded account ${acc.email} (HTTP ${loginRes.status}). Fail-closed abort.`,
      );
    }
    sleep(0.5); // Pacing for login requests
  }

  // Fetch public videos for browsing
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

  return { users: lt2Accounts, videos: videoList };
}

export default function (data) {
  const userPool = data && data.users && data.users.length > 0 ? data.users : seedUsers;
  const videoPool = data && data.videos && data.videos.length > 0 ? data.videos : seedVideos;

  if (videoPool.length === 0) {
    fail('FAIL: No valid video samples available for API mix load test');
  }

  const rand = Math.random();
  const selectedVideo = videoPool.length > 0 ? videoPool[(__VU + __ITER) % videoPool.length] : null;
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
    // 25%: social reads
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
    // 5%: writes (comment, like)
    if (!selectedUser || !selectedVideo) {
      endpointName = 'GET /v1/videos';
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    } else {
      const writeChoice = Math.random();
      if (writeChoice < 0.5) {
        endpointName = 'POST /v1/videos/:id/comments';
        const payload = JSON.stringify({
          body: `LT2 test comment ${Date.now().toString(36)}`,
        });
        res = http.post(`${TARGET_URL}/v1/videos/${selectedVideo.id}/comments`, payload, {
          headers: jsonAuthHeaders,
        });

        if (res.status === 201) {
          try {
            const body = JSON.parse(res.body);
            const commentId = body ? body.id || (body.comment && body.comment.id) : null;
            if (commentId) {
              // Flush comment ID to collector with retries on missing ACK
              sendCommentToCollector({
                id: commentId,
                authorEmail: selectedUser.email,
                authorHandle: selectedUser.handle,
              });
            }
          } catch {
            // ignore
          }
        }
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
    // Perform in-memory token renewal if request returned 401 Unauthorized
    if (res.status === 401 && selectedUser) {
      console.log(
        `[workload] Received 401 for ${selectedUser.handle}. Performing token renewal...`,
      );
      refreshInMemoryToken(selectedUser);
    }

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

  sleep(1.5 + Math.random() * 1.5);
}

export function teardown() {
  // Account and comment cleanup is managed reliably outside k6 by loadtest/cleanup.mjs
  // to ensure strict deletion order (comments FIRST, then accounts) and recovery retention.
  console.log(
    '[teardown] k6 scenario finished. Cleanup execution delegated to loadtest/cleanup.mjs',
  );
}
