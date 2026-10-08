import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use controlled module adapter for k6 imports
import { setMockHttpHandler, resetHttpState, httpCalls } from '../adapters/k6-http.mjs';
import { resetCoreState, lastFailedMessage } from '../adapters/k6-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const apiMixModulePath = path.join(repoRoot, 'loadtest', 'api-mix.js');

describe('[LT2 Regression] Actual API-Mix Workload Safety Verification', () => {
  let apiMixModule;

  beforeEach(async () => {
    resetHttpState();
    resetCoreState();
    if (!apiMixModule) {
      apiMixModule = await import(pathToFileURL(apiMixModulePath).href);
    }
  });

  test('Finding 14: Failed token renewal must abort workload, not continue unauthenticated', () => {
    // When a preseeded user receives a 401 and token renewal fails,
    // the workload must abort / fail fast. It must NOT continue sending
    // subsequent requests with Authorization header omitted (null/unauthenticated continuation).
    setMockHttpHandler((req) => {
      if (req.url.includes('/v1/auth/login')) {
        // Simulate renewal failure: returns 401 Unauthorized
        return { status: 401, body: JSON.stringify({ error: 'invalid credentials' }) };
      }
      if (req.url.includes('/v1/videos')) {
        return {
          status: 200,
          body: JSON.stringify({ items: [{ id: 'video-1' }] }),
          headers: {},
        };
      }
      return { status: 200, body: '{}' };
    });

    const userWithStaleToken = {
      id: 'user-1',
      handle: 'lt2_user1',
      email: 'lt2_user1@example.com',
      token: null, // needs renewal
    };

    const mockData = {
      users: [userWithStaleToken],
      videos: [{ id: 'video-1' }],
    };

    // Execute the actual default workload function from api-mix.js
    let threwError = false;
    try {
      apiMixModule.default(mockData);
    } catch {
      threwError = true;
    }

    // Check whether requests were sent without Authorization header
    const unauthenticatedCalls = httpCalls.filter(
      (c) =>
        !c.url.includes('/v1/auth/login') &&
        (!c.params || !c.params.headers || !c.params.headers.Authorization),
    );

    assert.strictEqual(
      threwError || lastFailedMessage !== null,
      true,
      'Workload safety finding: api-mix.js must abort/fail fast when token renewal fails, rather than continuing silently with null token',
    );
    assert.strictEqual(
      unauthenticatedCalls.length,
      0,
      'Workload safety finding: api-mix.js must NOT send unauthenticated requests after renewal failure',
    );
  });

  test('Finding 15: Ignored collector ACK: workload must handle lost ACK rather than silently ignoring failure', () => {
    // Deterministically force the comment-writing branch:
    const originalRandom = Math.random;
    let randomCallCount = 0;
    Math.random = () => {
      randomCallCount++;
      if (randomCallCount === 1) return 0.98; // Action roll -> 5% write action
      if (randomCallCount === 2) return 0.2; // Write choice -> POST comment
      return 0.5;
    };

    let collectorPostCount = 0;
    setMockHttpHandler((req) => {
      if (req.url.includes('/v1/videos') && req.url.includes('/comments')) {
        return {
          status: 201,
          body: JSON.stringify({ id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001' }),
        };
      }
      if (req.url.includes('/comment')) {
        collectorPostCount++;
        // Collector fails (e.g. 500 error / offline): ACK is not returned
        return { status: 500, body: '{"error":"collector error"}' };
      }
      return { status: 200, body: '{}' };
    });

    const mockData = {
      users: [
        {
          id: 'user-1',
          handle: 'lt2_user1',
          email: 'lt2_user1@example.com',
          token: 'valid-test-token',
        },
      ],
      videos: [{ id: 'video-1' }],
    };

    let threwError = false;
    try {
      apiMixModule.default(mockData);
    } catch {
      threwError = true;
    } finally {
      Math.random = originalRandom;
    }

    // Verify sendCommentToCollector was actually invoked and retried 3 times
    assert.strictEqual(
      collectorPostCount >= 3,
      true,
      'sendCommentToCollector must attempt delivery with retries',
    );

    // In current SHA, the caller ignores the return value of sendCommentToCollector,
    // so threwError is false and lastFailedMessage is null (lost ACK silently swallowed).
    // The workload must abort / fail fast when comment ACK is lost to prevent data leaks.
    assert.strictEqual(
      threwError || lastFailedMessage !== null,
      true,
      'Workload safety finding: api-mix.js must check the return value of sendCommentToCollector and handle lost ACKs / failed writes',
    );
  });
});
