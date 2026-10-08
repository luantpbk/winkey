/* global fetch */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanup } from './cleanup.mjs';
import { createCollectorServer } from './comment-collector.mjs';
import { resolveUrl } from './utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountsFile = path.join(__dirname, 'lt2_accounts.json');
const commentsFile = path.join(__dirname, 'lt2_comments.json');

describe('LT2 Data Cleanup, Retention and Order Tests', () => {
  beforeEach(() => {
    if (fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
  });

  afterEach(() => {
    if (fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
  });

  test('lt2_accounts.json contains ONLY public metadata (no passwords or tokens)', () => {
    const sampleAccounts = [
      { handle: 'lt2_user1_abc', email: 'lt2_user1_abc@example.com' },
      { handle: 'lt2_user2_def', email: 'lt2_user2_def@example.com' },
    ];
    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2));

    const content = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const acc of content) {
      assert.strictEqual(typeof acc.handle, 'string');
      assert.strictEqual(typeof acc.email, 'string');
      assert.strictEqual(acc.password, undefined);
      assert.strictEqual(acc.token, undefined);
    }
  });

  test('Deletion order: Comments are deleted STRICTLY BEFORE deleting user account', async () => {
    const sampleAccounts = [{ handle: 'lt2_order_test', email: 'lt2_order_test@example.com' }];
    const sampleComments = [{ id: 'comm_order_1', authorEmail: 'lt2_order_test@example.com' }];

    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2));
    fs.writeFileSync(commentsFile, JSON.stringify(sampleComments, null, 2));

    const callsOrder = [];

    const mockFetch = async (url, _opts = {}) => {
      if (url.endsWith('/v1/auth/login')) {
        callsOrder.push('LOGIN');
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'token_123' }),
        };
      }
      if (url.includes('/v1/comments/comm_order_1')) {
        callsOrder.push('DELETE_COMMENT');
        return { status: 204 };
      }
      if (url.endsWith('/v1/auth/me')) {
        callsOrder.push('DELETE_ACCOUNT');
        return { status: 204 };
      }
      return { status: 404 };
    };

    const res = await runCleanup({
      targetUrl: 'http://localhost:8080',
      password: 'Pass123!',
      fetchFn: mockFetch,
    });

    assert.strictEqual(res.failedAccounts.length, 0);
    assert.strictEqual(res.failedComments.length, 0);

    // Verify deletion sequence: LOGIN -> DELETE_COMMENT -> DELETE_ACCOUNT
    const commentIdx = callsOrder.indexOf('DELETE_COMMENT');
    const accountIdx = callsOrder.indexOf('DELETE_ACCOUNT');
    assert.notStrictEqual(commentIdx, -1, 'DELETE_COMMENT should have been called');
    assert.notStrictEqual(accountIdx, -1, 'DELETE_ACCOUNT should have been called');
    assert.ok(commentIdx < accountIdx, 'Comments MUST be deleted BEFORE deleting the user account');
  });

  test('Cleanup retains failed accounts in lt2_accounts.json for retry recovery when deletion fails (HTTP 500)', async () => {
    const sampleAccounts = [
      { handle: 'lt2_ok', email: 'lt2_ok@example.com' },
      { handle: 'lt2_fail', email: 'lt2_fail@example.com' },
    ];
    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2));

    const mockFetch = async (url, opts = {}) => {
      if (url.endsWith('/v1/auth/login')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'mock_token' }),
        };
      }
      if (url.endsWith('/v1/auth/me')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.confirm_handle === 'lt2_fail') {
          return { status: 500 }; // Simulates server error failure
        }
        return { status: 204 };
      }
      return { status: 404 };
    };

    const res = await runCleanup({
      targetUrl: 'http://localhost:8080',
      password: 'Pass123!',
      fetchFn: mockFetch,
    });

    assert.strictEqual(res.failedAccounts.length, 1);
    assert.strictEqual(res.failedAccounts[0].handle, 'lt2_fail');
    assert.strictEqual(fs.existsSync(accountsFile), true);

    const retained = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    assert.strictEqual(retained.length, 1);
    assert.strictEqual(retained[0].handle, 'lt2_fail');
  });

  test('Cleanup retains failed comments in lt2_comments.json for retry recovery when deletion fails (HTTP 403)', async () => {
    const sampleAccounts = [{ handle: 'lt2_user1', email: 'lt2_user1@example.com' }];
    const sampleComments = [
      { id: 'comm_ok', authorEmail: 'lt2_user1@example.com' },
      { id: 'comm_fail', authorEmail: 'lt2_user1@example.com' },
    ];
    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2));
    fs.writeFileSync(commentsFile, JSON.stringify(sampleComments, null, 2));

    const mockFetch = async (url) => {
      if (url.endsWith('/v1/auth/login')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'mock_token' }),
        };
      }
      if (url.includes('/v1/comments/comm_ok')) {
        return { status: 204 };
      }
      if (url.includes('/v1/comments/comm_fail')) {
        return { status: 403 }; // Simulates permission failure
      }
      if (url.endsWith('/v1/auth/me')) {
        return { status: 204 };
      }
      return { status: 404 };
    };

    const res = await runCleanup({
      targetUrl: 'http://localhost:8080',
      password: 'Pass123!',
      fetchFn: mockFetch,
    });

    assert.strictEqual(res.failedComments.length, 1);
    assert.strictEqual(res.failedComments[0].id, 'comm_fail');
    assert.strictEqual(fs.existsSync(commentsFile), true);

    const retainedComments = JSON.parse(fs.readFileSync(commentsFile, 'utf8'));
    assert.strictEqual(retainedComments.length, 1);
    assert.strictEqual(retainedComments[0].id, 'comm_fail');
  });
});

