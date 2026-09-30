import http from 'k6/http';
import { sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const apiErrors = new Rate('api_errors');
const apiDuration = new Trend('api_mix_duration');

export const options = {
  thresholds: {
    api_errors: ['rate<0.05'], // error rate < 5% (safety threshold)
    http_req_duration: ['p(95)<500'], // 95th percentile response time < 500 ms
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

const videos = new SharedArray('videos', function () {
  try {
    const raw = JSON.parse(open('./seed.json'));
    return Array.isArray(raw.videos) ? raw.videos : [];
  } catch (err) {
    void err;
    return [];
  }
});

const users = new SharedArray('users', function () {
  try {
    const raw = JSON.parse(open('./seed.json'));
    return Array.isArray(raw.users) ? raw.users : [];
  } catch (err) {
    void err;
    return [];
  }
});

export default function () {
  const rand = Math.random();
  const selectedVideo = videos.length > 0 ? videos[(__VU + __ITER) % videos.length] : null;
  const selectedUser = users.length > 0 ? users[(__VU - 1) % users.length] : null;

  const authHeaders = selectedUser
    ? {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${selectedUser.token}`,
      }
    : { 'Content-Type': 'application/json' };

  let res;
  const t0 = Date.now();

  if (rand < 0.7) {
    // 70%: feed / watch / search reads
    const readChoice = Math.random();
    if (readChoice < 0.4) {
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    } else if (readChoice < 0.7 && selectedVideo) {
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}`, { headers: authHeaders });
    } else {
      res = http.get(`${TARGET_URL}/v1/videos?sort=trending`, { headers: authHeaders });
    }
  } else if (rand < 0.95) {
    // 25%: like / comment reads
    const socialReadChoice = Math.random();
    if (socialReadChoice < 0.6 && selectedVideo) {
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}/comments`, {
        headers: authHeaders,
      });
    } else if (selectedVideo) {
      res = http.get(`${TARGET_URL}/v1/videos/${selectedVideo.id}/like`, { headers: authHeaders });
    } else {
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    }
  } else {
    // 5%: writes (comment, like) using registered user tokens
    if (!selectedUser || !selectedVideo) {
      res = http.get(`${TARGET_URL}/v1/videos`, { headers: authHeaders });
    } else {
      const writeChoice = Math.random();
      if (writeChoice < 0.5) {
        const payload = JSON.stringify({
          body: `Load test comment ${Date.now().toString(36)}`,
        });
        res = http.post(`${TARGET_URL}/v1/videos/${selectedVideo.id}/comments`, payload, {
          headers: authHeaders,
        });
      } else {
        res = http.put(`${TARGET_URL}/v1/videos/${selectedVideo.id}/like`, null, {
          headers: authHeaders,
        });
      }
    }
  }

  apiDuration.add(Date.now() - t0);
  if (res) {
    apiErrors.add(res.status < 200 || res.status >= 400);
  }

  // Respect rate limits with think time (1.5 to 3.0 seconds)
  sleep(1.5 + Math.random() * 1.5);
}
