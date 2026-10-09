/* global console, process */
import test, { describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runScriptPath = path.join(__dirname, 'lt2-run.sh');

describe('LT2 Load Test Runner Real Code Integration Tests (lt2-run.sh)', () => {
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

  test('lt2-run.sh executes full preflight, preseed, watchdog, and stop-wait-drain sequence cleanly in DRY_RUN mode', async () => {
    // Clean up any stale state files before test
    const commentsPath = path.join(__dirname, 'lt2_comments.json');
    const accountsPath = path.join(__dirname, 'lt2_accounts.json');
    if (fs.existsSync(commentsPath)) fs.unlinkSync(commentsPath);
    if (fs.existsSync(accountsPath)) fs.unlinkSync(accountsPath);

    // Create mock seed.json so preseed succeeds
    const seedPath = path.join(__dirname, 'seed.json');
    const mockSeedData = {
      videos: [{ id: 'mock_vid_1', playback: { hls_url: 'http://localhost/hls/master.m3u8' } }],
    };
    fs.writeFileSync(seedPath, JSON.stringify(mockSeedData, null, 2));

    try {
      const { stdout } = await execFileAsync('bash', [runScriptPath], {
        env: {
          ...process.env,
          TARGET_URL: 'http://127.0.0.1:8080',
          LOADTEST_USER_PASSWORD: 'Pass123!DryRun',
          ALLOW_OUTSIDE_WINDOW: 'true',
          DRY_RUN: 'true',
          COLLECTOR_PORT: '9998', // Use separate port for test
        },
      });

      assert.match(stdout, /Starting comment collector on port 9998/);
      assert.match(stdout, /Pre-seeding 5 temporary lt2 accounts/);
      assert.match(stdout, /DRY_RUN \/ PREFLIGHT_ONLY mode enabled/);
      assert.match(stdout, /Draining collector & running cleanup/);
      assert.match(stdout, /Task LT2 load test execution finished cleanly/);
    } finally {
      if (fs.existsSync(seedPath)) {
        fs.unlinkSync(seedPath);
      }
    }
  });
});
