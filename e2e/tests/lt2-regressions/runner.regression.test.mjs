import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const loadtestDir = path.resolve(repoRoot, 'loadtest');
const scriptPath = path.join(loadtestDir, 'lt2-run.sh');
const fakeBinDir = path.join(__dirname, 'fake-bin');

const bashBin =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : process.env.SHELL || 'bash';

function runScript(env = {}) {
  const nodeBinDir = path.dirname(process.execPath);
  const pathSeparator = process.platform === 'win32' ? ';' : ':';

  // Put fake-bin first in PATH, then node
  const customPath = `${fakeBinDir}${pathSeparator}${nodeBinDir}${pathSeparator}${process.env.PATH}`;

  return spawnSync(bashBin, [scriptPath], {
    cwd: loadtestDir,
    env: {
      ...process.env,
      PATH: customPath,
      TARGET_URL: 'http://127.0.0.1:8080',
      ALLOW_OUTSIDE_WINDOW: 'false',
      ...env,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('[LT2 Regression] Actual Runner & Lifecycle Safety Verification', () => {
  beforeEach(() => {
    fs.mkdirSync(fakeBinDir, { recursive: true });

    // Setup fake curl: returns 200 OK for healthz
    const fakeCurl = path.join(fakeBinDir, 'curl');
    fs.writeFileSync(fakeCurl, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    // Setup fake docker: logs commands to docker.log
    const fakeDocker = path.join(fakeBinDir, 'docker');
    fs.writeFileSync(
      fakeDocker,
      '#!/usr/bin/env bash\necho "$@" >> "$(dirname "$0")/docker.log"\nexit 0\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    if (fs.existsSync(fakeBinDir)) {
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  test('Finding 8: Exact-host validation: http://localhost.attacker.com must not be treated as loopback', () => {
    // A target URL with a deceptive subdomain like http://localhost.attacker.com
    // must be recognized as non-local and require password / production window rules,
    // rather than matching substring "*localhost*" and bypassing local safeguards.
    const res = runScript({
      TARGET_URL: 'http://localhost.attacker.com',
      LOADTEST_USER_PASSWORD: '',
    });

    // In current SHA, line 32 checks [[ "${TARGET_URL}" != *"localhost"* ... ]]
    // which matches "localhost.attacker.com", leaving is_production=0!
    // The test asserts that localhost.attacker.com is rejected as an invalid or unauthenticated production target.
    const output = (res.stdout || '') + (res.stderr || '');
    const rejected = res.status !== 0 && output.includes('LOADTEST_USER_PASSWORD');
    assert.strictEqual(
      rejected,
      true,
      'Security finding: http://localhost.attacker.com must NOT match localhost loopback via substring check',
    );
  });

  test('Finding 9: ICT date cutoff: execution before 2026-10-09 must be rejected', () => {
    // LT2 approved execution window begins starting the night of October 9, 2026 (02:00 - 03:30 AM ICT).
    // Execution on October 8, 2026 within the hour window must be rejected by date validation.
    const fakeDate = path.join(fakeBinDir, 'date');
    // Simulate current time is 02:30 AM on October 8, 2026
    fs.writeFileSync(
      fakeDate,
      `#!/usr/bin/env bash
if [[ "$*" == *"%H%M"* ]]; then
  echo "0230"
elif [[ "$*" == *"%Y"* || "$*" == *"%m"* || "$*" == *"%d"* || "$*" == *"+"* ]]; then
  echo "2026-10-08"
else
  echo "2026-10-08 02:30:00"
fi
`,
      { mode: 0o755 },
    );

    const res = runScript({
      TARGET_URL: 'https://winkey.vn',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    // Target SHA only checks %H%M ("0230"), ignoring the date completely, so no date error is produced!
    const errOutput = res.stderr || '';
    assert.strictEqual(
      errOutput.includes('2026-10-09') || errOutput.toLowerCase().includes('date'),
      true,
      'Safety finding: Runner must validate date and reject execution before approved date 2026-10-09 with clear stderr error',
    );
  });

  test('Finding 10: Timezone fallback prohibition: fail-closed if Asia/Ho_Chi_Minh TZ fails', () => {
    // Current SHA line 37: TZ="Asia/Ho_Chi_Minh" date +"%H%M" 2>/dev/null || date +"%H%M"
    // Falling back to machine local time can mistakenly execute outside the approved ICT window.
    const src = fs.readFileSync(scriptPath, 'utf8');
    const hasTzFallback = src.includes('|| date +"%H%M"') || src.includes('|| date');
    assert.strictEqual(
      hasTzFallback,
      false,
      'Safety finding: lt2-run.sh must NOT fall back to local date when Asia/Ho_Chi_Minh fails',
    );
  });

  test('Finding 11: Cleanup reserve: starting at 03:20 AM with 35m duration must be rejected', () => {
    // Window ends at 03:30 AM ICT. Starting at 03:20 with a 35m run would overshoot to 03:55 AM.
    // Script must enforce remaining window >= test duration + cleanup reserve.
    const fakeDate = path.join(fakeBinDir, 'date');
    fs.writeFileSync(
      fakeDate,
      `#!/usr/bin/env bash
echo "0320"
`,
      { mode: 0o755 },
    );

    const res = runScript({
      TARGET_URL: 'https://winkey.vn',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    const output = (res.stdout || '') + (res.stderr || '');
    assert.strictEqual(
      res.status !== 0 && (output.includes('reserve') || output.includes('cutoff')),
      true,
      'Safety finding: Runner must enforce cleanup reserve before 03:30 AM window cutoff',
    );
  });

  test('Finding 12: Abort shutdown order: containers must be stopped before collector drain/kill', () => {
    // In current SHA lines 82-89:
    // Collector is killed with kill -9 BEFORE docker stop!
    // In-flight comment IDs from k6 containers are lost.
    const src = fs.readFileSync(scriptPath, 'utf8');
    const collectorKillIndex = src.indexOf('kill -9 "${COLLECTOR_PID}"');
    const dockerStopIndex = src.indexOf('docker stop');

    // Expected order: docker stop BEFORE stopping/killing collector
    assert.ok(
      dockerStopIndex < collectorKillIndex,
      'Safety finding: abort trap must stop/wait Docker containers BEFORE draining or terminating collector',
    );
  });
});
