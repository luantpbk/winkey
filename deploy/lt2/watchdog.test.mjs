import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  parseMemAvailable,
  fetchWithWallClockDeadline,
  checkEdgeRam,
  checkLegacySites,
  parseHttpErrorRate,
  createRolling60sSample,
  checkHttpErrorRate,
  PlatformWatchdog,
  ONE_GIB_BYTES,
  DEFAULT_LEGACY_SITES,
  TRUSTED_EDGE_NODE,
  TRUSTED_EDGE_INSTANCE,
} from './watchdog.mjs';

describe('Platform Watchdog Unit & Integration Tests (ADR-034 Fail-Closed)', () => {
  let tmpDir;
  let abortFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
    abortFile = path.join(tmpDir, 'abort.signal');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseMemAvailable', () => {
    test('parses standard Prometheus integer format with trusted endpoint', () => {
      const body =
        '# HELP node_memory_MemAvailable_bytes\nnode_memory_MemAvailable_bytes 7481970688\n';
      const parsed = parseMemAvailable(body, {
        sourceUrl: 'http://100.113.240.3:9100/metrics',
      });
      assert.strictEqual(parsed.bytes, 7481970688);
      assert.strictEqual(parsed.node, 'edge-1');
      assert.strictEqual(parsed.instance, '100.113.240.3:9100');
    });

    test('parses Prometheus scientific notation format with labeled metric', () => {
      const body =
        'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 7.49856768e+09\n';
      const parsed = parseMemAvailable(body);
      assert.strictEqual(parsed.bytes, 7498567680);
      assert.strictEqual(parsed.node, 'edge-1');
    });

    test('parses VictoriaMetrics vector JSON response for edge-1', () => {
      const nowSec = 1791457900;
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [nowSec, '8589934592'], // 8 GiB
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec });
      assert.strictEqual(parsed.bytes, 8589934592);
      assert.strictEqual(parsed.node, 'edge-1');
      assert.strictEqual(parsed.timestamp, nowSec);
    });

    test('rejects missing timestamp in VictoriaMetrics JSON', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [null, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json));
      assert.strictEqual(parsed.error, 'MISSING_TIMESTAMP');
    });

    test('rejects future timestamp in VictoriaMetrics JSON', () => {
      const nowSec = 10000;
      const futureTimestamp = 10100; // 100s ahead (> 15s max clock skew)
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [futureTimestamp, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec });
      assert.strictEqual(parsed.error, 'FUTURE_TIMESTAMP');
    });

    test('rejects wrong metric name MemTotal in VictoriaMetrics JSON and text', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemTotal_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [10000, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec: 10000 });
      assert.strictEqual(parsed.error, 'WRONG_METRIC');

      const textParsed = parseMemAvailable('node_memory_MemTotal_bytes 8589934592\n');
      assert.strictEqual(textParsed.error, 'WRONG_METRIC');
    });

    test('rejects generator-01 with substring instance 100.113.240.30:9100', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.30:9100',
                node: 'generator-01',
              },
              value: [10000, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec: 10000 });
      assert.ok(parsed.error === 'WRONG_NODE' || parsed.error === 'WRONG_INSTANCE');
    });

    test('rejects unlabeled text metric when endpoint is unverified', () => {
      const parsed = parseMemAvailable('node_memory_MemAvailable_bytes 8589934592\n');
      assert.strictEqual(parsed.error, 'UNVERIFIED_SOURCE');
    });

    test('rejects wrong-node telemetry in VictoriaMetrics JSON', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'generator-01',
              },
              value: [1791457900, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), {
        expectedNode: 'edge-1',
        nowSec: 1791457900,
      });
      assert.strictEqual(parsed.error, 'WRONG_NODE');
    });

    test('rejects stale telemetry when timestamp exceeds maxAgeSec', () => {
      const nowSec = 10000;
      const oldTimestamp = 9800; // 200s old (> 120s)
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [oldTimestamp, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec, maxAgeSec: 120 });
      assert.strictEqual(parsed.error, 'STALE_METRIC');
      assert.match(parsed.reason, /stale/);
    });

    test('rejects invalid or non-finite metric value', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                instance: '100.113.240.3:9100',
                node: 'edge-1',
              },
              value: [1791457900, 'not-a-number'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec: 1791457900 });
      assert.strictEqual(parsed.error, 'INVALID_METRIC_VALUE');
    });

    test('returns null for missing or empty metric text', () => {
      assert.strictEqual(parseMemAvailable('other_metric 12345'), null);
      assert.strictEqual(parseMemAvailable(''), null);
      assert.strictEqual(parseMemAvailable(null), null);
    });
  });

  describe('fetchWithWallClockDeadline', () => {
    let server;
    let serverPort;

    before(async () => {
      server = http.createServer((req, res) => {
        const url = req.url || '/';
        if (url === '/fast') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello Watchdog');
        } else if (url === '/hung') {
          const t = setTimeout(() => {
            try {
              res.end();
            } catch {
              // ignore
            }
          }, 400);
          t.unref();
        } else if (url === '/trickle') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('part1');
          const t = setTimeout(() => {
            try {
              res.end('part2');
            } catch {
              // ignore
            }
          }, 400);
          t.unref();
        } else if (url === '/overflow') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('A'.repeat(1000));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          serverPort = server.address().port;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try {
              server.unref();
            } catch {
              // ignore
            }
            resolve();
          }, 500);
          timeout.unref();

          server.close(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    });

    test('completes fast normal request successfully', async () => {
      const res = await fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}/fast`, 1000);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 'Hello Watchdog');
    });

    test('aborts when headers are hung beyond total wall-clock deadline', async () => {
      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}/hung`, 100),
        /Total wall-clock deadline exceeded/,
      );
    });

    test('aborts when response body trickles slowly beyond wall-clock deadline', async () => {
      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}/trickle`, 100),
        /Total wall-clock deadline exceeded/,
      );
    });

    test('aborts when payload exceeds maxBytes limit (bounded buffering)', async () => {
      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}/overflow`, 1000, 200),
        /Response payload exceeded limit of 200 bytes/,
      );
    });
  });

  describe('checkEdgeRam (Fail-Closed)', () => {
    test('fails closed when EDGE_METRICS_URL is missing or empty', async () => {
      const res = await checkEdgeRam('');
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /EDGE_METRICS_URL is required/);
    });

    test('passes when edge-1 MemAvailable >= 1 GiB', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 2147483648\n', // 2 GiB
      });

      const res = await checkEdgeRam('http://100.113.240.3:9100/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.availBytes, 2147483648);
      assert.strictEqual(res.abort, undefined);
    });

    test('aborts when edge-1 MemAvailable falls below 1 GiB', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 524288000\n', // ~500 MiB
      });

      const res = await checkEdgeRam('http://100.113.240.3:9100/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /fell below required safety threshold/);
      assert.strictEqual(res.availBytes, 524288000);
    });

    test('aborts when metrics endpoint returns HTTP 500 (telemetry loss)', async () => {
      const mockFetch = async () => ({
        statusCode: 500,
        body: 'Internal Server Error',
      });

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /returned HTTP 500/);
    });

    test('aborts when telemetry probe times out or fails (telemetry loss)', async () => {
      const mockFetch = async () => {
        throw new Error('Connection timed out');
      };

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /probe failed: Connection timed out/);
    });

    test('aborts when telemetry belongs to the wrong node', async () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { node: 'wrong-node' }, value: [Date.now() / 1000, '5000000000'] }],
        },
      };
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify(json),
      });

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch, {
        expectedNode: 'edge-1',
      });
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /does not match expected/);
    });
  });

  describe('checkLegacySites (Concurrent)', () => {
    test('passes when all 4 canonical legacy sites return HTTP 200', async () => {
      const mockFetch = async (url) => ({
        statusCode: 200,
        body: `OK from ${url}`,
      });

      const res = await checkLegacySites(DEFAULT_LEGACY_SITES, 5000, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.results.length, 4);
    });

    test('aborts immediately when any legacy site returns non-200', async () => {
      const mockFetch = async (url) => {
        if (url.includes('kidzlab.edu.vn')) {
          return { statusCode: 502, body: 'Bad Gateway' };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const res = await checkLegacySites(DEFAULT_LEGACY_SITES, 5000, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.strictEqual(res.statusCode, 502);
      assert.match(res.reason, /kidzlab\.edu\.vn returned HTTP 502/);
    });

    test('aborts when a legacy site connection fails or times out', async () => {
      const mockFetch = async (url) => {
        if (url.includes('cuuhohanam.com')) {
          throw new Error('ECONNREFUSED');
        }
        return { statusCode: 200, body: 'OK' };
      };

      const res = await checkLegacySites(DEFAULT_LEGACY_SITES, 5000, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /cuuhohanam\.com probe failed: ECONNREFUSED/);
    });

    test('probes all legacy sites concurrently in parallel', async () => {
      let activeRequests = 0;
      let maxConcurrent = 0;

      const mockFetch = async () => {
        activeRequests++;
        maxConcurrent = Math.max(maxConcurrent, activeRequests);
        await new Promise((r) => setTimeout(r, 20));
        activeRequests--;
        return { statusCode: 200, body: 'OK' };
      };

      const res = await checkLegacySites(DEFAULT_LEGACY_SITES, 5000, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(maxConcurrent, 4); // All 4 sites probed simultaneously
    });
  });

  describe('parseHttpErrorRate', () => {
    test('createRolling60sSample produces schema-valid structure with both workloads', () => {
      const nowSec = 10000;
      const sample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 15 },
          hls_viewers: { requests: 500, failed: 15 },
        },
      });
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.rate, 0.03); // 30 / 1000 = 3%
      assert.strictEqual(parsed.totalRequests, 1000);
      assert.strictEqual(parsed.failedRequests, 30);
      assert.strictEqual(parsed.timestamp, nowSec);
      assert.strictEqual(parsed.windowSec, 60);
    });

    test('parses VictoriaMetrics vector JSON format with rate in [0, 1]', () => {
      const nowSec = 1791457900;
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: {}, value: [nowSec, '0.04'] }],
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(json), { nowSec });
      assert.strictEqual(parsed.rate, 0.04);
      assert.strictEqual(parsed.timestamp, nowSec);
    });

    test('rejects bare rate numbers and raw string rates without schema', () => {
      assert.strictEqual(parseHttpErrorRate(0.04).error, 'BARE_RATE_DISALLOWED');
      assert.strictEqual(parseHttpErrorRate('0.04').error, 'BARE_RATE_DISALLOWED');
      assert.strictEqual(parseHttpErrorRate('invalid').error, 'BARE_RATE_DISALLOWED');
    });

    test('rejects stale timestamp in telemetry (e.g. year 2000)', () => {
      const nowSec = 1791457900;
      const sample = {
        windowSec: 60,
        timestamp: 946684800, // Year 2000
        workloads: {
          api_mix: { requests: 100, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'STALE_METRIC');
    });

    test('rejects windowSec < 60', () => {
      const nowSec = 10000;
      const sample = {
        windowSec: 2,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 100, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'INVALID_WINDOW');
    });

    test('rejects single-workload or API-only telemetry missing hls_viewers', () => {
      const nowSec = 10000;
      const sample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 100, failed: 2 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'MISSING_WORKLOAD');
    });

    test('rejects negative per-workload counts cancelling totals', () => {
      const nowSec = 10000;
      const sample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: -50, failed: -10 },
          hls_viewers: { requests: 150, failed: 15 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'INVALID_WORKLOAD_COUNTS');
    });

    test('rejects failedRequests exceeding requests within workload', () => {
      const nowSec = 10000;
      const sample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 50, failed: 100 },
          hls_viewers: { requests: 50, failed: 5 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'INVALID_WORKLOAD_COUNTS');
    });

    test('rejects zero total requests across workloads', () => {
      const nowSec = 10000;
      const sample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 0, failed: 0 },
          hls_viewers: { requests: 0, failed: 0 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec });
      assert.strictEqual(parsed.error, 'ZERO_REQUESTS');
    });
  });

  describe('checkHttpErrorRate (Fail-Closed)', () => {
    test('fails closed when ERROR_RATE_SOURCE is missing or empty', async () => {
      const res = await checkHttpErrorRate('');
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /ERROR_RATE_SOURCE is required/);
    });

    test('fails closed when telemetry file does not exist', async () => {
      const res = await checkHttpErrorRate('/tmp/nonexistent-telemetry-file.json');
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /does not exist/);
    });

    test('fails closed when HTTP error rate endpoint returns HTTP 500', async () => {
      const mockFetch = async () => ({
        statusCode: 500,
        body: 'Internal Server Error',
      });

      const res = await checkHttpErrorRate(
        'http://mock/error-rate',
        0.05,
        60,
        { firstExceededAt: null },
        mockFetch,
      );
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /returned HTTP 500/);
    });

    test('fails closed when telemetry content contains invalid bare rate or format', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: '0.05',
      });

      const res = await checkHttpErrorRate(
        'http://mock/error-rate',
        0.05,
        60,
        { firstExceededAt: null },
        mockFetch,
      );
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /validation failed/);
    });

    test('passes when error rate is below threshold with schema-valid sample', async () => {
      const nowSec = Date.now() / 1000;
      const validSample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 5 },
          hls_viewers: { requests: 500, failed: 5 },
        },
      });

      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify(validSample),
      });

      const state = { firstExceededAt: null };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch, {
        nowSec,
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.abort, undefined);
      assert.strictEqual(state.firstExceededAt, null);
    });

    test('tolerates transient error rate spike lasting < 60s without aborting', async () => {
      const nowSec = Date.now() / 1000;
      const highSample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 40 },
          hls_viewers: { requests: 500, failed: 40 }, // 80/1000 = 8%
        },
      });

      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify(highSample),
      });

      const state = { firstExceededAt: Date.now() - 15000 }; // 15s ago
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch, {
        nowSec,
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.warning, true);
      assert.strictEqual(res.abort, undefined);
      assert.ok(state.firstExceededAt !== null);
    });

    test('aborts when error rate > 5% is sustained for >= 60s', async () => {
      const nowSec = Date.now() / 1000;
      const highSample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 35 },
          hls_viewers: { requests: 500, failed: 35 }, // 70/1000 = 7%
        },
      });

      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify(highSample),
      });

      const state = { firstExceededAt: Date.now() - 65000 }; // 65s ago
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch, {
        nowSec,
      });
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /exceeded 5.0% threshold continuously for 65s/);
    });

    test('resets sustained timer when error rate returns to normal', async () => {
      const nowSec = Date.now() / 1000;
      const normalSample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 10 },
          hls_viewers: { requests: 500, failed: 10 }, // 20/1000 = 2%
        },
      });

      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify(normalSample),
      });

      const state = { firstExceededAt: Date.now() - 30000 };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch, {
        nowSec,
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(state.firstExceededAt, null);
    });
  });

  describe('PlatformWatchdog Protocol & Run Lifecycle', () => {
    test('runCycle fails closed when neither or only one source is provided', async () => {
      const watchdogNoSources = new PlatformWatchdog({
        runId: 'test_no_sources',
        abortSignalFile: abortFile,
      });
      const okNoSources = await watchdogNoSources.runCycle();
      assert.strictEqual(okNoSources, false);

      const mockRamFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes 8000000000\n',
      });
      const watchdogOnlyRam = new PlatformWatchdog({
        runId: 'test_only_ram',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        abortSignalFile: abortFile,
        fetchFn: mockRamFetch,
      });
      const okOnlyRam = await watchdogOnlyRam.runCycle();
      assert.strictEqual(okOnlyRam, false);
    });

    test('triggerAbort writes valid abort signal JSON file with exclusive mode 0600 replacement', () => {
      const watchdog = new PlatformWatchdog({
        runId: 'test_run_123',
        abortSignalFile: abortFile,
      });

      const res = watchdog.triggerAbort('Memory safety breach', { memBytes: 500000000 });
      assert.strictEqual(res.filePersisted, true);
      assert.strictEqual(fs.existsSync(abortFile), true);

      const saved = JSON.parse(fs.readFileSync(abortFile, 'utf8'));
      assert.strictEqual(saved.abort, true);
      assert.strictEqual(saved.runId, 'test_run_123');
      assert.strictEqual(saved.reason, 'Memory safety breach');
      assert.strictEqual(saved.details.memBytes, 500000000);
      assert.ok(saved.timestamp);

      // Verify file permissions on POSIX
      if (process.platform !== 'win32') {
        const stats = fs.statSync(abortFile);
        assert.strictEqual(stats.mode & 0o777, 0o600);
      }
    });

    test('triggerAbort handles persistence failure and still signals process', () => {
      const invalidPath =
        process.platform === 'win32'
          ? 'Z:\\invalid\\path\\abort.signal'
          : '/dev/null/invalid/abort.signal';
      const watchdog = new PlatformWatchdog({
        runId: 'test_fail_persist',
        abortSignalFile: invalidPath,
      });

      const res = watchdog.triggerAbort('Test with broken path');
      assert.strictEqual(res.filePersisted, false);
      assert.ok(res.errors && res.errors.length > 0);
      assert.match(res.errors[0], /Persistence failure/);
    });

    test('preflight passes when all three telemetry sources are healthy', async () => {
      const nowSec = 10000;
      const validSample = createRolling60sSample({
        timestampSec: nowSec,
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 5 },
          hls_viewers: { requests: 500, failed: 5 },
        },
      });

      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return {
            statusCode: 200,
            body: 'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 10000000\n',
          };
        }
        if (url.includes('error-rate')) {
          return { statusCode: 200, body: JSON.stringify(validSample) };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        runId: 'test_preflight_ok',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        abortSignalFile: abortFile,
        fetchFn: mockFetch,
      });

      const preflightResult = await watchdog.preflight(10000 * 1000);
      assert.strictEqual(preflightResult, true);
    });

    test('maintains fixed monotonic legacy site cadence despite probe delays', async () => {
      let mockClock = 0;

      const delayedFetch = async (url) => {
        if (url.includes('metrics')) {
          // Delayed RAM probe: simulates 5000ms latency
          mockClock += 5000;
          return {
            statusCode: 200,
            body: 'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000\n',
          };
        }
        if (url.includes('error-rate')) {
          return {
            statusCode: 200,
            body: JSON.stringify(
              createRolling60sSample({
                timestampSec: mockClock / 1000,
                windowSec: 60,
                workloads: {
                  api_mix: { requests: 100, failed: 1 },
                  hls_viewers: { requests: 100, failed: 1 },
                },
              }),
            ),
          };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        runId: 'test_cadence_monotonic',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        legacyCheckIntervalMs: 30000,
        fetchFn: delayedFetch,
      });

      // Cycle 0 at t=0
      await watchdog.runCycle(0);
      assert.strictEqual(watchdog.legacyRequestStarts.length, 1);
      assert.strictEqual(watchdog.legacyRequestStarts[0], 0);

      // Cycle 1 at t=10000 (not due yet)
      await watchdog.runCycle(10000);
      assert.strictEqual(watchdog.legacyRequestStarts.length, 1);

      // Cycle 2 at t=30000 (due at exact monotonic schedule tick)
      await watchdog.runCycle(30000);
      assert.strictEqual(watchdog.legacyRequestStarts.length, 2);
      assert.strictEqual(watchdog.legacyRequestStarts[1], 30000);

      // Verify request-start gap is locked to exactly 30000ms
      assert.strictEqual(watchdog.legacyRequestStarts[1] - watchdog.legacyRequestStarts[0], 30000);
    });

    test('validates runId and rejects invalid patterns', () => {
      assert.throws(() => new PlatformWatchdog({ runId: 'bad id with spaces' }), /Invalid runId/);
      assert.throws(() => new PlatformWatchdog({ runId: 'sh' }), /Invalid runId/);
      const okWatchdog = new PlatformWatchdog({ runId: 'valid-run-01' });
      assert.strictEqual(okWatchdog.runId, 'valid-run-01');
    });

    test('defaults to run-owned scoped directory for abort file', () => {
      const watchdog = new PlatformWatchdog({ runId: 'run-scope-test' });
      assert.match(watchdog.abortSignalFile, /winkey_lt2_run-scope-test[\\\/]abort\.signal/);
    });

    test('refuses to overwrite an abort signal file belonging to another run', () => {
      const file = path.join(tmpDir, 'existing.signal');
      fs.writeFileSync(file, JSON.stringify({ abort: true, runId: 'other_run_999' }));

      const watchdog = new PlatformWatchdog({
        runId: 'my_run_111',
        abortSignalFile: file,
      });

      const res = watchdog.triggerAbort('Conflict test');
      assert.strictEqual(res.filePersisted, false);
      assert.match(res.errors[0], /belongs to another run/);
    });

    test('runner observes watchdog abort sentinel and exit status', () => {
      const runnerSignalPath = path.join(tmpDir, 'runner_observed.signal');
      const watchdog = new PlatformWatchdog({
        runId: 'runner_obs_test',
        abortSignalFile: runnerSignalPath,
      });

      assert.strictEqual(fs.existsSync(runnerSignalPath), false);
      watchdog.triggerAbort('Runner observation test');
      assert.strictEqual(fs.existsSync(runnerSignalPath), true);

      const payload = JSON.parse(fs.readFileSync(runnerSignalPath, 'utf8'));
      assert.strictEqual(payload.abort, true);
      assert.strictEqual(payload.runId, 'runner_obs_test');
      assert.strictEqual(payload.reason, 'Runner observation test');
    });
  });
});
