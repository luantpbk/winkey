import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const originalCleanupPath = path.resolve(repoRoot, 'loadtest', 'cleanup.mjs');

describe('[LT2 Regression] Actual Cleanup & Discovery Contract Verification', () => {
  let server;
  let serverUrl;
  let requestHandler = () => {};
  let tmpDir;
  let accountsFile;
  let commentsFile;
  let isolatedRunCleanup;

  let authMeDeletions = [];
  let commentDeletions = [];
  let loginRequests = [];

  beforeEach(async () => {
    // 1. Give every test case its own isolated snapshot directory: zero shared checkout files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-cleanup-'));
    accountsFile = path.join(tmpDir, 'lt2_accounts.json');
    commentsFile = path.join(tmpDir, 'lt2_comments.json');

    const sampleAccounts = [
      {
        id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
        handle: 'lt2_user1_test',
        email: 'lt2_user1_test@example.com',
      },
    ];
    fs.writeFileSync(accountsFile, JSON.stringify(sampleAccounts, null, 2), 'utf8');

    // Copy cleanup.mjs to isolated directory so __dirname resolves to tmpDir
    const isolatedCleanupScript = path.join(tmpDir, 'cleanup.mjs');
    fs.copyFileSync(originalCleanupPath, isolatedCleanupScript);

    const mod = await import(pathToFileURL(isolatedCleanupScript).href);
    isolatedRunCleanup = mod.runCleanup;

    authMeDeletions = [];
    commentDeletions = [];
    loginRequests = [];

    // 2. Setup loopback server on ephemeral port (strictly 127.0.0.1)
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
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Finding 1: Missing required next_cursor in video listing response must retain author accounts', async () => {
    // OpenAPI contract defines next_cursor as a required property of paginated list responses.
    // If the server response omits next_cursor, cleanup must fail-closed (discovery incomplete)
    // and assert zero DELETE /v1/auth/me requests.
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        // Return valid items array but OMIT required next_cursor field completely
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      } else if (url.pathname === '/v1/auth/login') {
        loginRequests.push(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock-token' }));
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    // In current SHA, omission of next_cursor does not set discoveryIncomplete = true,
    // so it proceeds to login and issue DELETE /v1/auth/me!
    assert.strictEqual(
      authMeDeletions.length,
      0,
      'Contract violation: when next_cursor is omitted from video listing, zero DELETE /v1/auth/me must be called',
    );
    assert.strictEqual(
      fs.existsSync(accountsFile) && result.failedAccounts.length > 0,
      true,
      'Author accounts must be retained in journal file for retry',
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
        // Return valid comment items but OMIT required next_cursor property
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [{ id: 'com-1', authorHandle: 'lt2_user1_test' }],
          }),
        );
      } else if (url.pathname === '/v1/auth/login') {
        loginRequests.push(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock-token' }));
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    assert.strictEqual(
      authMeDeletions.length,
      0,
      'Contract violation: when next_cursor is omitted from comment listing, zero DELETE /v1/auth/me must be called',
    );
    assert.strictEqual(
      fs.existsSync(accountsFile) && result.failedAccounts.length > 0,
      true,
      'Author accounts must be retained in journal file for retry',
    );
  });

  test('Numeric next_cursor in video listing is rejected and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'vid-1' }], next_cursor: 123 }));
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    assert.strictEqual(authMeDeletions.length, 0, 'Must NOT attempt DELETE /v1/auth/me');
    assert.strictEqual(result.failedAccounts.length > 0 && fs.existsSync(accountsFile), true);
  });

  test('Malformed video record (missing id) is rejected and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: 'no id field' }], next_cursor: null }));
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    assert.strictEqual(authMeDeletions.length, 0, 'Must NOT attempt DELETE /v1/auth/me');
    assert.strictEqual(result.failedAccounts.length > 0 && fs.existsSync(accountsFile), true);
  });

  test('Discovery deadline timeout check before deletion aborts account deletion', async () => {
    requestHandler = async (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        // Delay to exceed 50ms discovery deadline
        await new Promise((r) => setTimeout(r, 60));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], next_cursor: null }));
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 50,
    });

    assert.strictEqual(authMeDeletions.length, 0, 'Must NOT attempt DELETE /v1/auth/me');
    assert.strictEqual(result.failedAccounts.length > 0 && fs.existsSync(accountsFile), true);
  });

  test('Hung HTTP response body triggers AbortSignal and retains author accounts', async () => {
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"items": [');
        // Do not close body to trigger timeout
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 100,
    });

    assert.strictEqual(authMeDeletions.length, 0, 'Must NOT attempt DELETE /v1/auth/me');
    assert.strictEqual(result.failedAccounts.length > 0 && fs.existsSync(accountsFile), true);
  });

  test('Contract Teardown: fully valid discovery completes and executes DELETE /v1/auth/me returning 204', async () => {
    // When discovery payload and cursors are fully contract-compliant,
    // cleanup must delete user comments and delete account via DELETE /v1/auth/me returning 204.
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'vid-1' }], next_cursor: null }));
      } else if (url.pathname === '/v1/videos/vid-1/comments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [{ id: 'com-1', authorHandle: 'lt2_user1_test' }],
            next_cursor: null,
          }),
        );
      } else if (url.pathname === '/v1/auth/login') {
        loginRequests.push(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'valid-fresh-token' }));
      } else if (url.pathname === '/v1/comments/com-1' && req.method === 'DELETE') {
        commentDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else if (url.pathname === '/v1/auth/me' && req.method === 'DELETE') {
        authMeDeletions.push(req);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    };

    const result = await isolatedRunCleanup({
      targetUrl: serverUrl,
      password: 'test-password',
      discoveryTimeoutMs: 5000,
    });

    assert.strictEqual(authMeDeletions.length, 1, 'Exactly one DELETE /v1/auth/me call expected');
    assert.strictEqual(commentDeletions.length, 1, 'Comment com-1 must be deleted');
    assert.strictEqual(result.failedAccounts.length, 0, 'No failed accounts');
    assert.strictEqual(
      fs.existsSync(accountsFile),
      false,
      'lt2_accounts.json unlinked on clean exit',
    );
  });
});
