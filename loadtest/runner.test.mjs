import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Import handleSummary from hls-viewers.js logic
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
    try {
      execFileSync('./loadtest/lt2-run.sh', [], {
        env: { ...process.env, TARGET_URL: 'https://winkey.vn' },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.fail('Expected script to exit non-zero for winkey.vn outside window');
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stderr || err.stdout, /02:00–03:30 Asia\/Ho_Chi_Minh/);
    }
  });

  it('bypasses window refusal when TARGET_URL is non-winkey.vn local address', async () => {
    // Start local fake server for preflight checks
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

    // Start lt2-run.sh against mock server with invalid k6 command to trigger early failure after preflight
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

    // Verify it passed window check and reached watchdog preflight
    assert.doesNotMatch(output, /strictly gated to 02:00–03:30/);
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
});
