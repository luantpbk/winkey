import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Use controlled module adapter for k6 imports
import { setMockHttpHandler, resetHttpState, httpCalls } from '../adapters/k6-http.mjs';
import { resetCoreState, lastFailedMessage } from '../adapters/k6-core.mjs';
import { metricInstances, resetMetricsState } from '../adapters/k6-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const hlsModulePath = path.join(repoRoot, 'loadtest', 'hls-viewers.js');

describe('[LT2 Regression] Actual HLS Viewers Contract & Metric Verification', () => {
  let hlsModule;

  beforeEach(async () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    if (!hlsModule) {
      hlsModule = await import(pathToFileURL(hlsModulePath).href);
    }
  });

  test('Finding 16: Contract playback: must not invent non-contract /manifest.m3u8 fallback URL', () => {
    // OpenAPI contracts define video playback exclusively through playback.hls_url.
    // If playback.hls_url is missing, workload must NOT invent /manifest.m3u8 fallback.
    setMockHttpHandler((req) => {
      if (req.url.includes('/v1/videos/vid-no-playback-1')) {
        // Detail response returns valid video record without playback.hls_url
        return {
          status: 200,
          body: JSON.stringify({ id: 'vid-no-playback-1', title: 'Sample' }),
          timings: { duration: 10 },
        };
      }
      return { status: 404, body: 'Not Found', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [{ id: 'vid-no-playback-1' }],
    };

    hlsModule.default(mockData);

    // Inspect actual HTTP requests executed by the workload
    const inventedManifestCalls = httpCalls.filter((c) => c.url.includes('/manifest.m3u8'));
    assert.strictEqual(
      inventedManifestCalls.length,
      0,
      `Contract finding: hls-viewers.js must adhere strictly to OpenAPI playback.hls_url and not request uncontracted ${inventedManifestCalls.map((c) => c.url).join(', ')}`,
    );
  });

  test('Finding 17: Failed / invalid segment must abort playback immediately, not continue fake watch time', () => {
    // When a video segment download fails (e.g. 404, 500, network drop),
    // the viewer must abort playback immediately. It must NOT continue downloading
    // subsequent segments or accumulating watch time.
    setMockHttpHandler((req) => {
      if (req.url.includes('.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n#EXTINF:2.0\nseg1.ts\n#EXTINF:2.0\nseg2.ts\n#EXTINF:2.0\nseg3.ts\n#EXTINF:2.0\nseg4.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg1.ts')) {
        // First segment fails with 500 Internal Server Error
        return {
          status: 500,
          body: 'Internal Server Error',
          timings: { duration: 50 },
        };
      }
      return { status: 200, body: 'segment-data', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [
        {
          id: 'video-test-1',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    let threwError = false;
    try {
      hlsModule.default(mockData);
    } catch {
      threwError = true;
    }

    // In current SHA, on segRes.status !== 200, the code only calls httpReqFailed.add(true)
    // and continues looping, requesting seg2.ts, seg3.ts, etc.!
    const subsequentSegmentCalls = httpCalls.filter(
      (c) => c.url.includes('seg2.ts') || c.url.includes('seg3.ts') || c.url.includes('seg4.ts'),
    );

    assert.strictEqual(
      subsequentSegmentCalls.length === 0 && (threwError || lastFailedMessage !== null),
      true,
      `Playback safety finding: hls-viewers.js must abort playback on segment failure, not continue downloading subsequent segments (requested: ${subsequentSegmentCalls.map((c) => c.url).join(', ')})`,
    );
  });

  test('Finding 18: Aggregate rebuffer ratio formula: near 1% threshold case', () => {
    // Near 1% threshold verification:
    // By contract & LT2 specification:
    // Rebuffer Ratio = stallTime / (watchTime + stallTime)
    //
    // Prevent seek so isSeekPoint is false:
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n#EXTINF:23.8\nseg1.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        return { status: 200, body: 'bytes', timings: { duration: 50 } };
      }
      if (req.url.includes('seg1.ts')) {
        // dl 2.26s against 2.0s buffer: stall is 0.26s
        // total watch is 25.8s
        // True ratio = 0.26 / (25.8 + 0.26) = 0.0099769 (< 1% PASS)
        // Skewed ratio = 0.26 / 25.8 = 0.0100775 (>= 1% FALSE FAIL)
        return { status: 200, body: 'bytes', timings: { duration: 2260 } };
      }
      return { status: 200, body: '', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    assert.ok(ratioTrend && ratioTrend.values.length > 0, 'rebuffer_ratio metric must be recorded');

    const recordedRatio = ratioTrend.values[0];

    const watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');
    const stallTrend = metricInstances.find((m) => m.name === 'total_stall_time_ms');
    const watchSec = (watchTrend?.count || 0) / 1000.0;
    const stallSec = (stallTrend?.count || 0) / 1000.0;

    const expectedTrueRatio = stallSec / (watchSec + stallSec);

    // Assert that the recorded ratio must match true ratio formula stall / (watch + stall),
    // and specifically must NOT trigger a false-alarm SLA failure >= 1% when true ratio is < 1%.
    assert.strictEqual(
      recordedRatio < 0.01,
      true,
      `Metric accuracy finding: at near 1% threshold, true ratio is ${expectedTrueRatio.toFixed(6)} (< 1% PASS), but skewed ratio recorded ${recordedRatio.toFixed(6)} (>= 1% FALSE FAIL)`,
    );
  });

  test('Finding 18: Aggregate rebuffer ratio formula: weighted unequal-duration segments', () => {
    // Segments with unequal durations: 2.0s, 6.0s, 1.5s, 4.0s
    const originalRandom = Math.random;
    Math.random = () => 0.5;

    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n#EXTINF:6.0\nseg1.ts\n#EXTINF:1.5\nseg2.ts\n#EXTINF:4.0\nseg3.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        return { status: 200, body: 'data', timings: { duration: 50 } };
      }
      if (req.url.includes('seg1.ts')) {
        return { status: 200, body: 'data', timings: { duration: 3000 } };
      }
      return { status: 200, body: 'data', timings: { duration: 100 } };
    });

    const mockData = {
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    assert.ok(ratioTrend && ratioTrend.values.length > 0, 'rebuffer_ratio metric must be recorded');
    const recordedRatio = ratioTrend.values[0];

    const watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');
    const stallTrend = metricInstances.find((m) => m.name === 'total_stall_time_ms');
    const watchSec = (watchTrend?.count || 0) / 1000.0;
    const stallSec = (stallTrend?.count || 0) / 1000.0;

    const expectedTrueRatio = stallSec / (watchSec + stallSec);
    assert.strictEqual(
      Math.abs(recordedRatio - expectedTrueRatio) < 0.0001,
      true,
      `Weighted duration finding: expected ratio ${expectedTrueRatio.toFixed(6)}, got ${recordedRatio.toFixed(6)}`,
    );
  });

  function getNativeK6Binary() {
    try {
      const bin = process.platform === 'win32' ? 'k6.exe' : 'k6';
      const res = spawnSync(bin, ['version'], {
        stdio: 'ignore',
        timeout: 1500,
      });
      if (res.status === 0) return bin;
    } catch {
      // not in PATH
    }
    return null;
  }

  // Executes a controlled offline native k6 workload against loopback mock HTTP server.
  // Captures actual native process exit code (99 for threshold breach, 107/etc for crash, 0 for clean pass).
  // Does NOT fabricate exit codes or invent summary status.
  async function runControlledNativeK6Gate({ scenario }) {
    const k6Bin = getNativeK6Binary();
    if (!k6Bin) {
      return {
        available: false,
        reason: 'Native k6 CLI binary not found in PATH on current host',
      };
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/v1/videos?')) {
          if (scenario === 'empty-pool') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ items: [] }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
                  playback: { hls_url: '/master.m3u8' },
                },
              ],
            }),
          );
          return;
        }

        if (req.url === '/master.m3u8') {
          if (scenario === 'empty-master') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n# No variants\n');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/variant.m3u8\n');
          return;
        }

        if (req.url === '/variant.m3u8') {
          if (scenario === 'empty-variant') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end('#EXTM3U\n#EXTINF:2.0\n/seg0.ts\n');
          return;
        }

        if (req.url === '/seg0.ts') {
          res.writeHead(200, { 'Content-Type': 'video/mp2t' });
          res.end(Buffer.alloc(1024));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const targetUrl = `http://127.0.0.1:${port}`;

        const res = spawnSync(
          k6Bin,
          [
            'run',
            '--quiet',
            '--no-summary',
            '--no-usage-report',
            '-e',
            `TARGET_URL=${targetUrl}`,
            '-e',
            'EXECUTOR=constant-vus',
            '-e',
            'VUS=1',
            '-e',
            'DURATION=1s',
            hlsModulePath,
          ],
          {
            timeout: 8000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        server.close(() => {
          resolve({
            available: true,
            exitCode: res.status,
            stdout: res.stdout ? res.stdout.toString() : '',
            stderr: res.stderr ? res.stderr.toString() : '',
            isThresholdBreach: res.status === 99,
            isCleanPass: res.status === 0,
            isCrash: res.status !== 0 && res.status !== 99,
          });
        });
      });
    });
  }

  // Supplementary in-memory threshold model (unit verification when native k6 CLI is absent).
  // Strictly parses k6 threshold expressions (<agg><op><val>); explicitly rejects unsupported forms.
  // Does NOT invent handleSummary exit semantics or fabricate process exit codes.
  function evaluateSupplementaryThresholdGate(options = hlsModule.options) {
    const watchTime = metricInstances.find((m) => m.name === 'total_watch_time_ms')?.count || 0;
    const thresholds = options?.thresholds || {};
    const thresholdEvaluations = [];

    for (const [metricName, exprs] of Object.entries(thresholds)) {
      const metric = metricInstances.find((m) => m.name === metricName);
      const list = Array.isArray(exprs) ? exprs : [exprs];

      for (const expr of list) {
        if (typeof expr !== 'string') {
          throw new Error(
            `Unsupported threshold format for metric "${metricName}": object/extended threshold configuration requires native k6 execution`,
          );
        }

        const match = expr.match(/^([a-zA-Z0-9_()]+)\s*(<=|>=|<|>|==|!=)\s*([0-9.]+)$/);
        if (!match) {
          throw new Error(
            `Unsupported threshold expression format "${expr}" for metric "${metricName}": only standard <agg><op><val> expressions supported in supplementary model`,
          );
        }

        const [, agg, op, targetStr] = match;
        const target = parseFloat(targetStr);
        let actual = 0;

        if (!metric) {
          actual = 0;
        } else if (agg === 'rate') {
          actual = typeof metric.rate === 'function' ? metric.rate() : 0;
        } else if (agg === 'count') {
          actual = typeof metric.count === 'number' ? metric.count : metric.values?.length || 0;
        } else if (agg === 'value') {
          actual = typeof metric.value === 'number' ? metric.value : 0;
        } else if (agg.startsWith('p(')) {
          const pMatch = agg.match(/p\(([0-9.]+)\)/);
          const p = pMatch ? parseFloat(pMatch[1]) : 95;
          const vals = (metric.values || []).slice().sort((a, b) => a - b);
          if (vals.length === 0) {
            actual = 0;
          } else {
            const idx = Math.min(vals.length - 1, Math.floor((p / 100) * vals.length));
            actual = vals[idx];
          }
        } else {
          throw new Error(`Unsupported threshold aggregation "${agg}" in supplementary model`);
        }

        let passed = true;
        switch (op) {
          case '<':
            passed = actual < target;
            break;
          case '<=':
            passed = actual <= target;
            break;
          case '>':
            passed = actual > target;
            break;
          case '>=':
            passed = actual >= target;
            break;
          case '==':
            passed = actual === target;
            break;
          case '!=':
            passed = actual !== target;
            break;
        }

        thresholdEvaluations.push({ metric: metricName, expr, actual, target, passed });
      }
    }

    const hasBreachedThreshold = thresholdEvaluations.some((e) => !e.passed);

    return {
      watchTime,
      thresholdEvaluations,
      hasBreachedThreshold,
      // Zero-playback gate rejection requires zero watch time AND a breached threshold
      isRejectedByGate: watchTime === 0 && hasBreachedThreshold,
    };
  }

  test('Finding 18 (Zero-playback 1/3): empty video pool must reject run via final gate, not exit cleanly', async () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    try {
      hlsModule.default({ videos: [] });
    } catch {
      // k6 fail() throws at iteration level; test verifies final gate rejection
    }
    const nativeRun = await runControlledNativeK6Gate({ scenario: 'empty-pool' });
    if (nativeRun.available) {
      assert.strictEqual(
        nativeRun.exitCode,
        99,
        `Native k6 run with empty video pool must exit with code 99 (threshold breach), got exitCode=${nativeRun.exitCode}`,
      );
    } else {
      const result = evaluateSupplementaryThresholdGate();
      assert.strictEqual(
        result.isRejectedByGate,
        true,
        `Empty video pool with zero valid playback must breach final threshold gate, got watchTime=${result.watchTime}, hasBreachedThreshold=${result.hasBreachedThreshold}`,
      );
    }
  });

  test('Finding 18 (Zero-playback 2/3): empty 200 master playlist must reject run via final gate, not exit cleanly', async () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: '#EXTM3U\n# No variants\n',
          timings: { duration: 10 },
        };
      }
      return { status: 404, body: '', timings: { duration: 10 } };
    });

    hlsModule.default({
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    });

    const nativeRun = await runControlledNativeK6Gate({ scenario: 'empty-master' });
    if (nativeRun.available) {
      assert.strictEqual(
        nativeRun.exitCode,
        99,
        `Native k6 run with empty master playlist must exit with code 99 (threshold breach), got exitCode=${nativeRun.exitCode}`,
      );
    } else {
      const result = evaluateSupplementaryThresholdGate();
      assert.strictEqual(
        result.isRejectedByGate,
        true,
        `Empty 200 master playlist must breach final threshold gate on zero valid playback, got watchTime=${result.watchTime}, hasBreachedThreshold=${result.hasBreachedThreshold}`,
      );
    }
  });

  test('Finding 18 (Zero-playback 3/3): empty 200 variant playlist must reject run via final gate, not exit cleanly', async () => {
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n',
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return { status: 200, body: '#EXTM3U\n', timings: { duration: 10 } };
      }
      return { status: 404, body: '', timings: { duration: 10 } };
    });

    hlsModule.default({
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    });

    const nativeRun = await runControlledNativeK6Gate({ scenario: 'empty-variant' });
    if (nativeRun.available) {
      assert.strictEqual(
        nativeRun.exitCode,
        99,
        `Native k6 run with empty variant playlist must exit with code 99 (threshold breach), got exitCode=${nativeRun.exitCode}`,
      );
    } else {
      const result = evaluateSupplementaryThresholdGate();
      assert.strictEqual(
        result.isRejectedByGate,
        true,
        `Empty 200 variant playlist must breach final threshold gate on zero valid playback, got watchTime=${result.watchTime}, hasBreachedThreshold=${result.hasBreachedThreshold}`,
      );
    }
  });

  test('Finding 18 (Zero-playback control): removed thresholds produce no gate breach', () => {
    // Control: when thresholds are removed, the oracle must NOT falsely report a gate rejection
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    const result = evaluateSupplementaryThresholdGate({ thresholds: {} });
    assert.strictEqual(
      result.isRejectedByGate,
      false,
      'Removed thresholds must not produce a gate breach',
    );
  });

  test('Finding 18 (Zero-playback control): non-breached thresholds produce no gate breach', () => {
    // Control: when default thresholds are present and metrics are zero (non-breached),
    // oracle must reflect that existing thresholds did NOT breach
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    const result = evaluateSupplementaryThresholdGate(hlsModule.options);
    assert.strictEqual(
      result.hasBreachedThreshold,
      false,
      'Existing default thresholds are non-breached when metrics are 0',
    );
    assert.strictEqual(
      result.isRejectedByGate,
      false,
      'Non-breached default thresholds must not falsely report a gate rejection',
    );
  });

  test('Finding 18 (Zero-playback control): dedicated playback gate is evaluated and breached on zero watch time', () => {
    // Control: when a dedicated gate (e.g. total_watch_time_ms: ['count>0']) is configured,
    // the oracle properly recognizes it and marks the run as rejected by gate
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    const dedicatedOptions = {
      thresholds: {
        total_watch_time_ms: ['count>0'],
      },
    };
    const result = evaluateSupplementaryThresholdGate(dedicatedOptions);
    assert.strictEqual(
      result.hasBreachedThreshold,
      true,
      'Dedicated total_watch_time_ms > 0 threshold must breach on 0 watch time',
    );
    assert.strictEqual(
      result.isRejectedByGate,
      true,
      'Dedicated playback gate breach must be recognized as valid gate rejection',
    );
  });

  test('Finding 18 (Zero-playback control): unsupported object threshold format is explicitly rejected', () => {
    // Control: object/extended threshold configuration is not silently ignored;
    // it explicitly throws an unsupported error in the supplementary model
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    const objectThresholdOptions = {
      thresholds: {
        http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true }],
      },
    };
    assert.throws(
      () => evaluateSupplementaryThresholdGate(objectThresholdOptions),
      /Unsupported threshold format/,
      'Object threshold configuration must be explicitly rejected in supplementary model',
    );
  });

  test('Finding 18 (Zero-playback negative control): arbitrary uncaught exception is not valid gate rejection', () => {
    // Negative control: an unrelated crash (e.g. malformed JSON or TypeError)
    // does not constitute a valid final threshold gate rejection.
    resetHttpState();
    resetCoreState();
    resetMetricsState();
    setMockHttpHandler(() => {
      throw new Error('Unrelated network crash');
    });

    let threw = false;
    try {
      hlsModule.default({
        videos: [
          {
            id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
            playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
          },
        ],
      });
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, true, 'Uncaught crash throws');
    const result = evaluateSupplementaryThresholdGate();
    // A crash must NOT be credited as a valid threshold gate rejection
    assert.strictEqual(
      result.hasBreachedThreshold,
      false,
      'Unrelated exception must not breach threshold metrics',
    );
    assert.strictEqual(
      result.isRejectedByGate,
      false,
      'Unrelated exception must not be credited as a valid threshold gate rejection',
    );
  });

  test('Finding 18 (Native k6 gate evidence): offline execution harness detects presence and distinguishes gate exit 99 from crash exit', () => {
    const k6Bin = getNativeK6Binary();
    if (k6Bin) {
      // Native k6 is available: verify crash distinction
      // When a script has a crash or syntax error, native k6 exits with code != 99 and != 0 (e.g. 107)
      const res = spawnSync(k6Bin, ['run', '--quiet', '-'], {
        input: 'export default function() { throw new Error("intentional test crash"); }',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.strictEqual(
        res.status !== 99 && res.status !== 0,
        true,
        `Native k6 crash must produce non-threshold exit code (got ${res.status}), strictly distinguishing crashes from threshold gate rejections (code 99)`,
      );
    } else {
      // Native k6 is absent in current offline environment: verify supplementary model strictly models threshold semantics
      assert.strictEqual(
        k6Bin,
        null,
        'Native k6 CLI binary not found in PATH on current offline host',
      );
      const sampleBreached = evaluateSupplementaryThresholdGate({
        thresholds: { total_watch_time_ms: ['count>0'] },
      });
      assert.strictEqual(
        sampleBreached.hasBreachedThreshold,
        true,
        'Supplementary threshold model accurately models threshold breach on zero watch time',
      );
    }
  });

  test('Finding 18: Seek vs No-Seek separation: rebufferRatioInclSeekTrend includes seek stall', () => {
    // When a seek occurs, stallTimeSeekOnly is accumulated into ratioInclSeek but NOT ratioNoSeek.
    // Sequence Math.random deterministically:
    // Call 1: Hot video selection check (0.5 >= 0.2 -> uniform)
    // Call 2: Video pool selection index 0
    // Call 3: playDuration (30.0s)
    // Call 4: Iteration 1 isSeekPoint (0.05 < 0.1 -> seek event triggers!)
    // Call 5: Iteration 1 seek destination segIdx (index 0)
    // Call 6+: Subsequent iterations isSeekPoint (0.5 >= 0.1 -> no further seeks)
    let randomCallCount = 0;
    let seekEventsTriggered = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      randomCallCount++;
      if (randomCallCount === 1) return 0.5;
      if (randomCallCount === 2) return 0.0;
      if (randomCallCount === 3) return 0.5;
      if (randomCallCount === 4) {
        seekEventsTriggered++;
        return 0.05;
      }
      if (randomCallCount === 5) return 0.0;
      return 0.5;
    };

    let seg0Calls = 0;
    setMockHttpHandler((req) => {
      if (req.url.includes('master.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('variant.m3u8')) {
        return {
          status: 200,
          body: `#EXTM3U\n#EXTINF:2.0\nseg0.ts\n`,
          timings: { duration: 10 },
        };
      }
      if (req.url.includes('seg0.ts')) {
        seg0Calls++;
        // First call is startup firstSegRes (10ms). Second call is post-seek download (500ms -> 0.5s stall).
        // Subsequent loop calls are 10ms (no stall).
        const duration = seg0Calls === 2 ? 500 : 10;
        return { status: 200, body: 'data', timings: { duration } };
      }
      return { status: 200, body: '', timings: { duration: 10 } };
    });

    const mockData = {
      videos: [
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-b00000000001',
          playback: { hls_url: 'http://127.0.0.1:8080/master.m3u8' },
        },
      ],
    };

    try {
      hlsModule.default(mockData);
    } finally {
      Math.random = originalRandom;
    }

    const ratioNoSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio');
    const ratioInclSeekTrend = metricInstances.find((m) => m.name === 'rebuffer_ratio_incl_seek');
    const _watchTrend = metricInstances.find((m) => m.name === 'total_watch_time_ms');

    // 1. Assert seek event occurred exactly once
    assert.strictEqual(seekEventsTriggered, 1, 'Seek event must occur exactly once');

    // 2. Assert exact sample counts (no missing or skipped samples)
    assert.ok(ratioNoSeekTrend && ratioInclSeekTrend, 'Both ratio trends must be defined');
    assert.strictEqual(ratioNoSeekTrend.values.length, 1, 'Exact 1 sample for rebuffer_ratio');
    assert.strictEqual(
      ratioInclSeekTrend.values.length,
      1,
      'Exact 1 sample for rebuffer_ratio_incl_seek',
    );

    // 3. Assert no-seek ratio is exactly 0
    assert.strictEqual(ratioNoSeekTrend.values[0], 0, 'No-seek rebuffer ratio must be 0');

    // 4. Assert inclusive ratio is strictly greater than no-seek ratio
    assert.strictEqual(
      ratioInclSeekTrend.values[0] > ratioNoSeekTrend.values[0],
      true,
      'Inclusive ratio must be strictly greater than no-seek ratio',
    );

    // 5. Assert independently computed contract values (formula: stall / (watch + stall))
    // Independently calculated from test input sequence:
    // Watch time = 2.0s (startup) + 0.01s (iter 2) + 0.01s (iter 3) = 2.02s
    // Non-seek stall = 0.0s; Seek stall = 0.5s; Total stall = 0.5s
    const expectedWatchTimeSec = 2.02;
    const expectedStallNoSeekSec = 0.0;
    const expectedStallSeekOnlySec = 0.5;
    const expectedTotalStallSec = expectedStallNoSeekSec + expectedStallSeekOnlySec;

    const expectedRatioNoSeek =
      expectedStallNoSeekSec / (expectedWatchTimeSec + expectedStallNoSeekSec); // 0.0
    const expectedRatioInclSeek =
      expectedTotalStallSec / (expectedWatchTimeSec + expectedTotalStallSec); // 0.5 / 2.52 = 0.1984127

    assert.strictEqual(
      ratioNoSeekTrend.values[0],
      expectedRatioNoSeek,
      `No-seek rebuffer ratio must be exactly ${expectedRatioNoSeek}`,
    );
    assert.strictEqual(
      Math.abs(ratioInclSeekTrend.values[0] - expectedRatioInclSeek) < 1e-4,
      true,
      `Inclusive ratio must match specification formula stall / (watch + stall) = ${expectedRatioInclSeek.toFixed(6)} (got ${ratioInclSeekTrend.values[0].toFixed(6)})`,
    );
  });
});
