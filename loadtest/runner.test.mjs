/* global process */
import test, { describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runScriptPath = path.join(__dirname, 'lt2-run.sh');

function createMockDateDir(timeStr) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-date-'));
  const dateScriptPath = path.join(tmpDir, 'date');
  const scriptContent = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "+%H%M" ]; then
    echo "${timeStr}"
    exit 0
  fi
done
exec /bin/date "$@"
`;
  fs.writeFileSync(dateScriptPath, scriptContent, { mode: 0o755 });
  return tmpDir;
}

describe('LT2 Load Test Runner Real Code Integration Tests (lt2-run.sh)', () => {
  test('lt2-run.sh strictly enforces production window (02:00 - 03:30 AM VN) when execution is outside approved hours', async () => {
    const mockDir = createMockDateDir('1200'); // 12:00 PM VN (outside approved window)
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          PATH: `${mockDir}:${process.env.PATH}`,
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
        /Production load test requested outside approved window/,
      );
    } finally {
      if (fs.existsSync(mockDir)) fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  test('lt2-run.sh permits production target execution past time window gate when inside approved hours (02:00 - 03:30 AM VN)', async () => {
    const mockDir = createMockDateDir('0230'); // 02:30 AM VN (inside approved window)
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          PATH: `${mockDir}:${process.env.PATH}`,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: '', // Omit password so it passes time gate (Check 1) and fails at password requirement (Check 2)
        },
      });
      assert.fail('lt2-run.sh should have failed at parameter check');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(
        err.stderr || err.stdout,
        /LOADTEST_USER_PASSWORD environment variable is required/,
      );
    } finally {
      if (fs.existsSync(mockDir)) fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  test('lt2-run.sh enforces production password requirement when targeting production URL', async () => {
    const mockDir = createMockDateDir('0230');
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          PATH: `${mockDir}:${process.env.PATH}`,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: '', // Missing password
        },
      });
      assert.fail('lt2-run.sh should have failed due to missing LOADTEST_USER_PASSWORD');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(
        err.stderr || err.stdout,
        /LOADTEST_USER_PASSWORD environment variable is required/,
      );
    } finally {
      if (fs.existsSync(mockDir)) fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  test('lt2-run.sh enforces production EDGE_METRICS_URL requirement when targeting production URL', async () => {
    const mockDir = createMockDateDir('0230');
    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          PATH: `${mockDir}:${process.env.PATH}`,
          TARGET_URL: 'https://winkey.vn',
          LOADTEST_USER_PASSWORD: 'Pass123!Secure',
          EDGE_METRICS_URL: '', // Missing edge metrics URL
        },
      });
      assert.fail('lt2-run.sh should have failed due to missing EDGE_METRICS_URL');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /EDGE_METRICS_URL environment variable is required/);
    } finally {
      if (fs.existsSync(mockDir)) fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  test('lt2-run.sh executes full preflight, preseed, watchdog, and stop-wait-drain sequence cleanly against test HTTP server', async () => {
    const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-runner-test-'));
    const seedPath = path.join(testTmpDir, 'seed.json');

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
          LT2_STATE_DIR: testTmpDir,
        },
      });

      assert.match(stdout, /Starting comment collector on port 9998/);
      assert.match(stdout, /Pre-seeding 5 temporary lt2 accounts/);
      assert.match(stdout, /DRY_RUN \/ PREFLIGHT_ONLY mode enabled/);
      assert.match(stdout, /Draining collector & running cleanup/);
      assert.match(stdout, /Task LT2 load test execution finished cleanly/);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
      if (fs.existsSync(testTmpDir)) {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      }
    }
  });

  test('Preflight failure or unreachable target prevents preseed account creation and produces 0 state files', async () => {
    const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-preflight-fail-'));
    const accountsFile = path.join(testTmpDir, 'lt2_accounts.json');

    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: 'http://127.0.0.1:59999', // Connection refused / unreachable target
          LOADTEST_USER_PASSWORD: 'Pass123!Preflight',
          ALLOW_OUTSIDE_WINDOW: 'true',
          LT2_STATE_DIR: testTmpDir,
        },
      });
      assert.fail('lt2-run.sh should have failed due to preflight target error');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr || err.stdout, /Target preflight check failed/);
      assert.strictEqual(
        fs.existsSync(accountsFile),
        false,
        'lt2_accounts.json MUST NOT be written when preflight fails',
      );
    } finally {
      if (fs.existsSync(testTmpDir)) {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      }
    }
  });

  test('Watchdog abort signal before preseed prevents account creation and produces 0 state files', async () => {
    const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-watchdog-dead-'));
    const accountsFile = path.join(testTmpDir, 'lt2_accounts.json');
    const abortSignalFile = path.join(testTmpDir, 'abort.signal');

    // Pre-create abort signal file to simulate watchdog auto-abort signal before preseed
    fs.writeFileSync(abortSignalFile, 'WATCHDOG_TELEMETRY_FAILURE', 'utf8');

    let registerCount = 0;
    const testPort = 8089;
    const mockServer = http.createServer((req, res) => {
      if (req.url.includes('/v1/auth/register')) {
        registerCount++;
      }
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(testPort, '127.0.0.1', resolve));

    try {
      await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: `http://127.0.0.1:${testPort}`,
          LOADTEST_USER_PASSWORD: 'Pass123!WatchdogDead',
          ALLOW_OUTSIDE_WINDOW: 'true',
          ABORT_SIGNAL_FILE: abortSignalFile,
          LT2_STATE_DIR: testTmpDir,
        },
      });
      assert.fail('lt2-run.sh should have failed due to watchdog abort signal');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.match(
        err.stderr || err.stdout,
        /Watchdog is dead or emitted abort signal|Watchdog died or emitted abort signal|Existing abort signal file detected/,
      );
      assert.strictEqual(
        registerCount,
        0,
        'ZERO registration requests MUST be sent when watchdog fails',
      );
      assert.strictEqual(
        fs.existsSync(accountsFile),
        false,
        'lt2_accounts.json MUST NOT be written when watchdog fails',
      );
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
      if (fs.existsSync(testTmpDir)) {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      }
    }
  });
});