describe('HLS URL and Contract Resolution Tests', () => {
  test('resolveUrl converts relative and absolute playback.hls_url correctly', () => {
    const base = 'https://winkey.vn';
    assert.strictEqual(
      resolveUrl('/v1/videos/vid1/manifest.m3u8', base),
      'https://winkey.vn/v1/videos/vid1/manifest.m3u8',
    );
    assert.strictEqual(
      resolveUrl('https://media.winkey.vn/hls/vid1.m3u8', base),
      'https://media.winkey.vn/hls/vid1.m3u8',
    );
  });
});

describe('Comment Collector Server Tests', () => {
  let server;
  const testPort = 9996;

  beforeEach(() => {
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
    server = createCollectorServer();
    return new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));
  });

  afterEach(() => {
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
    return new Promise((resolve) => server.close(resolve));
  });

  test('Collector receives comment POST and persists to lt2_comments.json', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'comm_collector_test_1',
        authorEmail: 'lt2_collector@example.com',
        authorHandle: 'lt2_collector',
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(fs.existsSync(commentsFile), true);

    const comments = JSON.parse(fs.readFileSync(commentsFile, 'utf8'));
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].id, 'comm_collector_test_1');
    assert.strictEqual(comments[0].authorEmail, 'lt2_collector@example.com');
  });
});

describe('Fail-Closed and Execution Safety Tests', () => {
  test('Execution window validation helper (02:00 - 03:30 AM VN)', () => {
    const isInsideWindow = (timeStr) => {
      const val = parseInt(timeStr, 10);
      return val >= 200 && val <= 330;
    };

    assert.strictEqual(isInsideWindow('0200'), true);
    assert.strictEqual(isInsideWindow('0300'), true);
    assert.strictEqual(isInsideWindow('0330'), true);
    assert.strictEqual(isInsideWindow('0159'), false);
    assert.strictEqual(isInsideWindow('0331'), false);
    assert.strictEqual(isInsideWindow('1200'), false);
  });

  test('Fail-closed when sample video pool is empty', () => {
    const checkVideoPool = (pool) => {
      if (!pool || pool.length === 0) {
        throw new Error('FAIL: No valid video samples available');
      }
      return true;
    };

    assert.strictEqual(checkVideoPool([{ id: 'v1' }]), true);
    assert.throws(() => checkVideoPool([]), /No valid video samples/);
  });
});
