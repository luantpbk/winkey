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

  // Retained verified process identities
  // currentRunRootIdentity: { pid: number, creationEpoch: number, ppid: number | null }
  let currentRunRootIdentity = null;
  // verifiedDescendantIdentities: Map<number, { pid: number, creationEpoch: number, ppid: number | null }>
  const verifiedDescendantIdentities = new Map();

  function parseCreationEpoch(val) {
    if (typeof val === 'number' && !isNaN(val)) return val;
    if (typeof val === 'string') {
      const m = val.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
    return null;
  }

  // OS process discovery: strictly queries system process table.
  // Fails EXPLICITLY on query errors or invalid output. Never swallows errors or assumes clean table.
  function queryOsProcessTable(customCmd = null) {
    if (process.platform === 'win32') {
      let out;
      try {
        const cmd =
          customCmd ||
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate | ConvertTo-Json -Compress"`;
        out = execSync(cmd, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 4000,
        });
      } catch (err) {
        throw new Error(
          `Process table discovery failed: PowerShell Get-CimInstance query failed: ${err.message}`,
        );
      }

      const trimmed = (out || '').trim();
      if (!trimmed) {
        throw new Error('Process table discovery failed: empty output from Win32_Process query');
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(
          `Process table discovery failed: invalid JSON from Get-CimInstance: ${err.message}`,
        );
      }

      const procs = Array.isArray(parsed) ? parsed : [parsed];
      const procMap = new Map();
      for (const p of procs) {
        if (!p || typeof p.ProcessId !== 'number') continue;
        const epoch = parseCreationEpoch(p.CreationDate);
        // Retain verified OS identity
        procMap.set(p.ProcessId, {
          pid: p.ProcessId,
          ppid: typeof p.ParentProcessId === 'number' ? p.ParentProcessId : null,
          creationEpoch: epoch,
        });
      }
      return procMap;
    } else {
      // POSIX
      let out;
      try {
        const cmd = customCmd || `ps -eo pid=,ppid=,pgid=,lstart=`;
        out = execSync(cmd, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 4000,
        });
      } catch (err) {
        throw new Error(`Process table discovery failed: ps command failed: ${err.message}`);
      }
      const trimmed = (out || '').trim();
      if (!trimmed) {
        throw new Error('Process table discovery failed: empty output from ps command');
      }
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        throw new Error('Process table discovery failed: empty output from ps command');
      }
      const procMap = new Map();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) {
          throw new Error(
            `Process table discovery failed: malformed row in process table output: "${line}"`,
          );
        }
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const pgid = parseInt(parts[2], 10);
        const lstart = parts.slice(3).join(' ');
        if (isNaN(pid) || isNaN(ppid) || isNaN(pgid) || pid <= 0) {
          throw new Error(
            `Process table discovery failed: non-numeric PID/PPID/PGID in row: "${line}"`,
          );
        }
        procMap.set(pid, {
          pid,
          ppid,
          pgid,
          creationEpoch: lstart,
        });
      }
      return procMap;
    }
  }

  function defaultProcessKiller(pid, signal = 'SIGKILL') {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /F 2>nul || exit 0`, { stdio: 'ignore' });
    } else {
      process.kill(pid, signal);
    }
  }

  function defaultGroupKiller(pgid, signal = 'SIGKILL') {
    if (process.platform !== 'win32') {
      process.kill(-pgid, signal);
    }
  }

  let processKiller = defaultProcessKiller;
  let groupKiller = defaultGroupKiller;

  // Strictly verifies ownership identity:
  // Requires readable matching captured creation timestamp AND current OS table creation timestamp!
  // Returns false if captured identity timestamp is null/missing, current OS timestamp is null/missing,
  // or creation timestamps do not match (PID reuse).
  // ONLY processes passing this check are authorized for termination / signaling.
  function isVerifiedOwnership(identity, liveTable) {
    if (!identity || !identity.pid || identity.creationEpoch == null || !liveTable) {
      return false;
    }
    const current = liveTable.get(identity.pid);
    if (!current || current.creationEpoch == null) {
      return false;
    }
    return current.creationEpoch === identity.creationEpoch;
  }

  // Observes whether a tracked process might still be running in the OS:
  // If the PID exists in the live process table but its creation timestamp cannot be verified,
  // we MUST NOT assume it is gone / clean (it is still a live process in the OS!).
  // Used by wait loops and assertions to ensure all processes have truly exited.
  function isPossiblyAlive(identity, liveTable) {
    if (!identity || !liveTable || !liveTable.has(identity.pid)) {
      return false;
    }
    const current = liveTable.get(identity.pid);
    if (!current) return false;
    if (current.creationEpoch == null) {
      return true;
    }
    return current.creationEpoch === identity.creationEpoch;
  }

  function discoverAndTrackDescendants(table = null, rootIdentity = null, trackedMap = null) {
    const root = rootIdentity || currentRunRootIdentity;
    if (!root) return [];
    const procMap = table || queryOsProcessTable();
    const targetMap = trackedMap || verifiedDescendantIdentities;

    if (process.platform === 'win32') {
      const byPpid = new Map();
      for (const [pid, p] of procMap) {
        if (p.ppid != null) {
          if (!byPpid.has(p.ppid)) byPpid.set(p.ppid, []);
          byPpid.get(p.ppid).push(pid);
        }
      }

      // BFS down from root PID
      const queue = [root.pid];
      while (queue.length > 0) {
        const parentPid = queue.shift();
        const children = byPpid.get(parentPid) || [];
        for (const childPid of children) {
          const detail = procMap.get(childPid);
          // Require readable creationEpoch AND creationEpoch >= root's creationEpoch - 2000
          if (detail && detail.creationEpoch && detail.creationEpoch >= root.creationEpoch - 2000) {
            if (!targetMap.has(childPid)) {
              targetMap.set(childPid, {
                pid: childPid,
                creationEpoch: detail.creationEpoch,
                ppid: detail.ppid,
              });
              queue.push(childPid);
            }
          }
        }
      }

      // Cross-verify candidate WINPIDs from pids.log only for real test runs
      if (!trackedMap && pidLog && fs.existsSync(pidLog)) {
        const lines = fs.readFileSync(pidLog, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const candPid = parseInt(line.trim(), 10);
          if (!isNaN(candPid) && candPid > 0 && procMap.has(candPid)) {
            const detail = procMap.get(candPid);
            if (
              detail &&
              detail.creationEpoch &&
              detail.creationEpoch >= root.creationEpoch - 2000
            ) {
              // Walk ancestor chain to confirm root is a true ancestor
              let curr = detail.ppid;
              let isDescendant = false;
              let depth = 0;
              while (curr && depth < 20) {
                if (curr === root.pid) {
                  isDescendant = true;
                  break;
                }
                const p = procMap.get(curr);
                curr = p ? p.ppid : null;
                depth++;
              }
              if (isDescendant) {
                targetMap.set(candPid, {
                  pid: candPid,
                  creationEpoch: detail.creationEpoch,
                  ppid: detail.ppid,
                });
              }
            }
          }
        }
      }
    } else {
      // POSIX: Query processes by PPID or PGID
      for (const [pid, detail] of procMap) {
        if (detail.ppid === root.pid || detail.pgid === root.pid) {
          if (!targetMap.has(pid)) {
            targetMap.set(pid, {
              pid,
              creationEpoch: detail.creationEpoch,
              ppid: detail.ppid,
              pgid: detail.pgid,
            });
          }
        }
      }
    }

    return Array.from(targetMap.values());
  }

  function terminateVerifiedOwnedProcesses(simulatedTable = null, simulatedPlatform = null) {
    if (!simulatedTable) {
      discoverAndTrackDescendants();
    }

    const plat = simulatedPlatform || process.platform;
    const liveTable = simulatedTable || queryOsProcessTable();

    // On POSIX: ONLY signal process group if:
    // 1. currentRunRootIdentity exists and has verified non-null creationEpoch
    // 2. It was an actual child spawned in activeChildren
    // 3. Current OS process table revalidates readable, matching creationEpoch (verified ownership)!
    // An unknown or unverified identity must NEVER authorize SIGKILL of a process group.
    if (
      plat !== 'win32' &&
      currentRunRootIdentity &&
      currentRunRootIdentity.creationEpoch != null &&
      activeChildren.some((c) => c && c.pid === currentRunRootIdentity.pid)
    ) {
      try {
        if (isVerifiedOwnership(currentRunRootIdentity, liveTable)) {
          groupKiller(currentRunRootIdentity.pid, 'SIGKILL');
        }
      } catch {
        void 0;
      }
    }

    // Revalidate each tracked identity immediately before killing.
    // Never kill a PID without re-verifying that the current process at that PID matches the recorded creationEpoch!
    const identities = Array.from(verifiedDescendantIdentities.values());
    for (const identity of identities) {
      // Re-verify against live table: require readable matching creation timestamp before killing
      if (!isVerifiedOwnership(identity, liveTable)) {
        continue;
      }

      // Identity is strictly verified and identical: safe to terminate
      try {
        processKiller(identity.pid, 'SIGKILL');
      } catch {
        void 0;
      }
    }
  }

  async function waitForVerifiedOwnedProcesses(timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      discoverAndTrackDescendants();
      const liveTable = queryOsProcessTable();
      const alive = Array.from(verifiedDescendantIdentities.values()).filter((id) =>
        isPossiblyAlive(id, liveTable),
      );
      if (alive.length === 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    const liveTable = queryOsProcessTable();
    const remaining = Array.from(verifiedDescendantIdentities.values()).filter((id) =>
      isPossiblyAlive(id, liveTable),
    );
    return remaining.length === 0;
  }

  afterEach(async () => {
    // Bounded process-tree teardown: kill and await all spawned descendants even if parent exited
    try {
      terminateVerifiedOwnedProcesses();
      const gone = await waitForVerifiedOwnedProcesses(2000);
      const liveTable = queryOsProcessTable();
      const surviving = Array.from(verifiedDescendantIdentities.values())
        .filter((id) => isPossiblyAlive(id, liveTable))
        .map((id) => id.pid);
      assert.strictEqual(
        gone,
        true,
        `All verified owned processes and descendants must be completely terminated with no surviving descendants (surviving PIDs: ${surviving.join(', ')})`,
      );
    } finally {
      verifiedDescendantIdentities.clear();
      currentRunRootIdentity = null;
      activeChildren.length = 0;
      processKiller = defaultProcessKiller;
      groupKiller = defaultGroupKiller;

      // Only remove owned temporary directory; zero global mutations
      if (tmpDir && fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          void 0;
        }
      }
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
      if (child.pid) {
        const table = queryOsProcessTable();
        const rootProc = table.get(child.pid);
        if (!rootProc) {
          throw new Error(
            `Failed to capture verified identity of spawned root PID ${child.pid}: process not found in OS table immediately after spawn`,
          );
        }
        if (!rootProc.creationEpoch) {
          throw new Error(
            `Failed to capture verified identity of spawned root PID ${child.pid}: missing or unreadable creation timestamp from OS`,
          );
        }
        currentRunRootIdentity = {
          pid: child.pid,
          creationEpoch: rootProc.creationEpoch,
          ppid: rootProc.ppid,
        };
        verifiedDescendantIdentities.set(child.pid, currentRunRootIdentity);
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
            const liveTable = queryOsProcessTable();
            const alive = Array.from(verifiedDescendantIdentities.values())
              .filter((id) => isPossiblyAlive(id, liveTable))
              .map((id) => id.pid);
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

  test('Finding 13 (OS process discovery fault): discovery failure throws explicitly and rejects, never passes clean', () => {
    // Teardown safety: if the OS process table cannot be queried (command error or malformed JSON),
    // the system must throw explicitly. It must NEVER silently treat discovery failure as a clean state.
    const faultCmd =
      process.platform === 'win32'
        ? 'powershell -NoProfile -Command "Write-Output \\"NOT_JSON\\""'
        : 'echo NOT_JSON';

    assert.throws(
      () => queryOsProcessTable(faultCmd),
      /Process table discovery failed/,
      'Process discovery must throw an explicit error on invalid query output',
    );

    // Command execution failure control: non-zero exit from query tool must also throw
    const failCmd =
      process.platform === 'win32' ? 'powershell -NoProfile -Command "exit 1"' : 'false';
    assert.throws(
      () => queryOsProcessTable(failCmd),
      /Process table discovery failed/,
      'Process discovery must throw an explicit error on query execution failure',
    );
  });

  test('Finding 14 (PID reuse & unverified timestamp protection): mismatched or null creation timestamp immediately aborts kill to protect unrelated processes', () => {
    // PID reuse & unverified timestamp protection:
    // If a PID was captured with epoch T1, but the live OS table now reports epoch T2 (PID reuse)
    // or null (unverified/unreadable timestamp), the teardown must NEVER authorize SIGKILL.
    const trackedIdentity = { pid: 99999, creationEpoch: 1000000, ppid: 12345 };
    const simulatedLiveTable = new Map([
      [99999, { pid: 99999, creationEpoch: 2000000, ppid: 1 }], // Different creation epoch -> PID REUSE!
    ]);

    // 1. isVerifiedOwnership must report false on PID reuse
    const ownedOnReuse = isVerifiedOwnership(trackedIdentity, simulatedLiveTable);
    assert.strictEqual(
      ownedOnReuse,
      false,
      'Reused PID with mismatched creation epoch must NOT be authorized as verified ownership',
    );
    assert.strictEqual(
      isPossiblyAlive(trackedIdentity, simulatedLiveTable),
      false,
      'Reused PID with mismatched creation epoch must NOT be considered alive for tracked identity',
    );

    // 2. Matching epoch must report true for both
    const matchingTable = new Map([[99999, { pid: 99999, creationEpoch: 1000000, ppid: 12345 }]]);
    assert.strictEqual(
      isVerifiedOwnership(trackedIdentity, matchingTable),
      true,
      'Matching identity must be verified as owned',
    );
    assert.strictEqual(
      isPossiblyAlive(trackedIdentity, matchingTable),
      true,
      'Matching identity must be reported as alive',
    );

    // 3. Live process with unavailable timestamp control:
    // isPossiblyAlive returns true (cannot infer gone when live PID exists in OS),
    // BUT isVerifiedOwnership returns false (UNKNOWN IDENTITY MUST NEVER AUTHORIZE KILL)!
    const unavailableEpochTable = new Map([[99999, { pid: 99999, creationEpoch: null, ppid: 1 }]]);
    assert.strictEqual(
      isPossiblyAlive(trackedIdentity, unavailableEpochTable),
      true,
      'Live process with unavailable timestamp must never be inferred as dead in observation checks',
    );
    assert.strictEqual(
      isVerifiedOwnership(trackedIdentity, unavailableEpochTable),
      false,
      'Live process with unavailable timestamp must NEVER be authorized for kill / signal',
    );

    // 4. Dead process control: non-existent PID in live table must report false for both
    const emptyTable = new Map();
    assert.strictEqual(
      isVerifiedOwnership(trackedIdentity, emptyTable),
      false,
      'Non-existent PID must not be verified as owned',
    );
    assert.strictEqual(
      isPossiblyAlive(trackedIdentity, emptyTable),
      false,
      'Non-existent PID must be reported as dead',
    );

    // 5. Injected-killer regressions: prove no signal for null timestamp and reused PID
    const killedProcesses = [];
    const killedGroups = [];
    processKiller = (pid, sig) => killedProcesses.push({ pid, sig });
    groupKiller = (pgid, sig) => killedGroups.push({ pgid, sig });

    try {
      const rootId = { pid: 88881, creationEpoch: 1000000, ppid: 1 };
      const childId = { pid: 88882, creationEpoch: 1000500, ppid: 88881 };

      currentRunRootIdentity = rootId;
      activeChildren.push({ pid: 88881 });
      verifiedDescendantIdentities.set(childId.pid, childId);

      // Regression A: Null timestamp in OS live table -> MUST NOT SIGNAL group or process
      const nullEpochTable = new Map([
        [88881, { pid: 88881, creationEpoch: null, ppid: 1 }],
        [88882, { pid: 88882, creationEpoch: null, ppid: 88881 }],
      ]);
      terminateVerifiedOwnedProcesses(nullEpochTable, 'linux');
      assert.strictEqual(
        killedGroups.length,
        0,
        'Injected killer must NOT receive group signal when OS creation timestamp is null',
      );
      assert.strictEqual(
        killedProcesses.length,
        0,
        'Injected killer must NOT receive process signal when OS creation timestamp is null',
      );

      // Regression B: Reused PID (mismatched creation epoch) -> MUST NOT SIGNAL group or process
      const reusedEpochTable = new Map([
        [88881, { pid: 88881, creationEpoch: 2000000, ppid: 1 }],
        [88882, { pid: 88882, creationEpoch: 2000500, ppid: 88881 }],
      ]);
      terminateVerifiedOwnedProcesses(reusedEpochTable, 'linux');
      assert.strictEqual(
        killedGroups.length,
        0,
        'Injected killer must NOT receive group signal when PID is reused with different creation epoch',
      );
      assert.strictEqual(
        killedProcesses.length,
        0,
        'Injected killer must NOT receive process signal when PID is reused with different creation epoch',
      );

      // Regression C: Matching readable timestamps -> MUST signal verified owned group and process
      const verifiedEpochTable = new Map([
        [88881, { pid: 88881, creationEpoch: 1000000, ppid: 1 }],
        [88882, { pid: 88882, creationEpoch: 1000500, ppid: 88881 }],
      ]);
      terminateVerifiedOwnedProcesses(verifiedEpochTable, 'linux');
      assert.strictEqual(
        killedGroups.length,
        1,
        'Injected killer must receive group signal when creation epoch matches and ownership is verified',
      );
      assert.strictEqual(killedGroups[0].pgid, 88881);
      assert.strictEqual(
        killedProcesses.length,
        1,
        'Injected killer must receive process signal when creation epoch matches and ownership is verified',
      );
      assert.strictEqual(killedProcesses[0].pid, 88882);
    } finally {
      verifiedDescendantIdentities.clear();
      currentRunRootIdentity = null;
      activeChildren.length = 0;
      processKiller = defaultProcessKiller;
      groupKiller = defaultGroupKiller;
    }
  });

  test('Finding 15 (Parent-exit orphan tracking): retains verified descendant identity when parent exits', () => {
    // Orphan tracking: when a parent process exits, child processes may become orphaned (ppid changes to 1/init).
    // The test harness retains verified identity records { pid, creationEpoch, ppid }
    // so descendants are safely identified and cleaned up even after the root parent process terminates.
    // NOTE: Models must use scoped mock maps and never pollute real suite teardown state.
    const mockRoot = { pid: 1000, creationEpoch: 1500000, ppid: 100 };
    const mockChild = { pid: 1001, creationEpoch: 1500500, ppid: 1000 };

    const simulatedTable = new Map([
      [1000, mockRoot],
      [1001, mockChild],
    ]);

    const scopedMockTrackedMap = new Map([[mockRoot.pid, mockRoot]]);

    discoverAndTrackDescendants(simulatedTable, mockRoot, scopedMockTrackedMap);

    assert.ok(
      scopedMockTrackedMap.has(mockChild.pid),
      'Descendant PID must be discovered and tracked',
    );
    const trackedChild = scopedMockTrackedMap.get(mockChild.pid);
    assert.strictEqual(
      trackedChild.creationEpoch,
      mockChild.creationEpoch,
      'Tracked child must retain verified creation timestamp',
    );

    // Crucial isolation assertion: real suite state must NOT be polluted by mock model
    assert.strictEqual(
      currentRunRootIdentity,
      null,
      'Suite root identity must remain null in mock unit model',
    );
    assert.strictEqual(
      verifiedDescendantIdentities.size,
      0,
      'Suite verifiedDescendantIdentities must remain empty in mock unit model',
    );
  });
});
