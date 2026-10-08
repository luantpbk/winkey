import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanup } from '../../../loadtest/cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadtestDir = path.resolve(__dirname, '../../../loadtest');
const accountsFile = path.join(loadtestDir, 'lt2_accounts.json');
const commentsFile = path.join(loadtestDir, 'lt2_comments.json');

describe('[LT2 Regression] Actual Cleanup & Discovery Contract Verification', () => {
  let server;
  let serverUrl;
  let requestHandler = () => {};

  beforeEach(async () => {
    // Setup test accounts file
    const sampleAccounts = [
      {
        id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
        handle: 'lt2_user1_test',
        email: 'lt2_user1_test@example.com',
      },
    ];
    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2), 'utf8');
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);

    // Setup local loopback server
    await new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestHandler(req, res);
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
  });

  test('Finding 1: Missing required next_cursor in video listing response must retain author accounts', async () => {
    // OpenAPI contract defines next_cursor as a required property of paginated list responses.
    // If the server response omits next_cursor, cleanup must fail-closed (discovery incomplete)
    // and preserve test accounts, NOT delete them.
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        // Return valid empty items but OMIT required next_cursor field completely
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      } else if (url.pathname === '/v1/auth/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock-token' }));
      } else if (url.pathname === '/v1/users/me') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(
      authorRetained,
      true,
      'Contract violation: when next_cursor is omitted from video listing, author MUST NOT be deleted (fail-closed retention)',
    );
  });

  test('Finding 2: Missing required next_cursor in comment listing response must retain author accounts', async () => {
    // If comment listing omits required next_cursor property, discovery must be incomplete.
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'vid-1' }], next_cursor: null }));
      } else if (url.pathname === '/v1/videos/vid-1/comments') {
        // Return valid comment items but OMIT required next_cursor
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [{ id: 'com-1', authorHandle: 'lt2_user1_test' }],
          }),
        );
      } else if (url.pathname === '/v1/auth/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock-token' }));
      } else if (url.pathname === '/v1/users/me') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(
      authorRetained,
      true,
      'Contract violation: when next_cursor is omitted from comment listing, author MUST NOT be deleted',
    );
  });

  test('Numeric next_cursor in video listing is rejected and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'vid-1' }], next_cursor: 123 }));
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(authorRetained, true);
    assert.strictEqual(result.failedAccounts.length, 1);
  });

  test('Malformed video record (missing id) is rejected and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: 'video without id' }], next_cursor: null }));
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(authorRetained, true);
    assert.strictEqual(result.failedAccounts.length, 1);
  });

  test('Discovery deadline timeout check before deletion aborts account deletion', async () => {
    // If discovery phase exceeds timeout, pre-deletion deadline check must retain accounts
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: [{ id: 'vid-1' }], next_cursor: null }));
        }, 120);
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 50,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(authorRetained, true);
    assert.strictEqual(result.failedAccounts.length, 1);
  });

  test('Hung HTTP response body triggers AbortSignal and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"items": [');
        // Do not close response, stall indefinitely
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await runCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 100,
    });

    const authorRetained = result.failedAccounts.length > 0 && fs.existsSync(accountsFile);
    assert.strictEqual(authorRetained, true);
    assert.strictEqual(result.failedAccounts.length, 1);
  });
});
