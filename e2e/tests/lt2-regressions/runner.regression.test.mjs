import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const originalScriptPath = path.resolve(repoRoot, 'loadtest', 'lt2-run.sh');

const bashBin =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : process.env.SHELL || 'bash';

describe('[LT2 Regression] Actual Runner & Lifecycle Safety Verification', () => {
  let tmpDir;
  let fakeBinDir;
  let traceLog;
  let scriptCopyPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-runner-'));
    fakeBinDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    traceLog = path.join(tmpDir, 'trace.log');
    fs.writeFileSync(traceLog, '', 'utf8');

    // Create hermetic fake binaries
    // 1. Fake curl: Hard denial of non-loopback requests, 200/OK on healthz
    fs.writeFileSync(
      path.join(fakeBinDir, 'curl'),
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    http://127.0.0.1*|http://localhost*|http://\\[::1\\]*)
      ;;
    http*|https*)
      echo "CURL HARD DENIAL: Non-loopback request blocked: $arg" >&2
      exit 42
      ;;
  esac
done
exit 0
`,
      { mode: 0o755 },
    );

    // 2. Fake node: Never run real node commands against network or disk; log to trace
    fs.writeFileSync(
      path.join(fakeBinDir, 'node'),
      `#!/bin/sh
echo "node $@" >> "\${TRACE_LOG}"
exit 0
`,
      { mode: 0o755 },
    );

    // 3. Fake docker: Log container commands to trace
    fs.writeFileSync(
      path.join(fakeBinDir, 'docker'),
      `#!/bin/sh
echo "docker $@" >> "\${TRACE_LOG}"
exit 0
`,
      { mode: 0o755 },
    );

    // 4. Fake k6: Log invocations
    fs.writeFileSync(
      path.join(fakeBinDir, 'k6'),
      `#!/bin/sh
echo "k6 $@" >> "\${TRACE_LOG}"
exit 0
`,
      { mode: 0o755 },
    );

    // 5. Fake sleep: No delay in tests
    fs.writeFileSync(
      path.join(fakeBinDir, 'sleep'),
      `#!/bin/sh
exit 0
`,
      { mode: 0o755 },
    );

    // 6. Fake kill: Log signals to trace
    fs.writeFileSync(
      path.join(fakeBinDir, 'kill'),
      `#!/bin/sh
echo "kill $@" >> "\${TRACE_LOG}"
exit 0
`,
      { mode: 0o755 },
    );

    // 7. Fake date: Configurable via FAKE_DATE, FAKE_TIME, FAIL_TZ
    fs.writeFileSync(
      path.join(fakeBinDir, 'date'),
      `#!/bin/sh
if [ "\${FAIL_TZ}" = "1" ]; then
  case "$TZ" in
    *Asia/Ho_Chi_Minh*)
      echo "date: timezone lookup failed for Asia/Ho_Chi_Minh" >&2
      exit 1
      ;;
  esac
fi
case "$*" in
  *%H%M*)
    echo "\${FAKE_TIME:-0230}"
    ;;
  *%Y*|*%m*|*%d*|*date*)
    echo "\${FAKE_DATE:-2026-10-08}"
    ;;
  *)
    echo "\${FAKE_DATE:-2026-10-08} \${FAKE_TIME:-02:30:00}"
    ;;
