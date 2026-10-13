/* global process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { parseHttpErrorRate } from '../deploy/lt2/watchdog.mjs';
import { processNdjson, buildTelemetryPayload, StreamTailer } from './telemetry-feeder.mjs';

function computeSummary(data) {
  const stallNoseek =
    (data.metrics.stall_ms_noseek && data.metrics.stall_ms_noseek.values.count) || 0;
  const stallSeek = (data.metrics.stall_ms_seek && data.metrics.stall_ms_seek.values.count) || 0;
  const watch = (data.metrics.watch_ms && data.metrics.watch_ms.values.count) || 0;
  const httpFailed =
    (data.metrics.http_req_failed && data.metrics.http_req_failed.values.rate) || 0;

  const rebuffer_ratio = stallNoseek / (watch + stallNoseek || 1);
  const rebuffer_ratio_incl_seek =
    (stallNoseek + stallSeek) / (watch + stallNoseek + stallSeek || 1);
  const passed = rebuffer_ratio < 0.01 && httpFailed < 0.01;

  return {
    rebuffer_ratio,
    rebuffer_ratio_incl_seek,
    http_req_failed: httpFailed,
    passed,
    watch_ms: watch,
    stall_ms_noseek: stallNoseek,
    stall_ms_seek: stallSeek,
  };
}

function createDateShim(hhmm) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-date-'));
  fs.writeFileSync(
    path.join(shimDir, 'date'),
    `#!/usr/bin/env bash\nif [[ "$*" == *"+%H%M"* ]]; then echo "${hhmm}"; else exec /bin/date "$@"; fi\n`,
    { mode: 0o755 },
  );
  return shimDir;
}

describe('LT2 v2 Runner & Summary Math Tests', () => {
  it('summary maths computes aggregate ratio with seek stalls kept separate', () => {
    const dataPassWithSeek = {
      metrics: {
        stall_ms_noseek: { values: { count: 500 } },
        stall_ms_seek: { values: { count: 5000 } },
        watch_ms: { values: { count: 100000 } },
        http_req_failed: { values: { rate: 0.002 } },
      },
    };

    const res1 = computeSummary(dataPassWithSeek);
    assert.equal(res1.passed, true);
    assert.ok(res1.rebuffer_ratio < 0.01, 'noseek rebuffer ratio should be < 0.01');
    assert.ok(res1.rebuffer_ratio_incl_seek > 0.01, 'incl_seek ratio is higher but kept separate');

    const dataFailRatio = {
      metrics: {
        stall_ms_noseek: { values: { count: 2000 } },
        stall_ms_seek: { values: { count: 0 } },
        watch_ms: { values: { count: 100000 } },
        http_req_failed: { values: { rate: 0.001 } },
      },
    };

    const res2 = computeSummary(dataFailRatio);
    assert.equal(res2.passed, false);
    assert.ok(res2.rebuffer_ratio >= 0.01);
  });

  it('summary maths fails gate when http_req_failed >= 0.01', () => {
    const dataFailHttp = {
      metrics: {
        stall_ms_noseek: { values: { count: 100 } },
        stall_ms_seek: { values: { count: 0 } },
        watch_ms: { values: { count: 100000 } },
        http_req_failed: { values: { rate: 0.015 } },
      },
    };

    const res = computeSummary(dataFailHttp);
    assert.equal(res.passed, false);
  });

  it('refuses to run outside allowed window when targeting winkey.vn', () => {
    const shimDir = createDateShim('0859');
    try {
      execFileSync('./loadtest/lt2-run.sh', [], {
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH}`,
          TARGET_URL: 'https://winkey.vn',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.fail('Expected script to exit non-zero for winkey.vn outside window');
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stderr || err.stdout, /02:00–03:30 Asia\/Ho_Chi_Minh/);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  describe('Window safety gate decimal comparison & date shim clock injection (Issue #315 / PR #317)', () => {
    const refuseCases = [
      { time: '0859', desc: '0859 (octal hour 08 outside window)' },
      { time: '0159', desc: '0159 (1 min before window)' },
      { time: '0331', desc: '0331 (1 min after window)' },
      { time: 'garbage', desc: 'garbage (non-numeric time input, fail closed)' },
    ];

    for (const { time, desc } of refuseCases) {
      it(`refuses execution outside window or invalid time: ${desc}`, () => {
        const shimDir = createDateShim(time);
        try {
          const res = spawnSync('./loadtest/lt2-run.sh', [], {
            env: {
              ...process.env,
              PATH: `${shimDir}:${process.env.PATH}`,
              TARGET_URL: 'https://winkey.vn',
            },
            encoding: 'utf8',
          });
          assert.equal(res.status, 1);
          assert.match(
            res.stderr || res.stdout,
            /strictly gated to 02:00–03:30|Failed to read or parse/,
          );
        } finally {
          fs.rmSync(shimDir, { recursive: true, force: true });
        }
      });
    }

    const allowCases = [
      { time: '0200', desc: '0200 (boundary start of window)' },
      { time: '0208', desc: '0208 (octal minute 08 inside window)' },
      { time: '0259', desc: '0259 (inside window)' },
      { time: '0330', desc: '0330 (boundary end of window)' },
    ];

    for (const { time, desc } of allowCases) {
      it(`allows execution inside window: ${desc}`, () => {
        const shimDir = createDateShim(time);
        try {
          // Keep EDGE_METRICS_URL dead so preflight can never pass in CI and no load is ever generated
          const res = spawnSync('./loadtest/lt2-run.sh', [], {
            env: {
              ...process.env,
              PATH: `${shimDir}:${process.env.PATH}`,
              TARGET_URL: 'https://winkey.vn',
              EDGE_METRICS_URL: 'http://127.0.0.1:1/invalid',
            },
            encoding: 'utf8',
            timeout: 2000,
          });
          const out = (res.stdout || '') + (res.stderr || '');
          assert.doesNotMatch(out, /strictly gated to 02:00–03:30/);
          assert.doesNotMatch(out, /Failed to read or parse/);
          assert.match(out, /Starting platform safety watchdog/);
        } finally {
          fs.rmSync(shimDir, { recursive: true, force: true });
        }
      });
    }

    // ADR-034 addendum 2026-10-13: a one-day daytime approval opens the gate only on that VN date.
    const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const approvalCases = [
      { approved: todayVN, allowed: true, desc: "today's VN date" },
      { approved: '2000-01-01', allowed: false, desc: 'another date' },
      { approved: 'yes', allowed: false, desc: 'not a date' },
      { approved: `${todayVN} `, allowed: false, desc: 'trailing space' },
    ];
    for (const { approved, allowed, desc } of approvalCases) {
      it(`daytime approval at 0859 with ${desc} ${allowed ? 'opens' : 'keeps closed'} the gate`, () => {
        const shimDir = createDateShim('0859');
        try {
          const res = spawnSync('./loadtest/lt2-run.sh', [], {
            env: {
              ...process.env,
              PATH: `${shimDir}:${process.env.PATH}`,
              TARGET_URL: 'https://winkey.vn',
              LT2_DAYTIME_APPROVED_DATE: approved,
              EDGE_METRICS_URL: 'http://127.0.0.1:1/invalid',
            },
            encoding: 'utf8',
            timeout: 2000,
          });
          const out = (res.stdout || '') + (res.stderr || '');
          if (allowed) {
            assert.doesNotMatch(out, /strictly gated to 02:00–03:30/);
            assert.match(out, /daytime production run approved/);
            assert.match(out, /Starting platform safety watchdog/);
          } else {
            assert.equal(res.status, 1);
            assert.match(out, /strictly gated to 02:00–03:30/);
          }
        } finally {
          fs.rmSync(shimDir, { recursive: true, force: true });
        }
      });
    }

    it('regression: CURRENT_TIME=0300 in env + shim returning 0859 strictly REFUSES (env bypass prohibited)', () => {
      const shimDir = createDateShim('0859');
      try {
        const res = spawnSync('./loadtest/lt2-run.sh', [], {
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH}`,
            TARGET_URL: 'https://winkey.vn',
            CURRENT_TIME: '0300', // Deliberate attempt to bypass window via env
          },
          encoding: 'utf8',
        });
        assert.equal(
          res.status,
          1,
          'Script must refuse based on date command, ignoring CURRENT_TIME env',
        );
        assert.match(res.stderr || res.stdout, /strictly gated to 02:00–03:30/);
      } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
      }
    });
  });

  it('bypasses window refusal when TARGET_URL is non-winkey.vn local address', async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.includes('MemAvailable')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'vector',
              result: [
                {
                  metric: { __name: 'node_memory_MemAvailable_bytes' },
                  value: [Date.now() / 1000, '4294967296'],
                },
              ],
            },
          }),
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('OK');
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const fakeMetricsUrl = `http://127.0.0.1:${port}/metrics`;

    const child = execFile('./loadtest/lt2-run.sh', [], {
      env: {
        ...process.env,
        TARGET_URL: `http://127.0.0.1:${port}`,
        EDGE_METRICS_URL: fakeMetricsUrl,
        LEGACY_SITES: `http://127.0.0.1:${port}/1,http://127.0.0.1:${port}/2,http://127.0.0.1:${port}/3,http://127.0.0.1:${port}/4`,
      },
    });

    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));

    await new Promise((resolve) => child.on('close', resolve));
    server.close();

    assert.doesNotMatch(output, /strictly gated to 02:00–03:30/);
  });

  it('verifies 5% http_req_failed abort threshold configuration in both k6 scripts', () => {
    const hlsContent = fs.readFileSync(path.join(process.cwd(), 'loadtest/hls-viewers.js'), 'utf8');
    const apiContent = fs.readFileSync(path.join(process.cwd(), 'loadtest/api-read.js'), 'utf8');

    const expectedConfig = "threshold: 'rate<0.05', abortOnFail: true";
    assert.ok(
      hlsContent.includes(expectedConfig),
      'hls-viewers.js must contain 5% threshold abortOnFail config',
    );
    assert.ok(
      apiContent.includes(expectedConfig),
      'api-read.js must contain 5% threshold abortOnFail config',
    );
  });

  it('propagates failure when summary file has passed=false', () => {
    const summaryFile = path.join(process.cwd(), 'results/lt2-summary.json');
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });

    fs.writeFileSync(
      summaryFile,
      JSON.stringify({
        rebuffer_ratio: 0.025,
        rebuffer_ratio_incl_seek: 0.05,
        http_req_failed: 0.005,
        passed: false,
      }),
    );

    const checkScript = `node -e "try { const s = JSON.parse(require('fs').readFileSync('${summaryFile}', 'utf8')); process.exit(s.passed === true ? 0 : 1); } catch { process.exit(1); }"`;
    try {
      execFileSync('sh', ['-c', checkScript], { stdio: 'pipe' });
      assert.fail('Expected script to exit non-zero when passed is false');
    } catch (err) {
      assert.equal(err.status, 1);
    } finally {
      if (fs.existsSync(summaryFile)) {
        fs.unlinkSync(summaryFile);
      }
    }
  });

  it('propagates failure from generator or watchdog abort', async () => {
    const runDir = `/tmp/winkey_lt2_test_abort_${Date.now()}`;
    fs.mkdirSync(runDir, { recursive: true });
    const abortFile = path.join(runDir, 'abort.signal');

    fs.writeFileSync(
      abortFile,
      JSON.stringify({
        abort: true,
        reason: 'Simulated memory threshold breach on edge-1',
      }),
    );

    assert.ok(fs.existsSync(abortFile));
    const content = JSON.parse(fs.readFileSync(abortFile, 'utf8'));
    assert.equal(content.reason, 'Simulated memory threshold breach on edge-1');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  describe('Issue #322: k6 mount and telemetry feeder tests', () => {
    it('feeder parses sample NDJSON and produces watchdog-valid telemetry (isPreflight: false)', () => {
      const nowSec = 1791695732;
      const nowMs = nowSec * 1000;

      const sampleApiNdjson = [
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 5000).toISOString(), value: 1, tags: { status: '200' } },
          metric: 'http_reqs',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 5000).toISOString(), value: 0, tags: { status: '200' } },
          metric: 'http_req_failed',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 2000).toISOString(), value: 1, tags: { status: '500' } },
          metric: 'http_reqs',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 2000).toISOString(), value: 1, tags: { status: '500' } },
          metric: 'http_req_failed',
        }),
      ].join('\n');

      const sampleHlsNdjson = [
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 4000).toISOString(), value: 1, tags: { status: '200' } },
          metric: 'http_reqs',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 4000).toISOString(), value: 0, tags: { status: '200' } },
          metric: 'http_req_failed',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 1000).toISOString(), value: 1, tags: { status: '200' } },
          metric: 'http_reqs',
        }),
        JSON.stringify({
          type: 'Point',
          data: { time: new Date(nowMs - 1000).toISOString(), value: 0, tags: { status: '200' } },
          metric: 'http_req_failed',
        }),
      ].join('\n');

      const apiCounts = processNdjson(sampleApiNdjson, nowMs, 60000);
      assert.deepEqual(apiCounts, { requests: 2, failed: 1 });

      const hlsCounts = processNdjson(sampleHlsNdjson, nowMs, 60000);
      assert.deepEqual(hlsCounts, { requests: 2, failed: 0 });

      const payload = buildTelemetryPayload(apiCounts, hlsCounts, nowSec, 60);
      assert.equal(payload.timestamp, nowSec);
      assert.equal(payload.windowSec, 60);

      const parsed = parseHttpErrorRate(payload, { isPreflight: false, nowSec });
      assert.equal(
        parsed.error,
        undefined,
        `Telemetry should be valid for watchdog: ${parsed.reason}`,
      );
      assert.equal(parsed.totalRequests, 4);
      assert.equal(parsed.failedRequests, 1);
      assert.equal(parsed.rate, 0.25);
      assert.equal(parsed.workloads.api_mix.requests, 2);
      assert.equal(parsed.workloads.api_mix.failed, 1);
      assert.equal(parsed.workloads.hls_viewers.requests, 2);
      assert.equal(parsed.workloads.hls_viewers.failed, 0);

      // Verify timestamp freshness update
      const updatedSec = nowSec + 10;
      const updatedPayload = buildTelemetryPayload(apiCounts, hlsCounts, updatedSec, 60);
      const parsedUpdated = parseHttpErrorRate(updatedPayload, {
        isPreflight: false,
        nowSec: updatedSec,
      });
      assert.equal(parsedUpdated.error, undefined);
      assert.equal(parsedUpdated.timestamp, updatedSec);
    });

    it('StreamTailer reads appended NDJSON files and respects rolling 60s window', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-test-'));
      const logFile = path.join(tmpDir, 'stream.ndjson');

      try {
        const tailer = new StreamTailer(logFile);
        tailer.poll(); // File doesn't exist yet, should not throw
        assert.deepEqual(tailer.getCounts(60000), { requests: 0, failed: 0 });

        const now = Date.now();
        // Point older than 60s (stale)
        const oldPoint = JSON.stringify({
          type: 'Point',
          data: { time: new Date(now - 70000).toISOString(), value: 1 },
          metric: 'http_reqs',
        });
        // Points within 60s (active)
        const activePoint1 = JSON.stringify({
          type: 'Point',
          data: { time: new Date(now - 20000).toISOString(), value: 1 },
          metric: 'http_reqs',
        });
        const activeFail = JSON.stringify({
          type: 'Point',
          data: { time: new Date(now - 20000).toISOString(), value: 1 },
          metric: 'http_req_failed',
        });
        const activePoint2 = JSON.stringify({
          type: 'Point',
          data: { time: new Date(now - 5000).toISOString(), value: 1 },
          metric: 'http_reqs',
        });

        fs.writeFileSync(logFile, `${oldPoint}\n${activePoint1}\n${activeFail}\n`);
        tailer.poll();

        const counts1 = tailer.getCounts(60000, now);
        // oldPoint is excluded by 60s window
        assert.deepEqual(counts1, { requests: 1, failed: 1 });

        // Append more points incrementally
        fs.appendFileSync(logFile, `${activePoint2}\n`);
        tailer.poll();

        const counts2 = tailer.getCounts(60000, now);
        assert.deepEqual(counts2, { requests: 2, failed: 1 });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it(
      'StreamTailer stays fast at production rates (regression: shift() pruning froze the feeder)',
      { timeout: 30000 },
      () => {
        // 3000 req/s for 2 minutes, 15 k6 metric lines per request, as the sim workflow produced in PR #329.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-perf-'));
        const logFile = path.join(tmpDir, 'stream.ndjson');
        const others = ['http_req_duration', 'http_req_waiting', 'data_received', 'iterations'];
        try {
          const now = Date.now();
          const perSecond = 3000;
          const lines = [];
          for (let s = 120; s > 0; s--) {
            const time = new Date(now - s * 1000 + 500).toISOString();
            const req = JSON.stringify({
              type: 'Point',
              metric: 'http_reqs',
              data: { time, value: 1, tags: { status: '200' } },
            });
            const ok = JSON.stringify({
              type: 'Point',
              metric: 'http_req_failed',
              data: { time, value: 0 },
            });
            const noise = others.map((m) =>
              JSON.stringify({ type: 'Point', metric: m, data: { time, value: 1 } }),
            );
            for (let i = 0; i < perSecond; i++) lines.push(req, ok, ...noise);
          }
          fs.writeFileSync(logFile, lines.join('\n') + '\n');

          const tailer = new StreamTailer(logFile);
          const t0 = performance.now();
          tailer.poll();
          const counts = tailer.getCounts(60000, now);
          const again = tailer.getCounts(60000, now + 10000); // the next tick prunes 10 s more
          const elapsed = performance.now() - t0;

          // 60 s window = 60 full seconds of 3000 requests (the bucket holding the cutoff is included)
          assert.ok(
            counts.requests >= 60 * perSecond && counts.requests <= 61 * perSecond,
            `requests=${counts.requests}`,
          );
          assert.equal(counts.failed, 0);
          assert.ok(
            again.requests >= 50 * perSecond && again.requests <= 51 * perSecond,
            `requests=${again.requests}`,
          );
          assert.ok(tailer.buckets.size <= 61, `buckets=${tailer.buckets.size}`);
          assert.ok(elapsed < 5000, `poll + 2 getCounts took ${elapsed.toFixed(0)} ms`);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );

    it('verifies lt2-run.sh k6 volume mount (-v ...:/work -w /work) and user permissions', () => {
      const runSh = fs.readFileSync(path.join(process.cwd(), 'loadtest/lt2-run.sh'), 'utf8');

      assert.ok(
        runSh.includes('-v "${REPO_ROOT}/loadtest:/work"'),
        'lt2-run.sh must mount ${REPO_ROOT}/loadtest at /work',
      );
      assert.ok(
        runSh.includes('-w /work'),
        'lt2-run.sh must specify container working directory -w /work',
      );
      assert.ok(
        runSh.includes('-u "$(id -u):$(id -g)"'),
        'lt2-run.sh must run with user id -u $(id -u):$(id -g) to keep results writable',
      );
      assert.ok(
        runSh.includes('--out json=/work/results/hls.ndjson'),
        'lt2-run.sh must pass --out json for hls-viewers',
      );
      assert.ok(
        runSh.includes('--out json=/work/results/api.ndjson'),
        'lt2-run.sh must pass --out json for api-read',
      );
      assert.ok(
        runSh.includes('telemetry-feeder.mjs'),
        'lt2-run.sh must launch telemetry-feeder.mjs',
      );
      assert.doesNotMatch(
        runSh,
        /-v "\$\(pwd\):\/loadtest"/,
        'lt2-run.sh must not use the broken $(pwd):/loadtest mount',
      );
      assert.doesNotMatch(
        runSh,
        /run \/loadtest\/hls-viewers\.js/,
        'lt2-run.sh must run hls-viewers.js relative to /work',
      );
    });

    it('runs lt2-run.sh with telemetry feeder and k6 mount against local stub target', async () => {
      // Check if Docker daemon is running
      const dockerCheck = spawnSync('docker', ['info']);
      if (dockerCheck.status !== 0) {
        // Skip live container execution if Docker daemon is unavailable locally (runs in CI)
        return;
      }

      const server = http.createServer((req, res) => {
        if (req.url?.includes('MemAvailable')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'success',
              data: {
                resultType: 'vector',
                result: [
                  {
                    metric: { __name: 'node_memory_MemAvailable_bytes' },
                    value: [Date.now() / 1000, '4294967296'],
                  },
                ],
              },
            }),
          );
        } else if (req.url?.includes('/v1/videos')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([{ id: 'test-clip-1', visibility: 'PUBLIC' }]));
        } else if (req.url?.includes('/v1/cinema/catalog')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const targetUrl = `http://127.0.0.1:${port}`;
      const fakeMetrics = `http://127.0.0.1:${port}/metrics`;

      try {
        const res = spawnSync('./loadtest/lt2-run.sh', [], {
          env: {
            ...process.env,
            TARGET_URL: targetUrl,
            EDGE_METRICS_URL: fakeMetrics,
            LEGACY_SITES: `${targetUrl}/1,${targetUrl}/2,${targetUrl}/3,${targetUrl}/4`,
            VUS: '1',
            DURATION: '2s',
          },
          encoding: 'utf8',
          timeout: 45000,
        });

        const combinedOutput = (res.stdout || '') + (res.stderr || '');
        // Verify k6 does NOT complain about missing moduleSpecifier /loadtest/...
        assert.doesNotMatch(
          combinedOutput,
          /The moduleSpecifier .* couldn't be found/,
          'k6 should find its scripts under /work',
        );
        // Verify telemetry feeder started
        assert.match(combinedOutput, /Starting error telemetry feeder/);
      } finally {
        server.close();
      }
    });
  });
});
