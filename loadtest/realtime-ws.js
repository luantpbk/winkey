/* global __ENV, __VU, open, console */
import http from 'k6/http';
import ws from 'k6/ws';
import { sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const connectionFailures = new Rate('connection_failures');
const wsConnected = new Counter('ws_connected');
const wsHintLatency = new Trend('ws_hint_latency');
const wsHintSamples = new Counter('ws_hint_samples');

const vusCount = __ENV.VUS ? parseInt(__ENV.VUS, 10) : 200;
const minHintSamples = Math.floor(0.9 * vusCount);

export const options = {
  setupTimeout: '3m',
  thresholds: {
    connection_failures: ['rate<0.05'], // < 5% failure rate
    ws_hint_latency: ['p(95)<1000'], // p95 latency < 1s
    ws_hint_samples: [`count>=${minHintSamples}`], // number of hint samples >= 90% of VUs
  },
  scenarios: {
    realtime_ws: {
      executor: 'constant-vus',
      vus: vusCount,
      duration: __ENV.DURATION || '1m',
    },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const AUTH_URL_ENV = __ENV.AUTH_URL || 'http://127.0.0.1:3001';

function isLocalhostUrl(urlStr) {
  return urlStr.includes('localhost') || urlStr.includes('127.0.0.1') || urlStr.includes('[::1]');
}

const isTargetLocal = isLocalhostUrl(TARGET_URL);
const isAuthLocal = isLocalhostUrl(AUTH_URL_ENV);
const useDirectAuthLocalhost = isTargetLocal && isAuthLocal;

const defaultPassword = isTargetLocal ? 'Password123!' : undefined;
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
    if (useDirectAuthLocalhost) {
      console.log(
        `[setup] Mode: Direct AUTH_URL (${AUTH_URL_ENV}) with X-Forwarded-For (both TARGET_URL and AUTH_URL are localhost).`,
      );
    } else {
      console.log(
        `[setup] Mode: Gateway (${TARGET_URL}) with rate-limit pacing (non-localhost or gateway-only target).`,
      );
    }

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
      const authTargetBase = useDirectAuthLocalhost ? AUTH_URL_ENV : TARGET_URL;
      const headers = { 'Content-Type': 'application/json' };
      if (useDirectAuthLocalhost) {
        headers['X-Forwarded-For'] = `10.42.0.${(i % 250) + 1}`;
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const res = http.post(
          `${authTargetBase}/v1/auth/login`,
          JSON.stringify({ email, password }),
          {
            headers,
          },
        );
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
          sleep(1.0);
        } else {
          break;
        }
      }

      if (!loggedIn) {
        if (!isTargetLocal) {
          throw new Error(
            `[setup] Login failed for user ${email} on non-localhost target ${TARGET_URL}`,
          );
        }
        freshUsers.push(u);
      }

      if (!useDirectAuthLocalhost) {
        sleep(0.1);
      }
    }
    return { users: freshUsers };
  } catch (err) {
    if (!isTargetLocal) {
      throw err;
    }
    return { users: [] };
  }
}

export default function (data) {
  const userPool = data && data.users && data.users.length > 0 ? data.users : users;
  if (userPool.length === 0) {
    connectionFailures.add(true);
    return;
  }

  const currentUser = userPool[(__VU - 1) % userPool.length];
  const commenterUser = userPool[__VU % userPool.length];
  const userVideo =
    videos.find((v) => v.creator_id === currentUser.id) || videos[(__VU - 1) % videos.length];

  const authHeaders = { Authorization: `Bearer ${currentUser.token}` };
  if (useDirectAuthLocalhost) {
    authHeaders['X-Forwarded-For'] = `10.42.0.${((__VU - 1) % 250) + 1}`;
  }

  // 1. Request ticket from HTTP API
  const ticketRes = http.post(`${TARGET_URL}/v1/realtime/ticket`, null, { headers: authHeaders });

  if (ticketRes.status !== 201) {
    connectionFailures.add(true);
    sleep(1);
    return;
  }

  const ticketData = JSON.parse(ticketRes.body);
  const ticket = ticketData.ticket;

  // 2. Open WebSocket connection with ticket
  const wsScheme = TARGET_URL.startsWith('https') ? 'wss' : 'ws';
  const hostAndPort = TARGET_URL.replace(/^https?:\/\//, '');
  const wsUrl = `${wsScheme}://${hostAndPort}/v1/realtime?ticket=${ticket}`;

  let commentPostTime = 0;
  let hintReceived = false;

  const res = ws.connect(wsUrl, null, function (socket) {
    socket.on('open', function () {
      connectionFailures.add(false);
      wsConnected.add(1);

      // Every VU schedules a notification trigger for currentUser using commenterUser's account
      if (commenterUser && commenterUser.token) {
        const staggerMs = 1000 + Math.floor(((__VU - 1) / vusCount) * 25000);
        socket.setTimeout(function () {
          commentPostTime = Date.now();
          const commHeaders = { Authorization: `Bearer ${commenterUser.token}` };
          if (useDirectAuthLocalhost) {
            commHeaders['X-Forwarded-For'] = `10.42.0.${(__VU % 250) + 1}`;
          }
          if (userVideo && userVideo.creator_id === currentUser.id) {
            const postPayload = JSON.stringify({
              body: `Loadtest realtime comment for VU ${__VU} at ${Date.now()}`,
            });
            http.post(`${TARGET_URL}/v1/videos/${userVideo.id}/comments`, postPayload, {
              headers: Object.assign({ 'Content-Type': 'application/json' }, commHeaders),
            });
          } else {
            // Unsubscribe first so the subsequent PUT inserts a new row and fires notification.hint
            http.del(`${TARGET_URL}/v1/channels/${currentUser.id}/subscription`, null, {
              headers: commHeaders,
            });
            http.put(`${TARGET_URL}/v1/channels/${currentUser.id}/subscription`, null, {
              headers: commHeaders,
            });
          }
        }, staggerMs);
      }
    });

    socket.on('message', function (msg) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'event' && parsed.event === 'notification.hint') {
          if (commentPostTime > 0 && !hintReceived) {
            const latency = Date.now() - commentPostTime;
            wsHintLatency.add(latency);
            wsHintSamples.add(1);
            hintReceived = true;
          }
        }
      } catch (err) {
        void err;
      }
    });

    socket.on('error', function () {
      connectionFailures.add(true);
    });

    // Keep WebSocket connection open for test duration
    socket.setTimeout(function () {
      socket.close();
    }, 55000);
  });

  if (!res) {
    connectionFailures.add(true);
  }

  sleep(1);
}