esac
`,
      { mode: 0o755 },
    );

    // Also populate /tmp/node/bin to intercept lt2-run.sh's explicit PATH override
    try {
      spawnSync(bashBin, [
        '-c',
        `mkdir -p /tmp/node/bin && cp "${fakeBinDir.replace(/\\/g, '/')}"/* /tmp/node/bin/`,
      ]);
    } catch {
      // ignore
    }

    // Copy script into isolated temp directory
    scriptCopyPath = path.join(tmpDir, 'lt2-run.sh');
    fs.copyFileSync(originalScriptPath, scriptCopyPath);
  });

  afterEach(() => {
    try {
      spawnSync(bashBin, ['-c', 'rm -rf /tmp/node/bin']);
    } catch {
      // ignore
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function executeRunner(customEnv = {}) {
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    // Sanitized, hermetic environment: NO inherited credentials or tokens
    const hermeticEnv = {
      PATH: `${fakeBinDir}${pathSeparator}/usr/bin${pathSeparator}/bin${pathSeparator}${process.env.PATH || ''}`,
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      TEMP: tmpDir,
      TMP: tmpDir,
      TRACE_LOG: traceLog,
      TARGET_URL: 'http://127.0.0.1:9999',
      COLLECTOR_PORT: '9999',
      LOADTEST_USER_PASSWORD: 'LocalPassword123!',
      ALLOW_OUTSIDE_WINDOW: 'false',
      ...customEnv,
    };

    return spawnSync(
      bashBin,
      ['-c', `enable -n kill 2>/dev/null || true; source "${scriptCopyPath.replace(/\\/g, '/')}"`],
      {
        cwd: tmpDir,
        env: hermeticEnv,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
  }

  test('Finding 8: Exact-host validation: http://localhost.attacker.invalid must not be treated as loopback', () => {
    // Non-loopback host using deceptive subdomain 'localhost.attacker.invalid'
    // must NOT match loopback via substring '*localhost*'.
    const res = executeRunner({
      TARGET_URL: 'http://localhost.attacker.invalid:8080',
      LOADTEST_USER_PASSWORD: '', // Empty password to trigger production requirement check
      ALLOW_OUTSIDE_WINDOW: 'true',
    });

    const output = (res.stdout || '') + (res.stderr || '');
    // In current SHA, line 32 checks [[ "${TARGET_URL}" != *"localhost"* ... ]],
    // which matches "localhost.attacker.invalid", leaving is_production=0!
    // The test asserts that localhost.attacker.invalid must be rejected as an invalid or unauthenticated production target.
    const rejected = res.status !== 0 && output.includes('LOADTEST_USER_PASSWORD');
    assert.strictEqual(
      rejected,
      true,
      'Security finding: http://localhost.attacker.invalid must NOT match localhost loopback via substring check',
    );
  });

  test('Finding 9: ICT date cutoff: execution before 2026-10-09 must be rejected', () => {
    // Approved execution window begins starting October 9, 2026 (02:00 - 03:30 AM ICT).
    // Execution on October 8, 2026 within the hour window must be rejected by date validation.
    const res = executeRunner({
      TARGET_URL: 'http://127.0.0.1:9999',
      FAKE_DATE: '2026-10-08',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    // Current SHA ignores the date completely and only checks %H%M ("0230").
    const errOutput = res.stderr || '';
    assert.strictEqual(
      errOutput.includes('2026-10-09') || errOutput.toLowerCase().includes('date'),
      true,
      'Safety finding: Runner must validate date and reject execution before approved date 2026-10-09 with clear stderr error',
    );
  });

  test('Finding 10: Timezone fallback prohibition: fail-closed if Asia/Ho_Chi_Minh TZ fails', () => {
    // Current SHA line 37: TZ="Asia/Ho_Chi_Minh" date +"%H%M" 2>/dev/null || date +"%H%M"
    // When Asia/Ho_Chi_Minh fails, falling back to machine local time can mistakenly execute outside window.
    // Runner must fail-closed if Asia/Ho_Chi_Minh calculation fails.
    const res = executeRunner({
      TARGET_URL: 'http://127.0.0.1:9999',
      FAIL_TZ: '1',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    // In current SHA, the runner swallows the error (|| date +"%H%M") and continues running!
    const failedClosed = res.status !== 0;
    assert.strictEqual(
      failedClosed,
      true,
      'Safety finding: lt2-run.sh must fail-closed when Asia/Ho_Chi_Minh timezone evaluation fails, not fall back to local date',
    );
  });

  test('Finding 11: Cleanup reserve: starting at 03:20 AM with 35m duration must be rejected', () => {
    // Window ends at 03:30 AM ICT. Starting at 03:20 with a 35m run would overshoot to 03:55 AM.
    // Script must enforce remaining window >= test duration + cleanup reserve.
    const res = executeRunner({
      TARGET_URL: 'http://127.0.0.1:9999',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0320',
      DURATION: '35m',
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
    // In abort_all(): collector is killed with kill -9 BEFORE docker stop!
    // Trigger abort during execution and inspect the recorded lifecycle trace.
    // Configure fake node to fail during preseed, triggering the abort_all() trap:
    fs.writeFileSync(
      path.join(fakeBinDir, 'node'),
      `#!/bin/sh
echo "node $@" >> "\${TRACE_LOG}"
if echo "$@" | grep -q preseed; then exit 1; fi
exit 0
`,
      { mode: 0o755 },
    );
    try {
      spawnSync(bashBin, ['-c', `cp "${fakeBinDir.replace(/\\/g, '/')}/node" /tmp/node/bin/node`]);
    } catch {
      // ignore
    }

    executeRunner({
      TARGET_URL: 'http://127.0.0.1:9999',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    // The script catches preseed failure and runs abort_all trap.
    // Inspect trace.log for order of docker stop vs collector kill:
    const trace = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8') : '';
    const lines = trace.split('\n');

    let dockerStopLine = -1;
    let collectorKillLine = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('docker stop') && dockerStopLine === -1) {
        dockerStopLine = i;
      }
      if (
        (lines[i].includes('kill -9') || lines[i].includes('kill -SIGTERM')) &&
        collectorKillLine === -1
      ) {
        collectorKillLine = i;
      }
    }

    // In current SHA, line 83: kill -9 "${COLLECTOR_PID}" is called BEFORE line 89: docker stop
    assert.ok(
      dockerStopLine !== -1 && collectorKillLine !== -1 && dockerStopLine < collectorKillLine,
      `Safety finding: abort trap must stop/wait Docker containers BEFORE draining or terminating collector (dockerStop=${dockerStopLine}, kill=${collectorKillLine})`,
    );
  });
});
