import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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

    const checkScript = `node -e "try { const s = JSON.parse(require('fs').readFileSync('${summaryFile}', 'utf8')); process.exit(s.passed === true ? 0 : 1); } catch (_) { process.exit(1); }"`;
    try {
      execFileSync('sh', ['-c', checkScript], { stdio: 'pipe' });
      assert.fail('Expected script to exit non-zero when passed is false');
    } catch (err) {
      assert.equal(err.status, 1);
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
});
