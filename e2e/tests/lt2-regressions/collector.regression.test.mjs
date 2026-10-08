import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const originalCollectorPath = path.resolve(repoRoot, 'loadtest', 'comment-collector.mjs');

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

function getNonLoopbackIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

describe('[LT2 Regression] Actual Comment Collector Validation & Security', () => {
  let tmpDir;
  let isolatedCollectorScript;
  let commentsFile;
  let server;
  let serverPort;
  let serverUrl;

  beforeEach(async () => {
    // Isolated snapshot directory: zero shared checkout changes
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-collector-'));
    commentsFile = path.join(tmpDir, 'lt2_comments.json');
    isolatedCollectorScript = path.join(tmpDir, 'comment-collector.mjs');
    fs.copyFileSync(originalCollectorPath, isolatedCollectorScript);

    const mod = await import(pathToFileURL(isolatedCollectorScript).href);
    server = mod.createCollectorServer();

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
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

  test('Finding 3: Missing comment id must be rejected with HTTP 400, not 200 OK', async () => {
    const res = await sendPost(`${serverUrl}/comment`, {
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
    const resNumeric = await sendPost(`${serverUrl}/comment`, {
      id: 12345,
      authorEmail: 'test@example.com',
    });
    assert.strictEqual(
      resNumeric.status,
      400,
      'Collector must reject numeric comment id with HTTP 400',
    );

    const resEmpty = await sendPost(`${serverUrl}/comment`, {
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
    const largePayload = {
      id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
      junk: 'X'.repeat(70 * 1024), // 70 KB
    };

    const res = await sendPost(`${serverUrl}/comment`, largePayload);
    assert.ok(
      res.status === 400 || res.status === 413,
      `Collector must reject oversized payload with 400 or 413 (got ${res.status})`,
    );
  });

  test('Finding 6: Atomicity & Concurrency: concurrent comment posts must not lose data', async () => {
    // Send 20 concurrent unique comments to verify durability and atomic persistence
    const commentCount = 20;
    const ids = Array.from(
      { length: commentCount },
      (_, i) => `0192f5e4-7c1a-7b3e-9d2a-a000000000${String(i).padStart(2, '0')}`,
    );

    const results = await Promise.all(
      ids.map((id) =>
        sendPost(`${serverUrl}/comment`, {
          id,
          authorEmail: 'concurrent@example.com',
          authorHandle: 'lt2_user_concurrent',
        }),
      ),
    );

    assert.ok(
      results.every((r) => r.status === 200 || r.status === 201),
      'All valid comment posts should succeed',
    );

    // Read the persisted file
    assert.ok(fs.existsSync(commentsFile), 'comments file must exist after posting');
    const raw = fs.readFileSync(commentsFile, 'utf8');
    const savedComments = JSON.parse(raw);

    // In current SHA, writeComments() lacks serialization/locks and collides on Date.now() tmpPath,
    // causing concurrent writes to drop comments!
    assert.strictEqual(
      savedComments.length,
      commentCount,
      `Atomicity finding: collector must persist all ${commentCount} concurrent comments without data loss (saved ${savedComments.length})`,
    );

    // If on POSIX, also verify mode 0600
    if (process.platform !== 'win32') {
      const stat = fs.statSync(commentsFile);
      const mode = stat.mode & 0o777;
      assert.strictEqual(
        mode,
        0o600,
        `comments file must have 0600 permissions for data privacy (got ${mode.toString(8)})`,
      );
    }
  });

  test('Finding 7: Standalone collector must bind to 127.0.0.1 (loopback), never 0.0.0.0', async () => {
    // Start the actual standalone collector script as an owned child process
    const freePort = 19999 + Math.floor(Math.random() * 1000);
    const nonLoopbackIp = getNonLoopbackIp();

    if (!nonLoopbackIp) {
      // Fallback if no non-loopback network interface available
      return;
    }

    const child = spawn(process.execPath, [isolatedCollectorScript], {
      cwd: tmpDir,
      env: {
        ...process.env,
        COLLECTOR_PORT: String(freePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      // Wait for server to boot and respond on loopback healthz
      let booted = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const res = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${freePort}/healthz`, (r) => {
              resolve(r.statusCode);
            });
            req.on('error', reject);
            req.setTimeout(500, () => req.destroy());
          });
          if (res === 200) {
            booted = true;
            break;
          }
        } catch {
          // retry
        }
      }

      assert.ok(booted, 'Standalone collector failed to boot on loopback healthz');

      // Now attempt connection via the machine's external/LAN non-loopback IP
      let canConnectNonLoopback = false;
      try {
        const nonLoopbackRes = await new Promise((resolve, reject) => {
          const req = http.get(`http://${nonLoopbackIp}:${freePort}/healthz`, (r) => {
            resolve(r.statusCode);
          });
          req.on('error', reject);
          req.setTimeout(500, () => req.destroy(new Error('timeout')));
        });
        if (nonLoopbackRes === 200) {
          canConnectNonLoopback = true;
        }
      } catch {
        canConnectNonLoopback = false;
      }

      // If the collector binds to 0.0.0.0 (as in current SHA line 73),
      // it accepts connections on the external IP (canConnectNonLoopback is true).
      // Security requires binding strictly to 127.0.0.1 (canConnectNonLoopback must be false).
      assert.strictEqual(
        canConnectNonLoopback,
        false,
        `Security finding: standalone collector must NOT be accessible on non-loopback IP ${nonLoopbackIp} (must bind to 127.0.0.1, not 0.0.0.0)`,
      );
    } finally {
      child.kill('SIGKILL');
    }
  });
});
