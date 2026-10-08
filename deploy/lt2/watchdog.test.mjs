import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseMemAvailable,
  checkEdgeRam,
  checkLegacySites,
  checkHttpErrorRate,
  PlatformWatchdog,
  ONE_GIB_BYTES,
  DEFAULT_LEGACY_SITES,
} from './watchdog.mjs';

describe('Platform Watchdog Unit & Integration Tests', () => {
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
      const bytes = parseMemAvailable(body);
      assert.strictEqual(bytes, 7481970688);
    });

    test('parses Prometheus scientific notation format', () => {
      const body = 'node_memory_MemAvailable_bytes 7.49856768e+09\n';
      const bytes = parseMemAvailable(body);
      assert.strictEqual(bytes, 7498567680);
    });

    test('parses VictoriaMetrics vector JSON response', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                node: 'edge-1',
              },
              value: [1791457887, '8589934592'], // 8 GiB
            },
          ],
        },
      };
      const bytes = parseMemAvailable(JSON.stringify(json));
      assert.strictEqual(bytes, 8589934592);
    });

    test('returns null for missing or invalid metric', () => {
      assert.strictEqual(parseMemAvailable('other_metric 12345'), null);
      assert.strictEqual(parseMemAvailable(''), null);
      assert.strictEqual(parseMemAvailable(null), null);
    });
  });

  describe('checkEdgeRam', () => {
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

    test('aborts when edge-1 metrics endpoint returns HTTP 500', async () => {
      const mockFetch = async () => ({
        statusCode: 500,
        body: 'Internal Server Error',
      });

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /returned HTTP 500/);
    });

    test('aborts when edge-1 metrics endpoint connection times out', async () => {
      const mockFetch = async () => {
        throw new Error('Connection timed out');
      };

      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /probe failed: Connection timed out/);
    });
  });

  describe('checkLegacySites', () => {
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
  });

  describe('checkHttpErrorRate', () => {
    test('passes when error rate is below threshold', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.01 }), // 1% error rate
      });

      const state = { firstExceededAt: null };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.abort, undefined);
      assert.strictEqual(state.firstExceededAt, null);
    });

    test('does not abort on transient error rate spike lasting < 60s', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.08 }), // 8% error rate (> 5%)
      });

      // Simulated start at 10 seconds ago
      const state = { firstExceededAt: Date.now() - 10000 };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.warning, true);
      assert.strictEqual(res.abort, undefined);
      assert.ok(state.firstExceededAt !== null);
    });

    test('aborts when error rate > 5% is sustained for >= 60s', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.07 }), // 7% error rate
      });

      // Simulated start at 65 seconds ago
      const state = { firstExceededAt: Date.now() - 65000 };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /exceeded 5.0% threshold continuously for 65s/);
    });

    test('resets sustained timer when error rate drops back to normal', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: JSON.stringify({ rate: 0.02 }), // 2% error rate (back to normal)
      });

      const state = { firstExceededAt: Date.now() - 30000 };
      const res = await checkHttpErrorRate('http://mock/errors', 0.05, 60, state, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(state.firstExceededAt, null);
    });
  });

  describe('PlatformWatchdog Abort & Notification Protocol', () => {
    test('triggerAbort writes valid abort signal JSON file', () => {
      const watchdog = new PlatformWatchdog({
        abortSignalFile: abortFile,
      });

      const payload = watchdog.triggerAbort('Test memory drop abort', { test: true });
      assert.strictEqual(payload.abort, true);
      assert.strictEqual(fs.existsSync(abortFile), true);

      const saved = JSON.parse(fs.readFileSync(abortFile, 'utf8'));
      assert.strictEqual(saved.abort, true);
      assert.strictEqual(saved.reason, 'Test memory drop abort');
      assert.strictEqual(saved.details.test, true);
      assert.ok(saved.timestamp);
    });

    test('runCycle detects RAM drop, writes abort file, and returns false', async () => {
      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return {
            statusCode: 200,
            body: 'node_memory_MemAvailable_bytes 800000000\n', // < 1 GiB
          };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        edgeMetricsUrl: 'http://mock-edge/metrics',
        abortSignalFile: abortFile,
        fetchFn: mockFetch,
      });

      const cycleResult = await watchdog.runCycle();
      assert.strictEqual(cycleResult, false);
      assert.strictEqual(fs.existsSync(abortFile), true);

      const saved = JSON.parse(fs.readFileSync(abortFile, 'utf8'));
      assert.strictEqual(saved.abort, true);
      assert.match(saved.reason, /fell below required safety threshold/);
    });
  });
});
