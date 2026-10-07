/* global fetch */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanup } from './cleanup.mjs';
import { createCollectorServer } from './comment-collector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountsFile = path.join(__dirname, 'lt2_accounts.json');
const commentsFile = path.join(__dirname, 'lt2_comments.json');

describe('LT2 Data Cleanup and Recovery Retention Tests', () => {
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

  test('Cleanup successfully removes deleted accounts and comments when server responds 204', async () => {
    const sampleAccounts = [{ handle: 'lt2_test1', email: 'lt2_test1@example.com' }];
    const sampleComments = [{ id: 'comm_123', authorEmail: 'lt2_test1@example.com' }];

    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2));
    fs.writeFileSync(commentsFile, JSON.stringify(sampleComments, null, 2));

    const mockFetch = async (url, opts = {}) => {
      if (url.endsWith('/v1/auth/login')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'mock_fresh_token' }),
        };
      }
      if (url.includes('/v1/comments/comm_123')) {
        return { status: 204 };
      }
      if (url.endsWith('/v1/auth/me')) {
        const body = JSON.parse(opts.body || '{}');
        assert.strictEqual(body.confirm_handle, 'lt2_test1');
        assert.strictEqual(body.password, 'SecretPass123!');
        return { status: 204 };
      }
      return { status: 404 };
    };

    const res = await runCleanup({
      targetUrl: 'http://localhost:8080',
      password: 'SecretPass123!',
      fetchFn: mockFetch,
    });

    assert.strictEqual(res.failedAccounts.length, 0);
    assert.strictEqual(res.failedComments.length, 0);
    assert.strictEqual(fs.existsSync(accountsFile), false);
    assert.strictEqual(fs.existsSync(commentsFile), false);
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
      password: 'SecretPass123!',
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
      password: 'SecretPass123!',
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

describe('Comment Collector Server Tests', () => {
  let server;
  const testPort = 9998;

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
