import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const originalScriptPath = path.resolve(repoRoot, 'loadtest', 'lt2-run.sh');

const bashBin =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : process.env.SHELL || 'bash';

describe('[LT2 Regression] Actual Runner & Lifecycle Safety Verification', () => {
  let tmpDir;
  let traceLog;
  let pidLog;
  let wrapperScriptPath;
  const activeChildren = [];

  beforeEach(() => {
    // Confine all writes exclusively to owned temporary directory; NEVER mutate /tmp/node/bin
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-runner-'));
    traceLog = path.join(tmpDir, 'trace.log');
    fs.writeFileSync(traceLog, '', 'utf8');
    pidLog = path.join(tmpDir, 'pids.log');
    fs.writeFileSync(pidLog, '', 'utf8');

    // Create an in-process bash wrapper script defining scoped exported functions
    // Functions take precedence over any directory in PATH (including /tmp/node/bin)
    wrapperScriptPath = path.join(tmpDir, 'wrapper.sh');
    const normalizedScriptPath = originalScriptPath.replace(/\\/g, '/');
    const normalizedTraceLog = traceLog.replace(/\\/g, '/');
    const normalizedPidLog = pidLog.replace(/\\/g, '/');

    const wrapperContent = `#!/usr/bin/env bash
set -e

# Log verified native OS PIDs: on Windows (MSYS bash), map MSYS PID to WINPID via /proc/<pid>/winpid
log_pids() {
  if [ -f "/proc/$$/winpid" ]; then
    cat "/proc/$$/winpid" >> "${normalizedPidLog}" 2>/dev/null || true
  else
    echo "$$" >> "${normalizedPidLog}" 2>/dev/null || true
  fi
  for j in $(jobs -p 2>/dev/null); do
    if [ -f "/proc/$j/winpid" ]; then
      cat "/proc/$j/winpid" >> "${normalizedPidLog}" 2>/dev/null || true
    else
      echo "$j" >> "${normalizedPidLog}" 2>/dev/null || true
    fi
  done
}
log_pids
trap log_pids EXIT SIGINT SIGTERM

# Scoped interceptor for curl: strictly validates exact loopback origins, hard denial for non-loopback
curl() {
  log_pids
  for arg in "$@"; do
    if [[ "$arg" =~ ^https?://\\[([^\\]]+)\\](:[0-9]+)?(/.*)?$ ]]; then
      host="\${BASH_REMATCH[1]}"
      if [[ "$host" != "::1" ]]; then
        echo "CURL HARD DENIAL: Non-loopback IPv6 blocked: $arg" >&2
        return 42
      fi
    elif [[ "$arg" =~ ^https?://([^/:]+)(:[0-9]+)?(/.*)?$ ]]; then
      host="\${BASH_REMATCH[1]}"
      if [[ "$host" != "127.0.0.1" && "$host" != "localhost" ]]; then
        echo "CURL HARD DENIAL: Non-loopback request blocked: $arg" >&2
        return 42
      fi
    fi
  done
  echo "OK"
  return 0
}
export -f curl

node() {
  log_pids
  echo "node $@" >> "${normalizedTraceLog}"
  if [ "\${SIMULATE_PRESEED_FAIL:-0}" = "1" ] && echo "$@" | grep -q preseed; then
    return 1
  fi
  return 0
}
export -f node

docker() {
  log_pids
  echo "docker $@" >> "${normalizedTraceLog}"
  return 0
}
export -f docker

k6() {
  log_pids
  echo "k6 $@" >> "${normalizedTraceLog}"
  return 0
}
export -f k6

sleep() {
  log_pids
  /bin/sleep 0.05 2>/dev/null || builtin sleep 0.05 2>/dev/null || true
}
export -f sleep

kill() {
  log_pids
  echo "kill $@" >> "${normalizedTraceLog}"
  builtin kill "$@" 2>/dev/null || /bin/kill "$@" 2>/dev/null || true
}
export -f kill

date() {
  log_pids
  if [ "\${FAIL_TZ:-0}" = "1" ]; then
    case "\${TZ:-}" in
      *Asia/Ho_Chi_Minh*)
        echo "date_fail_tz: timezone lookup failed for Asia/Ho_Chi_Minh (TZ=\${TZ:-})" >&2
        echo "date_fail_tz: timezone lookup failed for Asia/Ho_Chi_Minh (TZ=\${TZ:-})" >> "${normalizedTraceLog}"
        return 1
        ;;
    esac
  fi
  if [ -n "\${TZ:-}" ]; then
    echo "date_call: TZ=\${TZ} args=$*" >> "${normalizedTraceLog}"
  else
    echo "date_call: TZ=none args=$*" >> "${normalizedTraceLog}"
  fi
  case "$*" in
    *%s*)
      echo "1760000000"
      ;;
    *%H%M*)
      echo "\${FAKE_TIME:-0230}"
      ;;
    *%Y*|*%m*|*%d*|*date*)
      echo "\${FAKE_DATE:-2026-10-09}"
      ;;
    *)
      echo "\${FAKE_DATE:-2026-10-09} \${FAKE_TIME:-02:30:00}"
      ;;
  esac
}
export -f date

enable -n kill 2>/dev/null || true

# Execute the real unmodified runner script
source "${normalizedScriptPath}"
`;
    fs.writeFileSync(wrapperScriptPath, wrapperContent, { mode: 0o755 });
  });

  const verifiedOwnedPids = new Set();
  let currentRunRootPid = null;
  let currentRunStartTime = 0;

  function isProcessAlive(pid) {
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.includes(`"${pid}"`);
      }
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function getVerifiedOwnedProcesses() {
    if (!currentRunRootPid) return [];
    const owned = new Set();
    if (isProcessAlive(currentRunRootPid)) {
      owned.add(currentRunRootPid);
    }

    try {
      if (process.platform === 'win32') {
        // Query full process table via PowerShell CIM
        const out = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate | ConvertTo-Json -Compress"`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
        );
        let procs = [];
        try {
          const parsed = JSON.parse(out.trim());
          procs = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          procs = [];
        }

        const byPpid = new Map();
        const procDetails = new Map();
        for (const p of procs) {
          if (!p || typeof p.ProcessId !== 'number') continue;
          let epoch = 0;
          if (typeof p.CreationDate === 'string') {
            const m = p.CreationDate.match(/\d+/);
            if (m) epoch = parseInt(m[0], 10);
          }
          procDetails.set(p.ProcessId, { ppid: p.ParentProcessId, epoch });
          if (!byPpid.has(p.ParentProcessId)) {
            byPpid.set(p.ParentProcessId, []);
          }
          byPpid.get(p.ParentProcessId).push(p.ProcessId);
        }

        // Breadth-first search from currentRunRootPid down the process tree
        const queue = [currentRunRootPid];
        while (queue.length > 0) {
          const parent = queue.shift();
          const children = byPpid.get(parent) || [];
          for (const childId of children) {
            const detail = procDetails.get(childId);
            // Verify creation date was at or after test run start (allowing 2s skew) to prevent PID reuse collision
            if (detail && (!detail.epoch || detail.epoch >= currentRunStartTime - 2000)) {
              if (!owned.has(childId)) {
                owned.add(childId);
                queue.push(childId);
              }
            }
          }
        }

        // Cross-verify WINPIDs recorded in pids.log
        if (pidLog && fs.existsSync(pidLog)) {
          const loggedLines = fs.readFileSync(pidLog, 'utf8').split(/\r?\n/);
          for (const line of loggedLines) {
            const candPid = parseInt(line.trim(), 10);
            if (!isNaN(candPid) && candPid > 0 && procDetails.has(candPid)) {
              const detail = procDetails.get(candPid);
              // Walk ancestor chain to confirm currentRunRootPid is a true ancestor
              let curr = detail.ppid;
              let isAncestor = false;
              let depth = 0;
              while (curr && depth < 20) {
                if (curr === currentRunRootPid) {
                  isAncestor = true;
                  break;
                }
                const next = procDetails.get(curr);
                curr = next ? next.ppid : null;
                depth++;
              }
              if (isAncestor && (!detail.epoch || detail.epoch >= currentRunStartTime - 2000)) {
                owned.add(candPid);
              }
            }
          }
        }
      } else {
        // POSIX: Query processes by process group and PPID tree
        const out = execSync(`ps -eo pid=,ppid=,pgid= || true`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        });
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
          const parts = line
            .trim()
            .split(/\s+/)
            .map((n) => parseInt(n, 10));
          if (parts.length >= 3) {
            const [pid, ppid, pgid] = parts;
            if (pgid === currentRunRootPid || ppid === currentRunRootPid) {
              owned.add(pid);
            }
          }
        }
      }
    } catch {
      void 0;
    }

    for (const pid of owned) {
      verifiedOwnedPids.add(pid);
    }
    return Array.from(verifiedOwnedPids);
  }

  function terminateVerifiedOwnedProcesses() {
    const pids = getVerifiedOwnedProcesses();

    // On POSIX: signal process group first
    if (process.platform !== 'win32' && currentRunRootPid) {
      try {
        process.kill(-currentRunRootPid, 'SIGKILL');
      } catch {
        void 0;
      }
    }

    // Terminate each verified owned PID individually
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${pid} /F 2>nul || exit 0`, { stdio: 'ignore' });
        } else {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            void 0;
          }
        }
      } catch {
        void 0;
      }
    }
  }

  async function waitForVerifiedOwnedProcesses(timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pids = getVerifiedOwnedProcesses();
      const alive = pids.filter((pid) => isProcessAlive(pid));
      if (alive.length === 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    const remaining = getVerifiedOwnedProcesses().filter((pid) => isProcessAlive(pid));
    return remaining.length === 0;
  }

  afterEach(async () => {
    // Bounded process-tree teardown: kill and await all spawned descendants even if parent exited
    terminateVerifiedOwnedProcesses();
    const gone = await waitForVerifiedOwnedProcesses(2000);
    const surviving = getVerifiedOwnedProcesses().filter((pid) => isProcessAlive(pid));
    assert.strictEqual(
      gone,
      true,
      `All verified owned processes and descendants must be completely terminated with no surviving descendants (surviving PIDs: ${surviving.join(', ')})`,
    );

    verifiedOwnedPids.clear();
    currentRunRootPid = null;
    currentRunStartTime = 0;
    activeChildren.length = 0;

    // Only remove owned temporary directory; zero global mutations
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function executeRunner(customEnv = {}) {
    return new Promise((resolve, reject) => {
      const pathSeparator = process.platform === 'win32' ? ';' : ':';
      // Sanitized minimal environment: NO inherited credentials, tokens, or sensitive variables
      const hermeticEnv = {
        PATH: `/usr/bin${pathSeparator}/bin${pathSeparator}${process.env.PATH || ''}`,
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

      const child = spawn(bashBin, [wrapperScriptPath.replace(/\\/g, '/')], {
        cwd: tmpDir,
        env: hermeticEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeChildren.push(child);
      currentRunRootPid = child.pid;
      currentRunStartTime = Date.now();
      if (child.pid) {
        verifiedOwnedPids.add(child.pid);
      }

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ status: -1, stdout, stderr, error: err, timedOut: false });
      });

      const timer = setTimeout(async () => {
        try {
          terminateVerifiedOwnedProcesses();
          const gone = await waitForVerifiedOwnedProcesses(2000);
          if (!gone) {
            const alive = getVerifiedOwnedProcesses().filter((pid) => isProcessAlive(pid));
            reject(
              new Error(
                `Runner execution timed out and failed to clean up child processes (surviving PIDs: ${alive.join(', ')})`,
              ),
            );
            return;
          }
          resolve({ status: -1, stdout, stderr, timedOut: true });
        } catch (err) {
          reject(err);
        }
      }, 10000);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr, timedOut: false });
      });
    });
  }

  test('Finding 8: Exact-host validation: http://localhost.attacker.invalid must not be treated as loopback', async () => {
    // Non-loopback host using deceptive subdomain 'localhost.attacker.invalid'
    // must NOT match loopback via substring '*localhost*'.
    const res = await executeRunner({
      TARGET_URL: 'http://localhost.attacker.invalid:8080',
      LOADTEST_USER_PASSWORD: '', // Empty password to trigger production requirement check
      ALLOW_OUTSIDE_WINDOW: 'true',
    });

    const output = (res.stdout || '') + (res.stderr || '');
    // In current SHA, line 32 checks [[ "${TARGET_URL}" != *"localhost"* ... ]],
    // which matches "localhost.attacker.invalid", leaving is_production=0!
    // The test asserts that localhost.attacker.invalid must be rejected as an unauthenticated production target.
    const rejected = res.status !== 0 && output.includes('LOADTEST_USER_PASSWORD');
    assert.strictEqual(
      rejected,
      true,
      'Security finding: http://localhost.attacker.invalid must NOT match localhost loopback via substring check',
    );
  });

  test('Finding 9: ICT date cutoff: execution before 2026-10-09 must be rejected on production target', async () => {
    // Approved execution window begins starting October 9, 2026 (02:00 - 03:30 AM ICT).
    // Using a controlled non-loopback .invalid target exercises the production-only gate.
    const res = await executeRunner({
      TARGET_URL: 'http://production.loadtest.invalid:8080',
      FAKE_DATE: '2026-10-08',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    const trace = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8') : '';

    // Current SHA ignores the date completely and only checks %H%M ("0230").
    const errOutput = res.stderr || '';
    assert.strictEqual(
      errOutput.includes('2026-10-09') || errOutput.toLowerCase().includes('date'),
      true,
      'Safety finding: Runner must validate date and reject execution before approved date 2026-10-09 with clear stderr error',
    );
    assert.strictEqual(
      trace.includes('preseed') || trace.includes('docker run'),
      false,
      'Preseed and k6 workloads must NOT be launched when date gate is rejected',
    );
  });

  test('Finding 10: Timezone fallback prohibition: fail-closed if Asia/Ho_Chi_Minh TZ fails on production target', async () => {
    // Current SHA line 37: TZ="Asia/Ho_Chi_Minh" date +"%H%M" 2>/dev/null || date +"%H%M"
    // When Asia/Ho_Chi_Minh fails, falling back to machine local time can mistakenly execute outside window.
    // Exercising production gate with non-loopback .invalid target:
    const res = await executeRunner({
      TARGET_URL: 'http://production.loadtest.invalid:8080',
      FAIL_TZ: '1',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    const trace = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8') : '';

    // Prove the ICT timezone lookup failed via trace logging
    assert.strictEqual(
      trace.includes('date_fail_tz'),
      true,
      'Trace must prove Asia/Ho_Chi_Minh timezone evaluation failed as intended',
    );

    // Assert that unzoned/local date fallback was NOT attempted
    assert.strictEqual(
      trace.includes('date_call: TZ=none args=+%H%M'),
      false,
      'Runner must not fall back to local/unzoned date when Asia/Ho_Chi_Minh evaluation fails',
    );

    // Safety specification: lt2-run.sh must fail-closed on timezone failure and must NOT fall back to local date.
    // In current buggy SHA, it swallows the error (|| date +"%H%M") and proceeds to preseed!
    assert.strictEqual(
      res.status !== 0,
      true,
      'Safety finding: lt2-run.sh must fail-closed (non-zero exit) when Asia/Ho_Chi_Minh timezone evaluation fails, not fall back to local date',
    );
    assert.strictEqual(
      trace.includes('preseed') || trace.includes('docker run'),
      false,
      'Preseed and k6 workloads must NOT be launched when timezone calculation fails',
    );
  });

  test('Finding 10 positive control: valid Asia/Ho_Chi_Minh timezone within window passes time check', async () => {
    const res = await executeRunner({
      TARGET_URL: 'http://production.loadtest.invalid:8080',
      FAIL_TZ: '0',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    const trace = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8') : '';
    const output = (res.stdout || '') + (res.stderr || '');

    // Prove valid Asia/Ho_Chi_Minh was evaluated
    assert.strictEqual(
      trace.includes('date_call: TZ=Asia/Ho_Chi_Minh args=+%H%M'),
      true,
      'Trace must record successful date invocation under Asia/Ho_Chi_Minh',
    );

    // In a healthy environment with valid timezone, date and time checks succeed.
    // The runner proceeds past the window check without time/date window rejection.
    assert.strictEqual(
      output.includes('outside approved window') || output.includes('cannot be executed before'),
      false,
      'Positive control: valid timezone within approved window must not trigger time/date window error',
    );

    // Assert reaching the post-time-gate marker
    assert.strictEqual(
      output.includes('[lt2] Pre-seeding 5 temporary lt2 accounts...'),
      true,
      'Positive control: runner must advance past time gates to pre-seeding accounts',
    );
  });

  test('Finding 11: Cleanup reserve: starting at 03:20 AM with 35m duration must be rejected on production target', async () => {
    // Window ends at 03:30 AM ICT. Starting at 03:20 with a 35m run would overshoot to 03:55 AM.
    // Exercising production gate with non-loopback .invalid target:
    const res = await executeRunner({
      TARGET_URL: 'http://production.loadtest.invalid:8080',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0320',
      DURATION: '35m',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
    });

    const trace = fs.existsSync(traceLog) ? fs.readFileSync(traceLog, 'utf8') : '';

    const output = (res.stdout || '') + (res.stderr || '');
    assert.strictEqual(
      res.status !== 0 && (output.includes('reserve') || output.includes('cutoff')),
      true,
      'Safety finding: Runner must enforce cleanup reserve before 03:30 AM window cutoff',
    );
    assert.strictEqual(
      trace.includes('preseed') || trace.includes('docker run'),
      false,
      'Preseed and k6 workloads must NOT be launched when cleanup reserve is violated',
    );
  });

  test('Finding 12: Abort shutdown order: containers must be stopped before collector drain/kill', async () => {
    // Trigger abort trap by simulating preseed failure in the wrapper
    await executeRunner({
      TARGET_URL: 'http://127.0.0.1:9999',
      FAKE_DATE: '2026-10-09',
      FAKE_TIME: '0230',
      LOADTEST_USER_PASSWORD: 'prod-password-secure',
      SIMULATE_PRESEED_FAIL: '1',
    });

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
