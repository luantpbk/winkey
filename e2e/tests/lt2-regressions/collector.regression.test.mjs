import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorServer } from '../../../loadtest/comment-collector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadtestDir = path.resolve(__dirname, '../../../loadtest');
const commentsFile = path.join(loadtestDir, 'lt2_comments.json');

function sendPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('[LT2 Regression] Actual Comment Collector Validation & Security', () => {
  let server;
  let serverPort;

  beforeEach(async () => {
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
    server = createCollectorServer();
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (fs.existsSync(commentsFile)) fs.unlinkSync(commentsFile);
  });

  test('Finding 3: Missing comment id must be rejected with HTTP 400, not 200 OK', async () => {
    // If request omits comment id, collector must NOT acknowledge with 200 OK.
    const res = await sendPost(`http://127.0.0.1:${serverPort}/comment`, {
      authorEmail: 'test@example.com',
      authorHandle: 'lt2_user1',
    });

    assert.strictEqual(
      res.status,
      400,
      'Collector must return HTTP 400 Bad Request when comment id is missing',
    );
  });

  test('Finding 4: Invalid non-string or empty comment id must be rejected with HTTP 400', async () => {
    const resNumeric = await sendPost(`http://127.0.0.1:${serverPort}/comment`, {
      id: 12345,
      authorEmail: 'test@example.com',
    });
    assert.strictEqual(
      resNumeric.status,
      400,
      'Collector must reject numeric comment id with HTTP 400',
    );

    const resEmpty = await sendPost(`http://127.0.0.1:${serverPort}/comment`, {
      id: '',
      authorEmail: 'test@example.com',
    });
    assert.strictEqual(
      resEmpty.status,
      400,
      'Collector must reject empty comment id with HTTP 400',
    );
  });

  test('Finding 5: Bounded input: oversized payload (>64KB) must be rejected', async () => {
    // Unbounded body buffering is vulnerable to memory exhaustion.
    const largePayload = {
      id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
      junk: 'X'.repeat(70 * 1024), // 70 KB
    };

    const res = await sendPost(`http://127.0.0.1:${serverPort}/comment`, largePayload);

    assert.ok(
      res.status === 400 || res.status === 413,
      `Collector must reject oversized payload with 400 or 413 (got ${res.status})`,
    );
  });

  test('Finding 6: File permissions on persisted comments file must be atomic 0600', async () => {
    // On POSIX systems, comments journal must be private (0600) to protect user metadata.
    if (process.platform === 'win32') {
      // Windows NTFS does not use POSIX permission bits, check creation succeeded
      return;
    }

    await sendPost(`http://127.0.0.1:${serverPort}/comment`, {
      id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
      authorEmail: 'test@example.com',
    });

    assert.ok(fs.existsSync(commentsFile), 'comments file must exist after posting');
    const stat = fs.statSync(commentsFile);
    const mode = stat.mode & 0o777;
    assert.strictEqual(
      mode,
      0o600,
      `comments file must have 0600 permissions for data privacy (got ${mode.toString(8)})`,
    );
  });

  test('Finding 7: Standalone collector must bind to 127.0.0.1 (loopback), never 0.0.0.0', () => {
    // Inspect source code of comment-collector.mjs to ensure standalone listen binds strictly to 127.0.0.1
    const src = fs.readFileSync(path.join(loadtestDir, 'comment-collector.mjs'), 'utf8');
    const hasWildcardListen = src.includes("'0.0.0.0'") || src.includes('"0.0.0.0"');
    assert.strictEqual(
      hasWildcardListen,
      false,
      "Security violation: comment-collector.mjs must bind to '127.0.0.1', never public '0.0.0.0'",
    );
  });
});
