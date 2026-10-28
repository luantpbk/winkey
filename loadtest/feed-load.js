/* global __ENV, __VU, open */
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const followingDuration = new Trend('following_feed_duration', true);
const exploreDuration = new Trend('explore_feed_duration', true);
const writeDuration = new Trend('write_duration', true);
const postErrors = new Rate('post_errors');
const followingRequests = new Counter('following_feed_requests');
const exploreRequests = new Counter('explore_feed_requests');
const writeRequests = new Counter('write_requests');

export const options = {
  thresholds: {
    // Edge SLA target: p95 getFollowingFeed < 150 ms, error rate < 0.5%
    following_feed_duration: ['p(95)<150'],
    explore_feed_duration: ['p(95)<200'],
    post_errors: ['rate<0.005'],
    http_req_failed: ['rate<0.005'],
  },
  scenarios: {
    feed_load: {
      executor: 'constant-vus',
      vus: __ENV.VUS ? parseInt(__ENV.VUS, 10) : 20,
      duration: __ENV.DURATION || '1m',
    },
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://127.0.0.1:8080';

const seedData = (function () {
  try {
    return JSON.parse(open('./seed-feeds.json'));
  } catch (err) {
    void err;
    return { users: [], postIds: [] };
  }
})();

const users = new SharedArray('users', function () {
  return Array.isArray(seedData.users) ? seedData.users : [];
});

const postIds = new SharedArray('postIds', function () {
  return Array.isArray(seedData.postIds) ? seedData.postIds : [];
});

export default function () {
  if (users.length === 0) {
    sleep(1);
    return;
  }

  // Pick user for this VU
  const user = users[(__VU - 1) % users.length];
  const authHeaders = {
    Authorization: `Bearer ${user.token}`,
    Accept: 'application/json',
  };

  const rand = Math.random();

  // 1. 80% getFollowingFeed (first page + 2 next pages using next_cursor)
  if (rand < 0.8) {
    followingRequests.add(1);
    const t0 = Date.now();
    const res1 = http.get(`${TARGET_URL}/v1/feed/following?limit=20`, {
      headers: authHeaders,
      tags: { endpoint: 'GET /v1/feed/following' },
    });
    followingDuration.add(Date.now() - t0);

    const ok1 = check(res1, {
      'following feed page 1 status 200': (r) => r.status === 200,
    });
    postErrors.add(!ok1);

    if (ok1) {
      try {
        const body1 = JSON.parse(res1.body);
        const cursor1 = body1.next_cursor;
        if (cursor1) {
          // Page 2
          followingRequests.add(1);
          const t1 = Date.now();
          const res2 = http.get(
            `${TARGET_URL}/v1/feed/following?limit=20&cursor=${encodeURIComponent(cursor1)}`,
            { headers: authHeaders, tags: { endpoint: 'GET /v1/feed/following?cursor' } },
          );
          followingDuration.add(Date.now() - t1);

          const ok2 = check(res2, {
            'following feed page 2 status 200': (r) => r.status === 200,
          });
          postErrors.add(!ok2);

          if (ok2) {
            const body2 = JSON.parse(res2.body);
            const cursor2 = body2.next_cursor;
            if (cursor2) {
              // Page 3
              followingRequests.add(1);
              const t2 = Date.now();
              const res3 = http.get(
                `${TARGET_URL}/v1/feed/following?limit=20&cursor=${encodeURIComponent(cursor2)}`,
                { headers: authHeaders, tags: { endpoint: 'GET /v1/feed/following?cursor' } },
              );
              followingDuration.add(Date.now() - t2);

              const ok3 = check(res3, {
                'following feed page 3 status 200': (r) => r.status === 200,
              });
              postErrors.add(!ok3);
            }
          }
        }
      } catch (err) {
        void err;
      }
    }
  }
  // 2. 15% getExploreFeed
  else if (rand < 0.95) {
    exploreRequests.add(1);
    const t0 = Date.now();
    const res = http.get(`${TARGET_URL}/v1/feed/explore?limit=20`, {
      headers: authHeaders,
      tags: { endpoint: 'GET /v1/feed/explore' },
    });
    exploreDuration.add(Date.now() - t0);

    const ok = check(res, {
      'explore feed status 200': (r) => r.status === 200,
    });
    postErrors.add(!ok);
  }
  // 3. 5% createPost / setPostReaction
  else {
    writeRequests.add(1);
    const isCreate = Math.random() < 0.5;
    if (isCreate) {
      const t0 = Date.now();
      const payload = JSON.stringify({
        body: `Tải thử nghiệm bài viết lúc ${Date.now()} #winkey`,
        visibility: 'PUBLIC',
      });
      const res = http.post(`${TARGET_URL}/v1/posts`, payload, {
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        tags: { endpoint: 'POST /v1/posts' },
      });
      writeDuration.add(Date.now() - t0);

      const ok = check(res, {
        'create post status 201': (r) => r.status === 201,
      });
      postErrors.add(!ok);
    } else {
      if (postIds.length > 0) {
        const targetPostId = postIds[Math.floor(Math.random() * postIds.length)];
        const t0 = Date.now();
        const payload = JSON.stringify({ reaction: 'LIKE' });
        const res = http.put(`${TARGET_URL}/v1/posts/${targetPostId}/reaction`, payload, {
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          tags: { endpoint: 'PUT /v1/posts/:id/reaction' },
        });
        writeDuration.add(Date.now() - t0);

        const ok = check(res, {
          'set reaction status 200': (r) => r.status === 200,
        });
        postErrors.add(!ok);
      }
    }
  }

  // Realistic feed browsing pacing between requests (200-500ms)
  sleep(0.2 + Math.random() * 0.3);
}
