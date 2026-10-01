/* global __ENV, __VU, open */
import http from 'k6/http';
import ws from 'k6/ws';
import { sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const connectionFailures = new Rate('connection_failures');
const wsConnected = new Counter('ws_connected');
const wsHintLatency = new Trend('ws_hint_latency');

export const options = {
  setupTimeout: '3m',
  thresholds: {
    connection_failures: ['rate<0.05'], // < 5% failure rate
    ws_hint_latency: ['p(95)<1000'], // p95 latency < 1s
  },
  scenarios: {
    realtime_ws: {
      executor: 'constant-vus',
      vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 200,
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
      if (u.token) {
        freshUsers.push(u);
        continue;
      }
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
          sleep(1.0);
        } else {
          break;
        }
      }

      if (!loggedIn) {
        freshUsers.push(u);
      }
    }
    return { users: freshUsers };
  } catch (err) {
    void err;
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
  const authHeaders = { Authorization: `Bearer ${currentUser.token}` };

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

  const res = ws.connect(wsUrl, null, function (socket) {
    socket.on('open', function () {
      connectionFailures.add(false);
      wsConnected.add(1);

      // VU 1 performs comment trigger after 3 seconds using User B's token on User A's video
      // to measure exact end-to-end hint latency in the same VU context
      if (__VU === 1 && videos.length > 0 && userPool.length > 1) {
        socket.setTimeout(function () {
          const targetVid = videos[0];
          const userB = userPool[1];
          const postPayload = JSON.stringify({
            body: `Loadtest realtime comment ${Date.now().toString(36)}`,
          });
          commentPostTime = Date.now();
          http.post(`${TARGET_URL}/v1/videos/${targetVid.id}/comments`, postPayload, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${userB.token}`,
            },
          });
        }, 3000);
      }
    });

    socket.on('message', function (msg) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'event' && parsed.event === 'notification.hint') {
          if (commentPostTime > 0) {
            const latency = Date.now() - commentPostTime;
            wsHintLatency.add(latency);
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
