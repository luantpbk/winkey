import test, { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {
  parseMemAvailable,
  fetchWithWallClockDeadline,
  checkEdgeRam,
  checkLegacySites,
  parseHttpErrorRate,
  createRolling60sSample,
  RollingErrorRateProducer,
  checkHttpErrorRate,
  isTrustedExporterUrl,
  PlatformWatchdog,
  ONE_GIB_BYTES,
  DEFAULT_LEGACY_SITES,
  TRUSTED_EDGE_NODE,
  TRUSTED_EDGE_INSTANCE,
} from './watchdog.mjs';

// HARD-DENY non-loopback network calls for entire offline test suite
const origSocketConnect = net.Socket.prototype.connect;

export function extractDestinationHost(args) {
  let target = args;
  // Unwrap normalized args array e.g. [{ host: '...', port: ... }, cb]
  while (Array.isArray(target) && target.length > 0 && Array.isArray(target[0])) {
    target = target[0];
  }

  const arg0 = target[0];
  let host = 'localhost';

  if (typeof arg0 === 'object' && arg0 !== null && !Array.isArray(arg0)) {
    host = arg0.host || arg0.hostname || 'localhost';
  } else if (typeof arg0 === 'number') {
    if (typeof target[1] === 'string') {
      host = target[1];
    } else {
      host = 'localhost';
    }
  } else if (typeof arg0 === 'string') {
    if (arg0.includes('/') || arg0.includes('\\')) {
      host = 'localhost';
    } else if (typeof target[1] === 'number') {
      host = arg0;
    } else {
      host = arg0;
    }
  }

  // Also check if any item in target has host/hostname
  for (const item of target) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      if (item.host) host = item.host;
      else if (item.hostname) host = item.hostname;
    }
  }

  return host;
}

export function isLoopbackTarget(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return true;
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host.includes(':') && !host.includes('::')) {
    const parts = host.split(':');
    if (parts.length === 2) {
      host = parts[0];
    }
  }
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host.startsWith('127.')
  );
}

