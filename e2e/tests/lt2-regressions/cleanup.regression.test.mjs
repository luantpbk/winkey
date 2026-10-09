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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertValidUuid(uuid, field) {
  assert.ok(
    typeof uuid === 'string' && UUID_REGEX.test(uuid),
    `${field} must be a valid RFC 4122 UUID, got: ${uuid}`,
  );
}

// Contract-compliant schema builders per contracts/openapi/common.yaml, video.v1.yaml, social.v1.yaml
function makeValidProfile(opts = {}) {
  return {
    id: opts.id || '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
    handle: opts.handle || 'lt2_user1_test',
    display_name: opts.display_name || 'LT2 Test User',
    avatar_url: opts.avatar_url || 'https://assets.winkey.vn/avatars/test.jpg',
  };
}

function makeValidVideoSummary(opts = {}) {
  return {
    id: opts.id || '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
    title: opts.title || 'LT2 Test Video Title',
    owner: opts.owner || makeValidProfile(),
    duration_ms: opts.duration_ms || 120000,
    view_count: opts.view_count || 100,
    published_at: opts.published_at || '2026-10-08T12:00:00Z',
    thumbnail_url: opts.thumbnail_url || 'https://assets.winkey.vn/thumbs/test.jpg',
    ...opts,
  };
}

function makeValidComment(opts = {}) {
  return {
    id: opts.id || '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    video_id: opts.video_id || '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
    parent_id: null,
    author: opts.author || makeValidProfile(),
    body: opts.body || 'LT2 contract test comment body',
    status: 'VISIBLE',
    reply_count: 0,
    created_at: opts.created_at || '2026-10-08T12:05:00Z',
    edited_at: null,
    can_edit: true,
    can_delete: true,
    ...opts,
  };
}

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

  test('Contract Fixture Smoke Validation: structural property, UUID, and ISO timestamp coverage per OpenAPI', () => {
    // Note: covers structural presence, UUID format, and RFC 3339 timestamps for fixtures used in tests.
    const profile = makeValidProfile();
    assertValidUuid(profile.id, 'profile.id');
    assert.strictEqual(/^[A-Za-z0-9_.]{3,30}$/.test(profile.handle), true);

    const video = makeValidVideoSummary();
    assertValidUuid(video.id, 'video.id');
    assertValidUuid(video.owner.id, 'video.owner.id');
    assert.strictEqual(typeof video.title, 'string');
    assert.strictEqual(typeof video.duration_ms, 'number');
    assert.strictEqual(typeof video.thumbnail_url, 'string');
    assert.strictEqual(new Date(video.created_at).toISOString(), video.created_at);
    assert.strictEqual(new Date(video.updated_at).toISOString(), video.updated_at);

    const comment = makeValidComment();
    assertValidUuid(comment.id, 'comment.id');
    assertValidUuid(comment.video_id, 'comment.video_id');
    assertValidUuid(comment.author.id, 'comment.author.id');
    assert.strictEqual(comment.video_id, video.id);
    assert.strictEqual(typeof comment.body, 'string');
    assert.strictEqual(new Date(comment.created_at).toISOString(), comment.created_at);
  });

  test('Finding 1: Missing required next_cursor in video listing response must retain author accounts', async () => {
    // Contract baseline: fully valid VideoSummary record, changing exactly ONE field:
    // omit next_cursor property completely (violating OpenAPI required next_cursor).
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Fully valid items array of VideoSummary records, but next_cursor is omitted
        res.end(
          JSON.stringify({
            items: [makeValidVideoSummary()],
            // next_cursor is deliberately omitted
          }),
        );
      } else if (url.pathname.includes('/comments')) {
        // Valid comments page to isolate the video next_cursor defect
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], next_cursor: null }));
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

    // In current SHA 59d81f3, omission of next_cursor does not set discoveryIncomplete = true,
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
    // Contract baseline: fully valid VideoSummary and Comment records, changing exactly ONE field:
    // omit next_cursor property from comment listing response.
    const validVideo = makeValidVideoSummary();
    const validComment = makeValidComment({ video_id: validVideo.id });

    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [validVideo], next_cursor: null }));
      } else if (url.pathname === `/v1/videos/${validVideo.id}/comments`) {
        // Fully valid Comment items, but next_cursor property is omitted
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [validComment],
            // next_cursor is deliberately omitted
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
    // Fully valid VideoSummary record, changing exactly ONE field: next_cursor is number (123) instead of string/null
    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [makeValidVideoSummary()], next_cursor: 123 }));
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
    // Fully valid VideoSummary record, changing exactly ONE field: id is undefined
    const malformedVideo = makeValidVideoSummary();
    delete malformedVideo.id;

    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [malformedVideo], next_cursor: null }));
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
        res.end(JSON.stringify({ items: [makeValidVideoSummary()], next_cursor: null }));
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
    // Positive control: 100% valid VideoSummary and Comment records per OpenAPI schema,
    // with next_cursor: null. Cleanup must proceed to delete comment and delete account.
    const validVideo = makeValidVideoSummary();
    const validComment = makeValidComment({ video_id: validVideo.id });

    requestHandler = (req, res) => {
      const url = new URL(req.url, serverUrl);
      if (url.pathname === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [validVideo], next_cursor: null }));
      } else if (url.pathname === `/v1/videos/${validVideo.id}/comments`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [validComment],
            next_cursor: null,
          }),
        );
      } else if (url.pathname === '/v1/auth/login') {
        loginRequests.push(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'valid-fresh-token' }));
      } else if (url.pathname === `/v1/comments/${validComment.id}` && req.method === 'DELETE') {
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
    assert.strictEqual(commentDeletions.length, 1, `Comment ${validComment.id} must be deleted`);
    assert.strictEqual(result.failedAccounts.length, 0, 'No failed accounts');
    assert.strictEqual(
      fs.existsSync(accountsFile),
      false,
      'lt2_accounts.json unlinked on clean exit',
    );
  });
});
