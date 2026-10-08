import test, { describe, beforeEach, afterEach } from 'node:test';
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
  checkHttpErrorRate,
  PlatformWatchdog,
  ONE_GIB_BYTES,
  DEFAULT_LEGACY_SITES,
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
    test('parses standard Prometheus integer format', () => {
      const body =
        '# HELP node_memory_MemAvailable_bytes\nnode_memory_MemAvailable_bytes 7481970688\n';
      const parsed = parseMemAvailable(body);
      assert.strictEqual(parsed.bytes, 7481970688);
      assert.strictEqual(parsed.node, 'edge-1');
    });

    test('parses Prometheus scientific notation format', () => {
      const body = 'node_memory_MemAvailable_bytes 7.49856768e+09\n';
      const parsed = parseMemAvailable(body);
      assert.strictEqual(parsed.bytes, 7498567680);
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

    test('rejects wrong-node telemetry in VictoriaMetrics JSON', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                node: 'generator-01',
              },
              value: [1791457900, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { expectedNode: 'edge-1' });
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
              metric: { node: 'edge-1' },
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
              metric: { node: 'edge-1' },
              value: [1791457900, 'not-a-number'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json));
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

    beforeEach(async () => {
      server = http.createServer();
      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          serverPort = server.address().port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('completes fast normal request successfully', async () => {
      server.on('request', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello Watchdog');
      });

      const res = await fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}`, 1000);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 'Hello Watchdog');
    });

    test('aborts when headers are hung beyond total wall-clock deadline', async () => {
      server.on('request', () => {
        // Deliberately never respond
      });

      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}`, 150),
        /Total wall-clock deadline exceeded/,
      );
    });

    test('aborts when response body trickles slowly beyond wall-clock deadline', async () => {
      server.on('request', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('part1');
        // Trickle next chunk after 300ms (exceeding 150ms total deadline)
        setTimeout(() => {
          try {
            res.end('part2');
          } catch {
            // Socket may already be destroyed
          }
        }, 300);
      });

      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}`, 150),
        /Total wall-clock deadline exceeded/,
      );
    });

    test('aborts when payload exceeds maxBytes limit (bounded buffering)', async () => {
      server.on('request', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Send 1000 bytes with limit of 200 bytes
        res.end('A'.repeat(1000));
      });

      await assert.rejects(
        fetchWithWallClockDeadline(`http://127.0.0.1:${serverPort}`, 1000, 200),
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
        body: 'node_memory_MemAvailable_bytes 2147483648\n', // 2 GiB
      });

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.availBytes, 2147483648);
      assert.strictEqual(res.abort, undefined);
    });

    test('aborts when edge-1 MemAvailable falls below 1 GiB', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes 524288000\n', // ~500 MiB
      });

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
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
      assert.match(res.reason, /does not match expected node/);
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
    test('parses rolling 60s structure with numerator and denominator across both workloads', () => {
      const payload = {
        windowSec: 60,
        workloads: {
          api_mix: { requests: 500, failed: 15 },
          hls_viewers: { requests: 500, failed: 15 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(payload));
      assert.strictEqual(parsed.rate, 0.03); // 30 / 1000 = 3%
      assert.strictEqual(parsed.totalRequests, 1000);
      assert.strictEqual(parsed.failedRequests, 30);
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

    test('rejects non-finite string rates like "invalid"', () => {
      const parsed = parseHttpErrorRate('invalid');
      assert.strictEqual(parsed.error, 'INVALID_RATE');
    });

    test('rejects negative or out-of-bounds rates', () => {
      const negative = parseHttpErrorRate(JSON.stringify({ rate: -0.1 }));
      assert.strictEqual(negative.error, 'INVALID_RATE');

      const overOne = parseHttpErrorRate(JSON.stringify({ rate: 1.5 }));
      assert.strictEqual(overOne.error, 'INVALID_RATE');
    });

    test('rejects failedRequests exceeding totalRequests', () => {
      const parsed = parseHttpErrorRate(
        JSON.stringify({ totalRequests: 100, failedRequests: 150 }),
      );
      assert.strictEqual(parsed.error, 'INVALID_COUNTS');
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

    test('fails closed when telemetry content contains invalid non-finite rate', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 'invalid' }),
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

    test('passes when error rate is below threshold', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.01 }),
      });

      const state = { firstExceededAt: null };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.abort, undefined);
      assert.strictEqual(state.firstExceededAt, null);
    });

    test('tolerates transient error rate spike lasting < 60s without aborting', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.08 }),
      });

      const state = { firstExceededAt: Date.now() - 15000 }; // 15s ago
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.warning, true);
      assert.strictEqual(res.abort, undefined);
      assert.ok(state.firstExceededAt !== null);
    });

    test('aborts when error rate > 5% is sustained for >= 60s', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.07 }),
      });

      const state = { firstExceededAt: Date.now() - 65000 }; // 65s ago
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /exceeded 5.0% threshold continuously for 65s/);
    });

    test('resets sustained timer when error rate returns to normal', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.02 }),
      });

      const state = { firstExceededAt: Date.now() - 30000 };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(state.firstExceededAt, null);
    });
  });

  describe('PlatformWatchdog Protocol & Run Lifecycle', () => {
    test('runCycle fails closed when neither or only one source is provided', async () => {
      const watchdogNoSources = new PlatformWatchdog({
        abortSignalFile: abortFile,
      });
      const okNoSources = await watchdogNoSources.runCycle();
      assert.strictEqual(okNoSources, false);

      const mockRamFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes 8000000000\n',
      });
      const watchdogOnlyRam = new PlatformWatchdog({
        edgeMetricsUrl: 'http://mock/metrics',
        abortSignalFile: abortFile,
        fetchFn: mockRamFetch,
      });
      const okOnlyRam = await watchdogOnlyRam.runCycle();
      assert.strictEqual(okOnlyRam, false);
    });

    test('triggerAbort writes valid abort signal JSON file with atomic mode 0600 replacement', () => {
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
      // Point abort file to an invalid/uncreatable directory
      const invalidPath =
        process.platform === 'win32'
          ? 'Z:\\invalid\\path\\abort.signal'
          : '/proc/invalid/path/abort.signal';
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
      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return { statusCode: 200, body: 'node_memory_MemAvailable_bytes 8000000000\n' };
        }
        if (url.includes('error-rate')) {
          return { statusCode: 200, body: JSON.stringify({ rate: 0.01 }) };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        edgeMetricsUrl: 'http://mock/metrics',
        errorRateSource: 'http://mock/error-rate',
        abortSignalFile: abortFile,
        fetchFn: mockFetch,
      });

      const preflightResult = await watchdog.preflight();
      assert.strictEqual(preflightResult, true);
    });
  });
});
