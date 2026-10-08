import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
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

  test('Finding 14: Failed token renewal must abort workload, not continue unauthenticated', async () => {
    // When a preseeded user receives a 401 and token renewal fails,
    // the workload must abort / fail fast. It must NOT continue sending
    // subsequent requests with Authorization header omitted (null/unauthenticated continuation).
    let loginAttempts = 0;
    setMockHttpHandler((req) => {
      if (req.url.includes('/v1/auth/login')) {
        loginAttempts++;
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

  test('Finding 15: Ignored collector ACK false: caller must handle lost ACK rather than silently ignoring', () => {
    const src = fs.readFileSync(apiMixModulePath, 'utf8');

    // In current SHA, lines 274-278:
    // sendCommentToCollector({ ... });
    // is called as a bare statement without checking return value:
    // const ackCheck = /if\s*\(\s*!sendCommentToCollector|const\s+\w+\s*=\s*sendCommentToCollector/.test(src);
    const bareCall = /sendCommentToCollector\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/m.test(src);
    const checkedCall =
      /if\s*\(\s*!sendCommentToCollector/.test(src) ||
      /(const|let|var)\s+\w+\s*=\s*sendCommentToCollector/.test(src);

    assert.strictEqual(
      checkedCall,
      true,
      'Workload safety finding: api-mix.js must check the return value of sendCommentToCollector and handle lost ACKs / failed writes',
    );
  });
});
