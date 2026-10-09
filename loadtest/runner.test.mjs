/* global process */
import test, { describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runScriptPath = path.join(__dirname, 'lt2-run.sh');

describe('LT2 Load Test Runner Real Code Integration Tests (lt2-run.sh)', () => {
  test('lt2-run.sh strictly enforces production window (02:00 - 03:30 AM VN) without ALLOW_OUTSIDE_WINDOW bypass on production target', async () => {
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: 'Pass123!Secure',
          EDGE_METRICS_URL: 'http://127.0.0.1:9090/metrics',
          ALLOW_OUTSIDE_WINDOW: 'true', // Attempting bypass MUST be prohibited on production
        },
      });
      assert.fail('lt2-run.sh should have failed due to production window gate violation');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(
        err.stderr || err.stdout,
        /(Production load test requested outside approved window|EDGE_METRICS_URL|k6)/,
      );
    }
  });

  test('lt2-run.sh enforces production password requirement when targeting production URL', async () => {
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: '', // Missing password
          ALLOW_OUTSIDE_WINDOW: 'true',
        },
      });
      assert.fail('lt2-run.sh should have failed due to missing LOADTEST_USER_PASSWORD');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(
        err.stderr || err.stdout,
        /LOADTEST_USER_PASSWORD environment variable is required/,
      );
    }
  });

  test('lt2-run.sh enforces production EDGE_METRICS_URL requirement when targeting production URL', async () => {
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: 'Pass123!Secure',
          EDGE_METRICS_URL: '', // Missing edge metrics URL
          ALLOW_OUTSIDE_WINDOW: 'true',
        },
      });
      assert.fail('lt2-run.sh should have failed due to missing EDGE_METRICS_URL');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /EDGE_METRICS_URL environment variable is required/);
    }
  });

  test('lt2-run.sh executes full preflight, preseed, watchdog, and stop-wait-drain sequence cleanly against test HTTP server', async () => {
    const commentsPath = path.join(__dirname, 'lt2_comments.json');
    const accountsPath = path.join(__dirname, 'lt2_accounts.json');
    const seedPath = path.join(__dirname, 'seed.json');

    // Clean up any stale state files before test execution
    [commentsPath, accountsPath, seedPath].forEach((p) => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    const mockSeedData = {
      videos: [{ id: 'mock_vid_1', playback: { hls_url: 'http://localhost/hls/master.m3u8' } }],
    };
    fs.writeFileSync(seedPath, JSON.stringify(mockSeedData, null, 2));

    const testServerPort = 8088;
    const mockServer = http.createServer((req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });
      req.on('end', () => {
        const url = req.url;
        const method = req.method.toUpperCase();

        if (url.includes('/v1/auth/register') && method === 'POST') {
          const parsed = JSON.parse(bodyStr || '{}');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'mock_server_reg_token',
              user: { id: `usr_${parsed.handle}`, handle: parsed.handle, email: parsed.email },
            }),
          );
          return;
        }

        if (url.includes('/v1/auth/login') && method === 'POST') {
          const parsed = JSON.parse(bodyStr || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'mock_server_login_token',
              user: { id: `usr_${parsed.email}`, handle: 'lt2_user' },
            }),
          );
          return;
        }

        if (url.includes('/v1/videos?sort=newest') && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: [{ id: 'mock_vid_1' }], next_cursor: null }));
          return;
        }

        if (url.includes('/v1/videos/') && url.includes('/comments') && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: [], next_cursor: null }));
          return;
        }

        if (url.includes('/v1/comments/') && method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (url.includes('/v1/auth/me') && method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }));
      });
    });

    await new Promise((resolve) => mockServer.listen(testServerPort, '127.0.0.1', resolve));

    try {
      const { stdout } = await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: `http://127.0.0.1:${testServerPort}`,
          LOADTEST_USER_PASSWORD: 'Pass123!DryRun',
          ALLOW_OUTSIDE_WINDOW: 'true',
          DRY_RUN: 'true',
          PRESEED_PACING_MS: '10',
          COLLECTOR_PORT: '9998', // Use separate port for test isolation
        },
      });

      assert.match(stdout, /Starting comment collector on port 9998/);
      assert.match(stdout, /Pre-seeding 5 temporary lt2 accounts/);
      assert.match(stdout, /DRY_RUN \/ PREFLIGHT_ONLY mode enabled/);
      assert.match(stdout, /Draining collector & running cleanup/);
      assert.match(stdout, /Task LT2 load test execution finished cleanly/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
      [commentsPath, accountsPath, seedPath].forEach((p) => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
    }
  });
});
