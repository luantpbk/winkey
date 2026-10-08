/* global __ENV, __VU, __ITER, open, console */
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

const rawLt2Tokens = (function () {
  try {
    return JSON.parse(open('./lt2_tokens.json'));
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

const preseededTokens = new SharedArray('preseeded_lt2_tokens', function () {
  return Array.isArray(rawLt2Tokens) ? rawLt2Tokens : [];
});

export function setup() {
  if (!envPassword) {
    throw new Error(
      '[setup] LOADTEST_USER_PASSWORD environment variable is strictly required when targeting production / non-localhost.',
    );
  }

  const lt2Accounts = preseededTokens.slice();
  const inviteCode = __ENV.LT2_INVITE_CODE || '';

  // Limit to max 5 lt2 temporary accounts for production mode
  const targetCount = isLocalhost && seedUsers.length > 0 ? 0 : 5;

  if (targetCount > 0 && lt2Accounts.length === 0) {
    console.log(
      `[setup] Registering ${targetCount} temporary lt2 accounts on target ${TARGET_URL}...`,
    );
    for (let i = 0; i < targetCount; i++) {
      const randStr = Math.random().toString(36).substring(2, 8);
      const handle = `lt2_user${i + 1}_${randStr}`;
      const email = `${handle}@example.com`;

      const regBody = JSON.stringify({
        email,
        password: envPassword,
        handle,
        display_name: `LT2 User ${i + 1}`,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      });

      const res = http.post(`${TARGET_URL}/v1/auth/register`, regBody, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 201) {
        try {
          const body = JSON.parse(res.body);
          lt2Accounts.push({
            id: body.user.id,
            handle: body.user.handle,
            email,
            token: body.access_token,
          });
        } catch {
          // ignore
        }
      } else if (res.status === 409) {
        const loginRes = http.post(
          `${TARGET_URL}/v1/auth/login`,
          JSON.stringify({ email, password: envPassword }),
          { headers: { 'Content-Type': 'application/json' } },
        );
        if (loginRes.status === 200) {
          try {
            const body = JSON.parse(loginRes.body);
            lt2Accounts.push({
              id: body.user.id,
              handle: body.user.handle,
              email,
              token: body.access_token,
            });
          } catch {
            // ignore
          }
        }
      }
      sleep(1.2); // Respect auth rate limits
    }
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

  const finalUsers = lt2Accounts.length > 0 ? lt2Accounts : seedUsers;
  return { users: finalUsers, videos: videoList };
}

export default function (data) {
  const userPool = data && data.users && data.users.length > 0 ? data.users : seedUsers;
  const videoPool = data && data.videos && data.videos.length > 0 ? data.videos : seedVideos;

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
            if (body && body.id) {
              // Flush comment ID to collector for persistent data recovery tracking
              http.post(
                `${COLLECTOR_URL}/comment`,
                JSON.stringify({
                  id: body.id,
                  authorEmail: selectedUser.email,
                  authorHandle: selectedUser.handle,
                }),
                { headers: { 'Content-Type': 'application/json' }, timeout: '1s' },
              );
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

export function teardown(data) {
  const users = data && Array.isArray(data.users) ? data.users : [];
  const lt2Users = users.filter((u) => u.handle && u.handle.startsWith('lt2_'));

  if (lt2Users.length > 0) {
    console.log(`[teardown] Teardown starting for ${lt2Users.length} lt2 accounts...`);

    for (let i = 0; i < lt2Users.length; i++) {
      const u = lt2Users[i];
      try {
        // Step 1: Re-login immediately before deletion to obtain a fresh access token
        console.log(`[teardown] Re-logging in user ${u.email} before deletion...`);
        const loginRes = http.post(
          `${TARGET_URL}/v1/auth/login`,
          JSON.stringify({ email: u.email, password: envPassword }),
          { headers: { 'Content-Type': 'application/json' } },
        );

        if (loginRes.status !== 200) {
          console.log(`[teardown] Re-login failed for ${u.email} (status ${loginRes.status}).`);
          continue;
        }

        const freshToken = JSON.parse(loginRes.body).access_token;

        // Step 2: Call DELETE /v1/auth/me with confirm_handle and password
        const delBody = JSON.stringify({
          confirm_handle: u.handle,
          password: envPassword,
        });

        const delRes = http.del(`${TARGET_URL}/v1/auth/me`, delBody, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${freshToken}`,
          },
        });

        if (delRes.status === 204) {
          console.log(`[teardown] SUCCESS: Account ${u.handle} deleted (HTTP 204).`);
        } else {
          console.log(
            `[teardown] FAILED: Account ${u.handle} deletion returned HTTP ${delRes.status} (expected 204).`,
          );
        }
      } catch (err) {
        console.log(`[teardown] Error during account teardown for ${u.handle}: ${err.message}`);
      }
      sleep(0.5);
    }
    console.log('[teardown] lt2 accounts teardown completed.');
  }
}