net.Socket.prototype.connect = function (...args) {
  const host = extractDestinationHost(args);
  if (!isLoopbackTarget(host)) {
    throw new Error(
      `OFFLINE TEST ISOLATION FAILURE: Unexpected non-loopback network connection attempt to '${host}'. All test boundaries must use mocks or loopback servers.`,
    );
  }
  return origSocketConnect.apply(this, args);
};

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

  describe('offline network isolation & socket interceptor', () => {
    test('hard-denies direct options targeting non-loopback host', () => {
      const sock = new net.Socket();
      assert.throws(
        () => sock.connect({ host: 'example.invalid', port: 443 }),
        /OFFLINE TEST ISOLATION FAILURE/,
      );
    });

    test('hard-denies normalized [options, callback] array targeting non-loopback host', () => {
      const sock = new net.Socket();
      assert.throws(
        () => sock.connect([{ host: 'example.invalid', port: 443 }, () => {}]),
        /OFFLINE TEST ISOLATION FAILURE/,
      );
    });

    test('hard-denies port and hostname signature (port, host, callback)', () => {
      const sock = new net.Socket();
      assert.throws(
        () => sock.connect(443, 'example.invalid', () => {}),
        /OFFLINE TEST ISOLATION FAILURE/,
      );
    });

    test('intercepts actual unmocked http.get before opening external socket', async () => {
      await assert.rejects(
        new Promise((resolve, reject) => {
          const req = http.get('http://example.invalid', () => resolve());
          req.on('error', reject);
        }),
        /OFFLINE TEST ISOLATION FAILURE/,
      );
    });
  });

  describe('isTrustedExporterUrl', () => {
    test('accepts trusted edge-1 exporter endpoint on 9100/metrics', () => {
      assert.strictEqual(isTrustedExporterUrl('http://100.113.240.3:9100/metrics'), true);
      assert.strictEqual(isTrustedExporterUrl('http://edge-1:9100/metrics'), true);
    });

    test('rejects deceptive hostnames, substring URLs, and wrong paths/ports', () => {
      assert.strictEqual(
        isTrustedExporterUrl('http://100.113.240.3:9100.evil.example/metrics'),
        false,
      );
      assert.strictEqual(isTrustedExporterUrl('http://100.113.240.3:8080/metrics'), false);
      assert.strictEqual(isTrustedExporterUrl('http://100.113.240.3:9100/other'), false);
      assert.strictEqual(isTrustedExporterUrl('not-a-url'), false);
      assert.strictEqual(isTrustedExporterUrl(null), false);
    });
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

    test('rejects text metric labels without node or instance identity from unverified source', () => {
      const parsed = parseMemAvailable(
        'node_memory_MemAvailable_bytes{job="generator-01"} 8589934592\n',
      );
      assert.strictEqual(parsed.error, 'AMBIGUOUS_SERIES');
    });

    test('rejects text metric with non-finite or NaN timestamp', () => {
      const parsed = parseMemAvailable(
        'node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8589934592 NaN\n',
      );
      assert.strictEqual(parsed.error, 'INVALID_TIMESTAMP');
    });

    test('rejects VictoriaMetrics JSON missing __name__ when query provenance is missing', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { instance: '100.113.240.3:9100', node: 'edge-1' },
              value: [10000, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), { nowSec: 10000 });
      assert.strictEqual(parsed.error, 'MISSING_METRIC_NAME');
    });

    test('accepts VictoriaMetrics JSON missing __name__ when sourceUrl provides query provenance', () => {
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { instance: '100.113.240.3:9100', node: 'edge-1' },
              value: [10000, '8589934592'],
            },
          ],
        },
      };
      const parsed = parseMemAvailable(JSON.stringify(json), {
        nowSec: 10000,
        sourceUrl:
          'http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Bnode%3D%22edge-1%22%7D',
      });
      assert.strictEqual(parsed.bytes, 8589934592);
      assert.strictEqual(parsed.node, 'edge-1');
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
        } else if (url === '/large200') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('B'.repeat(150 * 1024)); // 150 KiB payload (> 64 KiB)
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

    test('completes large HTTP 200 payload without error when discardBody is enabled', async () => {
      const res = await fetchWithWallClockDeadline(
        `http://127.0.0.1:${serverPort}/large200`,
        1000,
        { discardBody: true },
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.bytes, 150 * 1024);
    });

    test('legacy sites probe succeeds on large HTTP 200 payload via bounded discard', async () => {
      const res = await checkLegacySites(
        [`http://127.0.0.1:${serverPort}/large200`],
        1000,
        fetchWithWallClockDeadline,
      );
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.results[0].statusCode, 200);
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

    test('passes end-to-end with unlabeled direct exporter from trusted URL', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes 8589934592\n',
      });
      const res = await checkEdgeRam('http://100.113.240.3:9100/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.availBytes, 8589934592);
    });

    test('aborts end-to-end with unlabeled direct exporter from deceptive URL', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes 8589934592\n',
      });
      const res = await checkEdgeRam(
        'http://100.113.240.3:9100.evil.example/metrics',
        ONE_GIB_BYTES,
        mockFetch,
      );
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /Unlabeled Prometheus text metric requires trusted exact endpoint/);
    });

    test('aborts end-to-end when text metric contains ambiguous labels without node/instance', async () => {
      const mockFetch = async () => ({
        statusCode: 200,
        body: 'node_memory_MemAvailable_bytes{job="generator-01"} 8589934592\n',
      });
      const res = await checkEdgeRam('http://mock/metrics', ONE_GIB_BYTES, mockFetch);
      assert.strictEqual(res.abort, true);
      assert.match(res.reason, /without node or instance identity/);
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
          result: [
            {
              metric: {
                __name__: 'node_memory_MemAvailable_bytes',
                node: 'wrong-node',
              },
              value: [Date.now() / 1000, '5000000000'],
            },
          ],
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

    test('rejects unscoped PromQL vector JSON format with UNSCOPED_VECTOR_DISALLOWED', () => {
      const nowSec = 1791457900;
      const json = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: {}, value: [nowSec, '0.04'] }],
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(json), { nowSec });
      assert.strictEqual(parsed.error, 'UNSCOPED_VECTOR_DISALLOWED');
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

    test('rejects windowSec !== 60 (both short e.g. 2s and long e.g. 3600s)', () => {
      const nowSec = 10000;
      const sampleShort = {
        windowSec: 2,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 100, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      assert.strictEqual(
        parseHttpErrorRate(JSON.stringify(sampleShort), { nowSec }).error,
        'INVALID_WINDOW',
      );

      const sampleLong = {
        windowSec: 3600,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 100, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      assert.strictEqual(
        parseHttpErrorRate(JSON.stringify(sampleLong), { nowSec }).error,
        'INVALID_WINDOW',
      );
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

    test('rejects non-integer, string, or null workload counts without coercion', () => {
      const nowSec = 10000;
      const sampleString = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: '100', failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      assert.strictEqual(
        parseHttpErrorRate(JSON.stringify(sampleString), { nowSec }).error,
        'INVALID_WORKLOAD_COUNTS',
      );

      const sampleNull = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: null, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      assert.strictEqual(
        parseHttpErrorRate(JSON.stringify(sampleNull), { nowSec }).error,
        'INVALID_WORKLOAD_COUNTS',
      );

      const sampleFloat = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 100.5, failed: 2 },
          hls_viewers: { requests: 100, failed: 2 },
        },
      };
      assert.strictEqual(
        parseHttpErrorRate(JSON.stringify(sampleFloat), { nowSec }).error,
        'INVALID_WORKLOAD_COUNTS',
      );
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

    test('rejects inactive workload during active test run with INACTIVE_WORKLOAD', () => {
      const nowSec = 10000;
      const apiOnlySample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 500, failed: 10 },
          hls_viewers: { requests: 0, failed: 0 },
        },
      };
      const parsedApiOnly = parseHttpErrorRate(JSON.stringify(apiOnlySample), { nowSec });
      assert.strictEqual(parsedApiOnly.error, 'INACTIVE_WORKLOAD');
      assert.match(parsedApiOnly.reason, /hls_viewers/);

      const hlsOnlySample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 0, failed: 0 },
          hls_viewers: { requests: 500, failed: 10 },
        },
      };
      const parsedHlsOnly = parseHttpErrorRate(JSON.stringify(hlsOnlySample), { nowSec });
      assert.strictEqual(parsedHlsOnly.error, 'INACTIVE_WORKLOAD');
      assert.match(parsedHlsOnly.reason, /api_mix/);

      const allZeroSample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 0, failed: 0 },
          hls_viewers: { requests: 0, failed: 0 },
        },
      };
      const parsedAllZero = parseHttpErrorRate(JSON.stringify(allZeroSample), { nowSec });
      assert.strictEqual(parsedAllZero.error, 'INACTIVE_WORKLOAD');
    });

    test('accepts zero requests during preflight lifecycle to verify readiness', () => {
      const nowSec = 10000;
      const preflightSample = {
        windowSec: 60,
        timestamp: nowSec,
        workloads: {
          api_mix: { requests: 0, failed: 0 },
          hls_viewers: { requests: 0, failed: 0 },
        },
      };
      const parsed = parseHttpErrorRate(JSON.stringify(preflightSample), {
        nowSec,
        isPreflight: true,
      });
      assert.strictEqual(parsed.rate, 0);
      assert.strictEqual(parsed.totalRequests, 0);
      assert.strictEqual(parsed.isPreflight, true);
    });

    test('RollingErrorRateProducer maintains sliding 60s buckets and generates valid samples', () => {
      const baseSec = 10000;
      const producer = new RollingErrorRateProducer(60);

      // Record API mix events
      producer.recordSuccess('api_mix', 90, (baseSec + 10) * 1000);
      producer.recordFailure('api_mix', 10, (baseSec + 20) * 1000); // 10 fails out of 100

      // Record HLS events
      producer.recordSuccess('hls_viewers', 95, (baseSec + 30) * 1000);
      producer.recordFailure('hls_viewers', 5, (baseSec + 40) * 1000); // 5 fails out of 100

      const sample = producer.getSample(baseSec + 50);
      assert.strictEqual(sample.windowSec, 60);
      assert.strictEqual(sample.timestamp, baseSec + 50);
      assert.strictEqual(sample.workloads.api_mix.requests, 100);
      assert.strictEqual(sample.workloads.api_mix.failed, 10);
      assert.strictEqual(sample.workloads.hls_viewers.requests, 100);
      assert.strictEqual(sample.workloads.hls_viewers.failed, 5);

      const parsed = parseHttpErrorRate(JSON.stringify(sample), { nowSec: baseSec + 50 });
      assert.strictEqual(parsed.rate, 0.075); // 15 / 200 = 7.5%
      assert.strictEqual(parsed.totalRequests, 200);
      assert.strictEqual(parsed.failedRequests, 15);

      // Preflight sample returns 0 requests
      const preflightSample = producer.getPreflightSample(baseSec + 50);
      assert.strictEqual(preflightSample.workloads.api_mix.requests, 0);
      const preflightParsed = parseHttpErrorRate(JSON.stringify(preflightSample), {
        nowSec: baseSec + 50,
        isPreflight: true,
      });
      assert.strictEqual(preflightParsed.rate, 0);
      assert.strictEqual(preflightParsed.isPreflight, true);
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
      const mockLegacyFetch = async () => ({
        statusCode: 200,
        body: 'OK',
      });
      const watchdogNoSources = new PlatformWatchdog({
        runId: 'test_no_sources',
        abortSignalFile: path.join(tmpDir, 'no_sources.signal'),
        fetchFn: mockLegacyFetch,
      });
      const okNoSources = await watchdogNoSources.runCycle();
      assert.strictEqual(okNoSources, false);

      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return {
            statusCode: 200,
            body: 'node_memory_MemAvailable_bytes 8000000000\n',
          };
        }
        return { statusCode: 200, body: 'OK' };
      };
      const watchdogOnlyRam = new PlatformWatchdog({
        runId: 'test_only_ram',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        abortSignalFile: path.join(tmpDir, 'only_ram.signal'),
        fetchFn: mockFetch,
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

    test('preflight passes with zero traffic via producer.getPreflightSample()', async () => {
      const nowSec = 10000;
      const producer = new RollingErrorRateProducer(60);
      const preflightSample = producer.getPreflightSample(nowSec);

      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return {
            statusCode: 200,
            body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${nowSec}\n`,
          };
        }
        if (url.includes('error-rate')) {
          return { statusCode: 200, body: JSON.stringify(preflightSample) };
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

      const preflightResult = await watchdog.preflight(nowSec * 1000);
      assert.strictEqual(preflightResult, true);
    });

    test('preflight aborts fail-closed on missing error telemetry source', async () => {
      const nowSec = 10000;
      const mockFetch = async () => ({
        statusCode: 200,
        body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${nowSec}\n`,
      });
      const watchdog = new PlatformWatchdog({
        runId: 'test_preflight_missing',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: '/tmp/nonexistent-preflight.json',
        abortSignalFile: path.join(tmpDir, 'preflight_missing.signal'),
        fetchFn: mockFetch,
      });
      const ok = await watchdog.preflight(nowSec * 1000);
      assert.strictEqual(ok, false);
      const abort = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'preflight_missing.signal'), 'utf8'),
      );
      assert.strictEqual(abort.abort, true);
      assert.match(abort.reason, /Preflight failed.*does not exist/);
    });

    test('preflight aborts fail-closed on stale telemetry timestamp', async () => {
      const nowSec = 10000;
      const staleSample = {
        windowSec: 60,
        timestamp: 8000, // 2000s stale
        workloads: {
          api_mix: { requests: 0, failed: 0 },
          hls_viewers: { requests: 0, failed: 0 },
        },
      };
      const mockFetch = async (url) => {
        if (url.includes('metrics')) {
          return {
            statusCode: 200,
            body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${nowSec}\n`,
          };
        }
        if (url.includes('error-rate')) {
          return { statusCode: 200, body: JSON.stringify(staleSample) };
        }
        return { statusCode: 200, body: 'OK' };
      };
      const watchdog = new PlatformWatchdog({
        runId: 'test_preflight_stale',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        abortSignalFile: path.join(tmpDir, 'preflight_stale.signal'),
        fetchFn: mockFetch,
      });
      const ok = await watchdog.preflight(nowSec * 1000);
      assert.strictEqual(ok, false);
      const abort = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'preflight_stale.signal'), 'utf8'),
      );
      assert.strictEqual(abort.abort, true);
      assert.match(abort.reason, /Preflight failed.*stale/);
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

    test('start() runs independent monotonic timers and preserves legacy cadence despite poll delays', async () => {
      const legacyStarts = [];
      const pollStarts = [];

      const mockTimedFetch = async (url) => {
        const now = Date.now();
        if (url.includes('metrics')) {
          pollStarts.push(now);
          // Simulate 20ms probe delay on RAM polling
          await new Promise((r) => setTimeout(r, 20));
          const currentSec = Math.floor(now / 1000);
          return {
            statusCode: 200,
            body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${currentSec}\n`,
          };
        }
        if (url.includes('error-rate')) {
          return {
            statusCode: 200,
            body: JSON.stringify(
              createRolling60sSample({
                timestampSec: now / 1000,
                windowSec: 60,
                workloads: {
                  api_mix: { requests: 200, failed: 2 },
                  hls_viewers: { requests: 200, failed: 2 },
                },
              }),
            ),
          };
        }
        // Legacy site probe
        legacyStarts.push(now);
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        runId: 'test_start_stop',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        legacyCheckIntervalMs: 80,
        pollIntervalMs: 25,
        fetchFn: mockTimedFetch,
        abortSignalFile: path.join(tmpDir, 'start_stop.signal'),
      });

      // Start the watchdog (with preflight skipped to measure runtime ticks directly)
      await watchdog.start({ skipPreflight: true, exitOnError: false });

      // Let it run for 260ms (should observe ~3 legacy probes and multiple poll probes)
      await new Promise((r) => setTimeout(r, 260));

      await watchdog.stop();

      assert.strictEqual(watchdog.running, false);
      assert.ok(watchdog.legacyRequestStarts.length >= 2);
      assert.ok(pollStarts.length >= 4);

      // Verify that legacy probes started at ~80ms intervals without drifting from the 20ms RAM probe delay
      const gap1 = watchdog.legacyRequestStarts[1] - watchdog.legacyRequestStarts[0];
      assert.ok(gap1 >= 50 && gap1 <= 150, `Legacy gap ${gap1}ms should be around 80ms`);
    });

    test('start() with preflight enabled anchors legacy cadence to preflight start and aborts on active zero traffic', async () => {
      let isPreflightPhase = true;
      const producer = new RollingErrorRateProducer(60);

      const mockFetch = async (url) => {
        const now = Date.now();
        if (url.includes('metrics')) {
          const currentSec = Math.floor(now / 1000);
          return {
            statusCode: 200,
            body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${currentSec}\n`,
          };
        }
        if (url.includes('error-rate')) {
          // Simulate 35ms latency during error check
          await new Promise((r) => setTimeout(r, 35));
          if (isPreflightPhase) {
            return {
              statusCode: 200,
              body: JSON.stringify(producer.getPreflightSample(now / 1000)),
            };
          }
          // Active phase still has zero requests -> should fail closed with INACTIVE_WORKLOAD
          return {
            statusCode: 200,
            body: JSON.stringify(producer.getPreflightSample(now / 1000)),
          };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        runId: 'test_start_with_preflight',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        legacyCheckIntervalMs: 80,
        pollIntervalMs: 25,
        fetchFn: mockFetch,
        abortSignalFile: path.join(tmpDir, 'start_preflight.signal'),
      });

      // Start the watchdog WITH PREFLIGHT ENABLED
      const startPromise = watchdog.start({ skipPreflight: false, exitOnError: false });
      await startPromise;
      isPreflightPhase = false;

      // Allow runtime to execute for 200ms
      await new Promise((r) => setTimeout(r, 200));
      await watchdog.stop();

      // Check legacy start gap:
      // First legacy probe was at preflight (index 0). Second was first active probe (index 1).
      assert.ok(watchdog.legacyRequestStarts.length >= 2);
      const gap = watchdog.legacyRequestStarts[1] - watchdog.legacyRequestStarts[0];
      // Anchored to preflight legacy start (80ms), even though preflight error probe took 35ms!
      assert.ok(
        gap >= 60 && gap <= 110,
        `Legacy gap ${gap}ms across preflight transition should be around 80ms`,
      );

      // Active loop should have aborted because active traffic was still 0 requests
      const abortSignal = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'start_preflight.signal'), 'utf8'),
      );
      assert.strictEqual(abortSignal.abort, true);
      assert.match(
        abortSignal.reason,
        /Workload .* has zero requests during active load run|Workload .* has 0 requests during active test run|INACTIVE_WORKLOAD/i,
      );
    });

    test('start() with preflight enabled transitions smoothly to active mode when generator supplies load', async () => {
      let isPreflightPhase = true;
      const producer = new RollingErrorRateProducer(60);

      const mockFetch = async (url) => {
        const now = Date.now();
        if (url.includes('metrics')) {
          const currentSec = Math.floor(now / 1000);
          return {
            statusCode: 200,
            body: `node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 8000000000 ${currentSec}\n`,
          };
        }
        if (url.includes('error-rate')) {
          if (isPreflightPhase) {
            return {
              statusCode: 200,
              body: JSON.stringify(producer.getPreflightSample(now / 1000)),
            };
          }
          return {
            statusCode: 200,
            body: JSON.stringify(producer.getSample(now / 1000)),
          };
        }
        return { statusCode: 200, body: 'OK' };
      };

      const watchdog = new PlatformWatchdog({
        runId: 'test_start_active_load',
        edgeMetricsUrl: 'http://100.113.240.3:9100/metrics',
        errorRateSource: 'http://mock/error-rate',
        legacyCheckIntervalMs: 80,
        pollIntervalMs: 25,
        fetchFn: mockFetch,
        abortSignalFile: path.join(tmpDir, 'start_active_load.signal'),
      });

      // Start the watchdog WITH PREFLIGHT ENABLED
      await watchdog.start({ skipPreflight: false, exitOnError: false });
      isPreflightPhase = false;

      // Generator supplies active load
      producer.recordSuccess('api_mix', 50);
      producer.recordSuccess('hls_viewers', 50);

      // Run active loop for 150ms
      await new Promise((r) => setTimeout(r, 150));
      await watchdog.stop();

      // No abort triggered!
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'start_active_load.signal')), false);
      assert.ok(watchdog.legacyRequestStarts.length >= 2);
    });
  });
});
