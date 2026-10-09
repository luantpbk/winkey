#!/usr/bin/env node

/**
 * deploy/lt2/watchdog.mjs
 *
 * Platform watchdog for Winkey Task LT2 (1,000-viewer load test, ADR-034).
 * Monitors:
 * 1. edge-1 MemAvailable (must remain >= 1 GiB; reads verified edge metric, NEVER generator RAM; fail-closed)
 * 2. 4 canonical legacy sites (kendrickheller.com, cuuhohanam.com, kidzlab.edu.vn, sblaichau.vn every 30s concurrently)
 * 3. Sustained >5% load HTTP error rate for 60 seconds across both workloads (fail-closed)
 *
 * Safety & Fail-Closed Protocols:
 * - Telemetry loss (missing endpoint, HTTP 500, stale metrics, wrong node, invalid/non-finite rates) aborts immediately.
 * - Total wall-clock deadline spanning entire request lifecycle prevents trickling body bypass.
 * - Bounded payload buffer prevents memory exhaustion attacks.
 * - Atomic private replacement (mode 0600) for abort sentinel file.
 * - Process signaling (SIGINT) to runner PID upon abort.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Default canonical legacy sites (ADR-014 / deploy/ansible/README.md)
export const DEFAULT_LEGACY_SITES = [
  'https://kendrickheller.com',
  'https://cuuhohanam.com',
  'https://kidzlab.edu.vn',
  'https://sblaichau.vn',
];

export const ONE_GIB_BYTES = 1073741824; // 1 GiB in bytes
export const MAX_PAYLOAD_BYTES = 131072; // 128 KiB buffer limit
export const TRUSTED_EDGE_NODE = 'edge-1';
export const TRUSTED_EDGE_INSTANCE = '100.113.240.3:9100';
export const EXPECTED_RAM_METRIC = 'node_memory_MemAvailable_bytes';

/**
 * Validates whether a URL points to the trusted edge-1 node-exporter metrics endpoint.
 * Requires exact hostname, port, and /metrics path. Rejects substrings and deceptive domains.
 */
export function isTrustedExporterUrl(
  urlStr,
  expectedHost = '100.113.240.3',
  expectedPort = '9100',
) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr);
    const hostMatches = u.hostname === expectedHost || u.hostname === 'edge-1';
    const portMatches = u.port === expectedPort || (u.port === '' && expectedPort === '80');
    const pathMatches = u.pathname === '/metrics' || u.pathname === '/metrics/';
    return hostMatches && portMatches && pathMatches;
  } catch {
    return false;
  }
}

/**
 * Parses MemAvailable bytes from Prometheus text exposition or VictoriaMetrics/Prometheus JSON.
 * Validates edge-1 node ownership, exact instance, metric name, freshness timestamp, and finite non-negative values.
 */
export function parseMemAvailable(body, options = {}) {
  const {
    expectedNode = TRUSTED_EDGE_NODE,
    expectedInstance = TRUSTED_EDGE_INSTANCE,
    maxAgeSec = 120,
    maxClockSkewSec = 15,
    nowSec = Date.now() / 1000,
    sourceUrl = '',
  } = options;

  if (!body) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  // 1. Try VictoriaMetrics / Prometheus JSON format:
  // {"status":"success","data":{"result":[{"metric":{"__name__":"node_memory_MemAvailable_bytes","instance":"100.113.240.3:9100","node":"edge-1"},"value":[1791457887,"7481970688"]}]}}
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (data?.status === 'success' && Array.isArray(data?.data?.result)) {
        if (data.data.result.length === 0) {
          return {
            error: 'EMPTY_RESULT',
            reason: 'VictoriaMetrics query returned empty result vector',
          };
        }

        for (const res of data.data.result) {
          const metricName = res?.metric?.__name__;
          if (metricName) {
            if (metricName !== EXPECTED_RAM_METRIC) {
              return {
                error: 'WRONG_METRIC',
                reason: `Metric name '${metricName}' does not match expected '${EXPECTED_RAM_METRIC}'`,
              };
            }
          } else {
            // Metric name missing in metric labels map: verify query provenance
            const hasQueryProvenance =
              sourceUrl &&
              (sourceUrl.includes(EXPECTED_RAM_METRIC) ||
                sourceUrl.includes(encodeURIComponent(EXPECTED_RAM_METRIC)));
            if (!hasQueryProvenance && !options.isQueryProven) {
              return {
                error: 'MISSING_METRIC_NAME',
                reason: `VictoriaMetrics result metric lacks __name__ and query provenance is not established for '${EXPECTED_RAM_METRIC}'`,
              };
            }
          }

          const metricNode = res?.metric?.node;
          const metricInstance = res?.metric?.instance;

          // Validate node ownership: exact match, reject wrong nodes
          if (metricNode && metricNode !== expectedNode) {
            return {
              error: 'WRONG_NODE',
              reason: `Telemetry node '${metricNode}' does not match expected '${expectedNode}'`,
            };
          }

          // Validate instance: exact match, reject substring matches (e.g. 100.113.240.30:9100)
          if (
            metricInstance &&
            metricInstance !== expectedInstance &&
            metricInstance !== `${expectedNode}:9100`
          ) {
            return {
              error: 'WRONG_INSTANCE',
              reason: `Telemetry instance '${metricInstance}' does not match expected '${expectedInstance}'`,
            };
          }

          // Unambiguous series: must identify expectedNode or exact expectedInstance
          const nodeMatches = metricNode === expectedNode;
          const instanceMatches =
            metricInstance === expectedInstance || metricInstance === `${expectedNode}:9100`;
          if (!nodeMatches && !instanceMatches) {
            return {
              error: 'UNVERIFIED_NODE',
              reason: `Telemetry series does not identify expected node '${expectedNode}'`,
            };
          }

          // In VictoriaMetrics query result, timestamp is MANDATORY
          const rawTimestamp = res?.value?.[0];
          if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === '') {
            return {
              error: 'MISSING_TIMESTAMP',
              reason: 'VictoriaMetrics telemetry result is missing timestamp',
            };
          }

          const timestamp = Number(rawTimestamp);
          if (!Number.isFinite(timestamp)) {
            return {
              error: 'INVALID_TIMESTAMP',
              reason: `Telemetry timestamp '${rawTimestamp}' is not a finite number`,
            };
          }

          // Future timestamp check
          if (timestamp > nowSec + maxClockSkewSec) {
            return {
              error: 'FUTURE_TIMESTAMP',
              reason: `Telemetry timestamp ${timestamp} is in the future (${(timestamp - nowSec).toFixed(1)}s ahead)`,
            };
          }

          // Stale timestamp check
          const age = nowSec - timestamp;
          if (age > maxAgeSec) {
            return {
              error: 'STALE_METRIC',
              reason: `Telemetry metric is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
            };
          }

          const valStr = res?.value?.[1];
          if (valStr === undefined || valStr === null) {
            return {
              error: 'MISSING_METRIC_VALUE',
              reason: 'VictoriaMetrics result is missing metric value',
            };
          }

          const num = Number(valStr);
          if (!Number.isFinite(num) || num < 0) {
            return {
              error: 'INVALID_METRIC_VALUE',
              reason: `Metric value '${valStr}' is not a valid non-negative finite number`,
            };
          }

          return {
            bytes: Math.round(num),
            timestamp,
            node: metricNode || expectedNode,
            instance: metricInstance || expectedInstance,
          };
        }
      }
    } catch {
      // Fall through to text parsing
    }
  }

  // 2. Direct Node-Exporter Prometheus text exposition format:
  // node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 7.49856768e+09 1791457887000
  // or node_memory_MemAvailable_bytes 7498567680
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const token = parts[0];
    const metricNameMatch = token.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/);
    const metricName = metricNameMatch ? metricNameMatch[1] : '';

    if (metricName !== EXPECTED_RAM_METRIC) {
      if (metricName.startsWith('node_memory_') && !text.includes(EXPECTED_RAM_METRIC)) {
        return {
          error: 'WRONG_METRIC',
          reason: `Metric text contains '${metricName}' instead of expected '${EXPECTED_RAM_METRIC}'`,
        };
      }
      continue;
    }

    // Check labels if present in token: {instance="...",node="..."}
    const labelMatch = token.match(/\{([^}]*)\}/);
    if (labelMatch) {
      const labels = labelMatch[1];
      const nodeMatch = labels.match(/node="([^"]+)"/);
      const instanceMatch = labels.match(/instance="([^"]+)"/);

      // If neither node nor instance is present, labels lack identity
      if (!nodeMatch && !instanceMatch) {
        if (!isTrustedExporterUrl(sourceUrl) && !options.isDirectExporter) {
          return {
            error: 'AMBIGUOUS_SERIES',
            reason: `Metric contains labels '{${labels}}' without node or instance identity and endpoint is not verified`,
          };
        }
      } else {
        if (nodeMatch && nodeMatch[1] !== expectedNode) {
          return {
            error: 'WRONG_NODE',
            reason: `Metric labels contain node='${nodeMatch[1]}' instead of expected '${expectedNode}'`,
          };
        }
        if (
          instanceMatch &&
          instanceMatch[1] !== expectedInstance &&
          instanceMatch[1] !== `${expectedNode}:9100`
        ) {
          return {
            error: 'WRONG_INSTANCE',
            reason: `Metric labels contain instance='${instanceMatch[1]}' instead of expected '${expectedInstance}'`,
          };
        }
      }
    } else {
      // Unlabeled text metric: validate trusted exact direct exporter endpoint
      if (!isTrustedExporterUrl(sourceUrl) && !options.isDirectExporter) {
        return {
          error: 'UNVERIFIED_SOURCE',
          reason:
            'Unlabeled Prometheus text metric requires trusted exact endpoint (e.g. http://100.113.240.3:9100/metrics)',
        };
      }
    }

    const valStr = parts[1];
    const num = Number(valStr);
    if (!Number.isFinite(num) || num < 0) {
      return {
        error: 'INVALID_METRIC_VALUE',
        reason: `Parsed metric value '${valStr}' is not a valid non-negative finite number`,
      };
    }

    // Text exposition optional timestamp (parts[2] if present)
    let timestamp = null;
    if (parts.length >= 3 && parts[2]) {
      const tsRaw = Number(parts[2]);
      if (!Number.isFinite(tsRaw)) {
        return {
          error: 'INVALID_TIMESTAMP',
          reason: `Text metric timestamp '${parts[2]}' is not a finite number`,
        };
      }
      const tsSec =
        tsRaw > 1e11 || Math.abs(tsRaw / 1000 - nowSec) < Math.abs(tsRaw - nowSec)
          ? tsRaw / 1000
          : tsRaw;
      if (tsSec > nowSec + maxClockSkewSec) {
        return {
          error: 'FUTURE_TIMESTAMP',
          reason: `Text metric timestamp is in the future (${(tsSec - nowSec).toFixed(1)}s ahead)`,
        };
      }
      const age = nowSec - tsSec;
      if (age > maxAgeSec) {
        return {
          error: 'STALE_METRIC',
          reason: `Telemetry metric is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
        };
      }
      timestamp = tsSec;
    } else {
      // Current fresh observation from direct scrape
      timestamp = nowSec;
    }

    return {
      bytes: Math.round(num),
      timestamp,
      node: expectedNode,
      instance: expectedInstance,
    };
  }

  return null;
}

/**
 * HTTP GET helper with TOTAL WALL-CLOCK DEADLINE and BOUNDED BUFFERING.
 * Guarantees timeout even if server trickles bytes slowly or hangs mid-body.
 * Supports discardBody mode for status-check probes with large response bodies.
 */
export function fetchWithWallClockDeadline(urlStr, timeoutMs = 5000, opts = {}) {
  const maxBytes = typeof opts === 'number' ? opts : opts.maxBytes || MAX_PAYLOAD_BYTES;
  const discardBody = typeof opts === 'object' && opts !== null && Boolean(opts.discardBody);
  const maxDiscardBytes =
    typeof opts === 'object' && opts !== null && opts.maxDiscardBytes
      ? opts.maxDiscardBytes
      : 10 * 1024 * 1024; // 10 MiB safety ceiling when discarding

  return new Promise((resolve, reject) => {
    let timer = null;
    let finished = false;
    let req = null;

    const cleanup = () => {
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    try {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      // Wall-clock deadline spanning entire connection + headers + body transfer
      timer = setTimeout(() => {
        if (!finished) {
          cleanup();
          const err = new Error(`Total wall-clock deadline exceeded (${timeoutMs}ms)`);
          if (req) {
            req.on('error', () => {});
            req.destroy();
          }
          reject(err);
        }
      }, timeoutMs);

      req = lib.get(
        url,
        {
          headers: { 'User-Agent': 'Winkey-LT2-Platform-Watchdog/2.0' },
        },
        (res) => {
          let receivedBytes = 0;
          let data = '';

          res.on('data', (chunk) => {
            if (finished) return;
            receivedBytes += chunk.length;

            if (discardBody) {
              if (receivedBytes > maxDiscardBytes) {
                cleanup();
                const err = new Error(
                  `Response payload exceeded discard limit of ${maxDiscardBytes} bytes`,
                );
                res.on('error', () => {});
                req.on('error', () => {});
                res.destroy();
                req.destroy();
                reject(err);
                return;
              }
              // Do not accumulate chunks in memory
              return;
            }

            if (receivedBytes > maxBytes) {
              cleanup();
              const err = new Error(`Response payload exceeded limit of ${maxBytes} bytes`);
              res.on('error', () => {});
              req.on('error', () => {});
              res.destroy();
              req.destroy();
              reject(err);
              return;
            }
            data += chunk;
          });

          res.on('end', () => {
            if (finished) return;
            cleanup();
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: data,
              bytes: receivedBytes,
            });
          });

          res.on('error', (err) => {
            if (finished) return;
            cleanup();
            reject(err);
          });
        },
      );

      req.on('error', (err) => {
        if (finished) return;
        cleanup();
        reject(err);
      });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

// Backwards-compatible alias
export const fetchWithTimeout = fetchWithWallClockDeadline;

/**
 * Checks edge-1 MemAvailable from verified metrics source.
 * FAIL-CLOSED: Rejects missing source, HTTP errors, stale/wrong-node metrics, or memory < minBytes.
 */
export async function checkEdgeRam(
  metricsUrl,
  minBytes = ONE_GIB_BYTES,
  fetchFn = fetchWithWallClockDeadline,
  options = {},
) {
  // Fail-closed on missing configuration
  if (!metricsUrl) {
    return {
      abort: true,
      reason: 'EDGE_METRICS_URL is required but not configured (failing closed)',
    };
  }

  try {
    const res = await fetchFn(
      metricsUrl,
      options.timeoutMs || 5000,
      options.maxBytes || MAX_PAYLOAD_BYTES,
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return {
        abort: true,
        reason: `Edge-1 metrics endpoint returned HTTP ${res.statusCode} (telemetry loss)`,
      };
    }

    const parsed = parseMemAvailable(res.body, { ...options, sourceUrl: metricsUrl });
    if (!parsed) {
      return {
        abort: true,
        reason:
          'Failed to parse node_memory_MemAvailable_bytes from edge-1 metrics (telemetry loss)',
      };
    }

    if (parsed.error) {
      return {
        abort: true,
        reason: `Edge-1 telemetry validation failed: ${parsed.reason}`,
      };
    }

    const availBytes = parsed.bytes;
    if (availBytes < minBytes) {
      const availMib = (availBytes / (1024 * 1024)).toFixed(1);
      const minMib = (minBytes / (1024 * 1024)).toFixed(1);
      return {
        abort: true,
        availBytes,
        reason: `Edge-1 MemAvailable (${availMib} MiB) fell below required safety threshold (${minMib} MiB)`,
      };
    }

    return { ok: true, availBytes, node: parsed.node, timestamp: parsed.timestamp };
  } catch (err) {
    return {
      abort: true,
      reason: `Edge-1 metrics probe failed: ${err.message} (telemetry loss)`,
    };
  }
}

/**
 * Checks that all canonical legacy sites respond with HTTP 200 concurrently.
 * All probes run in parallel to guarantee completing within the timeout deadline.
 * Uses bounded body discard so legitimate large 200 responses (>64 KiB) do not trigger false outages.
 */
export async function checkLegacySites(
  sites = DEFAULT_LEGACY_SITES,
  timeoutMs = 5000,
  fetchFn = fetchWithWallClockDeadline,
) {
  if (!Array.isArray(sites) || sites.length === 0) {
    return {
      abort: true,
      reason: 'LEGACY_SITES list is required and cannot be empty (failing closed)',
    };
  }

  // Concurrent execution across all target legacy sites with bounded discard
  const probePromises = sites.map(async (site) => {
    try {
      const res = await fetchFn(site, timeoutMs, { discardBody: true });
      return { site, statusCode: res.statusCode, ok: res.statusCode === 200 };
    } catch (err) {
      return { site, ok: false, error: err.message };
    }
  });

  const results = await Promise.all(probePromises);

  for (const r of results) {
    if (!r.ok) {
      if (r.error) {
        return {
          abort: true,
          failedSite: r.site,
          reason: `Legacy site ${r.site} probe failed: ${r.error}`,
        };
      }
      return {
        abort: true,
        failedSite: r.site,
        statusCode: r.statusCode,
        reason: `Legacy site ${r.site} returned HTTP ${r.statusCode} (expected 200)`,
      };
    }
  }

  return { ok: true, results };
}

/**
 * Producer class for rolling 60-second HTTP error rate telemetry across both workloads.
 * Maintains a sliding 60-second window in memory, pruning expired buckets,
 * and outputs schema-valid rolling 60s telemetry samples.
 */
export class RollingErrorRateProducer {
  constructor(windowSec = 60) {
    this.windowSec = windowSec;
    // Map of epoch second -> { api_mix: { requests, failed }, hls_viewers: { requests, failed } }
    this.buckets = new Map();
  }

  record(workload, requests = 1, failed = 0, timestampMs = Date.now()) {
    if (workload !== 'api_mix' && workload !== 'hls_viewers') {
      throw new Error(`Unknown workload '${workload}'; expected 'api_mix' or 'hls_viewers'`);
    }
    const sec = Math.floor(timestampMs / 1000);
    let bucket = this.buckets.get(sec);
    if (!bucket) {
      bucket = {
        api_mix: { requests: 0, failed: 0 },
        hls_viewers: { requests: 0, failed: 0 },
      };
      this.buckets.set(sec, bucket);
    }
    bucket[workload].requests += requests;
    bucket[workload].failed += failed;
  }

  recordSuccess(workload, count = 1, timestampMs = Date.now()) {
    this.record(workload, count, 0, timestampMs);
  }

  recordFailure(workload, count = 1, timestampMs = Date.now()) {
    this.record(workload, count, count, timestampMs);
  }

  getSample(nowSec = Math.floor(Date.now() / 1000)) {
    const minSec = nowSec - this.windowSec;
    for (const [sec] of this.buckets) {
      if (sec <= minSec) {
        this.buckets.delete(sec);
      }
    }

    const workloads = {
      api_mix: { requests: 0, failed: 0 },
      hls_viewers: { requests: 0, failed: 0 },
    };

    for (const [sec, bucket] of this.buckets) {
      if (sec > minSec && sec <= nowSec) {
        workloads.api_mix.requests += bucket.api_mix.requests;
        workloads.api_mix.failed += bucket.api_mix.failed;
        workloads.hls_viewers.requests += bucket.hls_viewers.requests;
        workloads.hls_viewers.failed += bucket.hls_viewers.failed;
      }
    }

    return {
      version: '1.0',
      windowSec: this.windowSec,
      timestamp: nowSec,
      workloads,
    };
  }

  getPreflightSample(nowSec = Math.floor(Date.now() / 1000)) {
    return {
      version: '1.0',
      windowSec: this.windowSec,
      timestamp: nowSec,
      status: 'ready',
      workloads: {
        api_mix: { requests: 0, failed: 0 },
        hls_viewers: { requests: 0, failed: 0 },
      },
    };
  }
}

/**
 * Producer interface helper for schema-valid rolling 60-second error rate samples across both workloads.
 */
export function createRolling60sSample({
  timestampSec = Math.floor(Date.now() / 1000),
  windowSec = 60,
  workloads = {},
  status,
} = {}) {
  const sample = {
    version: '1.0',
    windowSec,
    timestamp: timestampSec,
    workloads: {
      api_mix: {
        requests: workloads.api_mix?.requests ?? 0,
        failed: workloads.api_mix?.failed ?? 0,
      },
      hls_viewers: {
        requests: workloads.hls_viewers?.requests ?? 0,
        failed: workloads.hls_viewers?.failed ?? 0,
      },
    },
  };
  if (status) sample.status = status;
  return sample;
}

/**
 * Parses HTTP error rate telemetry across BOTH workloads (api_mix and hls_viewers).
 * Validates schema, timestamps, window duration (exactly 60s), per-workload counts without coercion,
 * and active observations on both workloads during active run.
 * Rejects bare rates, unscoped vector bypass, missing workloads, negative counts, and stale telemetry.
 */
export function parseHttpErrorRate(bodyOrData, options = {}) {
  const {
    maxAgeSec = 120,
    maxClockSkewSec = 15,
    nowSec = Date.now() / 1000,
    isPreflight = false,
  } = options;
  if (bodyOrData === null || bodyOrData === undefined || bodyOrData === '') {
    return { error: 'EMPTY_TELEMETRY', reason: 'Error rate telemetry data is empty' };
  }

  // Reject bare numbers (e.g. 0.05)
  if (typeof bodyOrData === 'number') {
    return {
      error: 'BARE_RATE_DISALLOWED',
      reason: 'Bare rate values without schema, timestamp, and workloads are disallowed',
    };
  }

  let data = bodyOrData;
  if (typeof bodyOrData === 'string') {
    const trimmed = bodyOrData.trim();
    if (!trimmed.startsWith('{')) {
      return {
        error: 'BARE_RATE_DISALLOWED',
        reason: 'Bare rate string without JSON schema, timestamp, and workloads is disallowed',
      };
    }
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      return { error: 'MALFORMED_JSON', reason: `Malformed JSON telemetry: ${err.message}` };
    }
  }

  // Reject unscoped PromQL vector bypass: must provide dual-workload rolling 60s schema
  if (data?.status === 'success' && Array.isArray(data?.data?.result)) {
    return {
      error: 'UNSCOPED_VECTOR_DISALLOWED',
      reason: 'Unscoped PromQL vector does not satisfy required dual-workload rolling 60s schema',
    };
  }

  // Structured JSON schema: rolling 60s across BOTH workloads
  if (!data || typeof data !== 'object') {
    return {
      error: 'INVALID_SCHEMA',
      reason: 'Telemetry must be a valid JSON object',
    };
  }

  // Timestamp validation
  if (data.timestamp === undefined || data.timestamp === null || data.timestamp === '') {
    return {
      error: 'MISSING_TIMESTAMP',
      reason: 'Rolling 60s telemetry is missing timestamp',
    };
  }

  const timestamp = Number(data.timestamp);
  if (!Number.isFinite(timestamp)) {
    return {
      error: 'INVALID_TIMESTAMP',
      reason: `Telemetry timestamp '${data.timestamp}' is not a finite number`,
    };
  }

  if (timestamp > nowSec + maxClockSkewSec) {
    return {
      error: 'FUTURE_TIMESTAMP',
      reason: `Telemetry timestamp ${timestamp} is in the future (${(timestamp - nowSec).toFixed(1)}s ahead)`,
    };
  }

  const age = nowSec - timestamp;
  if (age > maxAgeSec) {
    return {
      error: 'STALE_METRIC',
      reason: `Telemetry sample is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
    };
  }

  // WindowSec validation: MUST be exactly 60 seconds
  if (
    typeof data.windowSec !== 'number' ||
    !Number.isInteger(data.windowSec) ||
    data.windowSec !== 60
  ) {
    return {
      error: 'INVALID_WINDOW',
      reason: `Telemetry windowSec (${data.windowSec}) must be exactly 60 seconds`,
    };
  }

  // Mandatory workloads: BOTH api_mix AND hls_viewers required
  if (!data.workloads || typeof data.workloads !== 'object') {
    return {
      error: 'MISSING_WORKLOADS',
      reason: 'Telemetry must contain workloads object with both api_mix and hls_viewers',
    };
  }

  const REQUIRED_WORKLOADS = ['api_mix', 'hls_viewers'];
  for (const wl of REQUIRED_WORKLOADS) {
    if (!data.workloads[wl] || typeof data.workloads[wl] !== 'object') {
      return {
        error: 'MISSING_WORKLOAD',
        reason: `Telemetry is missing required workload '${wl}'`,
      };
    }
  }

  // Validate each workload counts BEFORE summing (prevent null coercion or negative cancellation)
  let totalRequests = 0;
  let failedRequests = 0;

  for (const wl of REQUIRED_WORKLOADS) {
    const w = data.workloads[wl];

    if (typeof w.requests !== 'number' || !Number.isInteger(w.requests) || w.requests < 0) {
      return {
        error: 'INVALID_WORKLOAD_COUNTS',
        reason: `Workload '${wl}' requests must be a non-negative integer number (no coercion)`,
      };
    }

    if (typeof w.failed !== 'number' || !Number.isInteger(w.failed) || w.failed < 0) {
      return {
        error: 'INVALID_WORKLOAD_COUNTS',
        reason: `Workload '${wl}' failed must be a non-negative integer number (no coercion)`,
      };
    }

    if (w.failed > w.requests) {
      return {
        error: 'INVALID_WORKLOAD_COUNTS',
        reason: `Workload '${wl}' failed (${w.failed}) exceeds requests (${w.requests})`,
      };
    }

    // Active run checks: API traffic must not hide HLS 0
    if (!isPreflight && w.requests === 0) {
      return {
        error: 'INACTIVE_WORKLOAD',
        reason: `Workload '${wl}' has zero requests during active load run; active observations required for both workloads`,
      };
    }

    totalRequests += w.requests;
    failedRequests += w.failed;
  }

  // Zero requests check: during active run, zero total traffic fails closed
  if (!isPreflight && totalRequests === 0) {
    return {
      error: 'ZERO_REQUESTS',
      reason: 'Rolling 60s window has zero total requests across workloads during active run',
    };
  }

  const rate = totalRequests === 0 ? 0 : failedRequests / totalRequests;
  return {
    rate,
    totalRequests,
    failedRequests,
    timestamp,
    windowSec: 60,
    workloads: {
      api_mix: { ...data.workloads.api_mix },
      hls_viewers: { ...data.workloads.hls_viewers },
    },
    isPreflight,
  };
}

/**
 * Checks whether load HTTP error rate exceeds maxRate sustained for sustainedSec.
 * FAIL-CLOSED: Rejects missing source, read errors, malformed/non-finite data, or sustained breaches.
 */
export async function checkHttpErrorRate(
  errorRateSource,
  maxRate = 0.05,
  sustainedSec = 60,
  state = { firstExceededAt: null },
  fetchFn = fetchWithWallClockDeadline,
  options = {},
) {
  // Fail-closed if source is missing or unconfigured
  if (!errorRateSource) {
    return {
      abort: true,
      reason: 'ERROR_RATE_SOURCE is required but not configured (failing closed)',
    };
  }

  let rawContent = '';

  try {
    if (errorRateSource.startsWith('http://') || errorRateSource.startsWith('https://')) {
      const res = await fetchFn(
        errorRateSource,
        options.timeoutMs || 5000,
        options.maxBytes || MAX_PAYLOAD_BYTES,
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return {
          abort: true,
          reason: `Error rate telemetry endpoint returned HTTP ${res.statusCode} (telemetry loss)`,
        };
      }
      rawContent = res.body;
    } else {
      if (!fs.existsSync(errorRateSource)) {
        return {
          abort: true,
          reason: `Error rate telemetry file '${errorRateSource}' does not exist (telemetry loss)`,
        };
      }
      rawContent = fs.readFileSync(errorRateSource, 'utf8');
    }
  } catch (err) {
    return {
      abort: true,
      reason: `Failed to read error rate telemetry: ${err.message} (telemetry loss)`,
    };
  }

  const parsed = parseHttpErrorRate(rawContent, options);
  if (parsed.error) {
    return {
      abort: true,
      reason: `Error rate telemetry validation failed: ${parsed.reason} (telemetry loss)`,
    };
  }

  if (options.isPreflight) {
    return {
      ok: true,
      rate: parsed.rate,
      preflight: true,
      totalRequests: parsed.totalRequests,
    };
  }

  const currentRate = parsed.rate;
  const now = options.nowSec !== undefined ? options.nowSec * 1000 : Date.now();

  if (currentRate > maxRate) {
    if (!state.firstExceededAt) {
      state.firstExceededAt = now;
    }
    const durationSec = (now - state.firstExceededAt) / 1000;
    if (durationSec >= sustainedSec) {
      return {
        abort: true,
        rate: currentRate,
        durationSec,
        reason: `Load HTTP error rate (${(currentRate * 100).toFixed(1)}%) exceeded ${(maxRate * 100).toFixed(1)}% threshold continuously for ${durationSec.toFixed(0)}s (limit: ${sustainedSec}s)`,
        state,
      };
    }
    return {
      ok: true,
      rate: currentRate,
      warning: true,
      durationSec,
      state,
    };
  }

  // Reset sustained tracker on normal rate
  state.firstExceededAt = null;
  return { ok: true, rate: currentRate, state };
}

/**
 * PlatformWatchdog runner class
 */
export const RUN_ID_REGEX = /^[a-zA-Z0-9_\-\.]{4,64}$/;

/**
 * PlatformWatchdog runner class
 */
export class PlatformWatchdog {
  constructor(config = {}) {
    const rawRunId = config.runId || process.env.RUN_ID;
    if (rawRunId) {
      if (!RUN_ID_REGEX.test(rawRunId)) {
        throw new Error(`Invalid runId '${rawRunId}'. Must match /^[a-zA-Z0-9_\\-\\.]{4,64}$/`);
      }
      this.runId = rawRunId;
    } else {
      this.runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    this.edgeMetricsUrl = config.edgeMetricsUrl || process.env.EDGE_METRICS_URL || '';
    this.minMemBytes =
      config.minMemBytes || Number(process.env.MIN_MEM_AVAILABLE_BYTES) || ONE_GIB_BYTES;
    this.legacySites =
      config.legacySites ||
      (process.env.LEGACY_SITES
        ? process.env.LEGACY_SITES.split(',').map((s) => s.trim())
        : DEFAULT_LEGACY_SITES);
    this.legacyCheckIntervalMs =
      config.legacyCheckIntervalMs || Number(process.env.LEGACY_CHECK_INTERVAL_MS) || 30000;
    this.errorRateSource = config.errorRateSource || process.env.ERROR_RATE_SOURCE || '';
    this.maxErrorRate = config.maxErrorRate || Number(process.env.MAX_HTTP_ERROR_RATE) || 0.05;
    this.errorSustainedSec =
      config.errorSustainedSec || Number(process.env.ERROR_RATE_SUSTAINED_SEC) || 60;
    this.checkIntervalMs = config.checkIntervalMs || Number(process.env.CHECK_INTERVAL_MS) || 5000;
    this.targetPid =
      config.targetPid || (process.env.TARGET_PID ? Number(process.env.TARGET_PID) : null);

    // Require run-owned abort sentinel file path: default is scoped by runId
    if (config.abortSignalFile || process.env.ABORT_SIGNAL_FILE) {
      this.abortSignalFile = path.resolve(config.abortSignalFile || process.env.ABORT_SIGNAL_FILE);
    } else {
      const runDir = path.join(os.tmpdir(), `winkey_lt2_${this.runId}`);
      this.abortSignalFile = path.join(runDir, 'abort.signal');
    }

    this.fetchFn = config.fetchFn || fetchWithWallClockDeadline;
    this.expectedNode = config.expectedNode || process.env.EXPECTED_NODE || TRUSTED_EDGE_NODE;
    this.expectedInstance =
      config.expectedInstance || process.env.EXPECTED_INSTANCE || TRUSTED_EDGE_INSTANCE;

    this.running = false;
    this.errorRateState = { firstExceededAt: null };
    this.nextLegacyCheckAt = 0;
    this.legacyRequestStarts = [];
    this.pollIntervalMs = config.pollIntervalMs || config.checkIntervalMs || 1000;
    this.legacyTimeoutMs = config.legacyTimeoutMs || 5000;
    this.exitOnError = config.exitOnError !== false;
    this.pollTimer = null;
    this.legacyTimer = null;
    this.inFlightProbes = new Set();
    this.timer = null;
  }

  /**
   * Triggers auto-abort:
   * - Atomically persists abort payload using exclusive mode 0600 private replacement
   * - Prevents overwriting another run's sentinel
   * - Sends SIGINT to runner PID (if configured)
   * - Stops the watchdog loop
   */
  triggerAbort(reason, details = {}) {
    const timestamp = new Date().toISOString();
    const abortPayload = {
      abort: true,
      runId: this.runId,
      reason,
      timestamp,
      details,
    };

    console.error(
      `\n[WATCHDOG_ALERT] ${timestamp} [${this.runId}] - AUTO-ABORT TRIGGERED: ${reason}`,
    );

    let filePersisted = false;
    let signalSent = false;
    const errors = [];

    // 1. Atomic private replacement of abort signal file (mode 0600, exclusive creation)
    try {
      const payloadStr = JSON.stringify(abortPayload, null, 2);
      const targetPath = path.resolve(this.abortSignalFile);
      const dir = path.dirname(targetPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Do not overwrite another run's sentinel
      if (fs.existsSync(targetPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
          if (existing?.runId && existing.runId !== this.runId) {
            throw new Error(`Target abort file belongs to another run '${existing.runId}'`);
          }
        } catch (err) {
          if (err.message.includes('belongs to another run')) throw err;
        }
      }

      // Exclusive temp file (flag 'wx' prevents collisions/symlink following)
      const tmpFile = path.join(
        dir,
        `.${path.basename(targetPath)}.${this.runId}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
      );

      const fd = fs.openSync(tmpFile, 'wx', 0o600);
      try {
        fs.writeSync(fd, payloadStr, 0, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Atomic rename
      fs.renameSync(tmpFile, targetPath);
      filePersisted = true;
      console.error(`[WATCHDOG] Abort signal atomically written to ${targetPath} (mode 0600)`);
    } catch (err) {
      errors.push(`Persistence failure: ${err.message}`);
      console.error(`[WATCHDOG] Failed to persist abort signal file: ${err.message}`);
    }

    // 2. Notify target runner PID if supplied
    if (this.targetPid) {
      try {
        console.error(`[WATCHDOG] Sending SIGINT to target test runner PID ${this.targetPid}...`);
        process.kill(this.targetPid, 'SIGINT');
        signalSent = true;
      } catch (err) {
        errors.push(`Signaling failure: ${err.message}`);
        console.error(`[WATCHDOG] Failed to signal target PID ${this.targetPid}: ${err.message}`);
      }
    }

    this.stop();
    return {
      abortPayload,
      filePersisted,
      signalSent,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Preflight verification before load begins.
   * Confirms reachability and freshness of all mandatory telemetry sources.
   */
  async preflight(now = Date.now()) {
    console.log(`[WATCHDOG] Running preflight telemetry and site verification...`);

    // 1. Mandatory edge-1 RAM telemetry source check
    const ramCheck = await checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn, {
      expectedNode: this.expectedNode,
      expectedInstance: this.expectedInstance,
      nowSec: now / 1000,
    });
    if (ramCheck.abort) {
      this.triggerAbort(`Preflight failed: ${ramCheck.reason}`, {
        type: 'PREFLIGHT_EDGE_RAM',
        metric: ramCheck,
      });
      return false;
    }

    // 2. Mandatory legacy sites check (concurrent)
    const legacyCheck = await checkLegacySites(this.legacySites, 5000, this.fetchFn);
    if (legacyCheck.abort) {
      this.triggerAbort(`Preflight failed: ${legacyCheck.reason}`, {
        type: 'PREFLIGHT_LEGACY_SITE',
        site: legacyCheck.failedSite,
      });
      return false;
    }

    this.nextLegacyCheckAt = now + this.legacyCheckIntervalMs;
    this.legacyRequestStarts.push(now);

    // 3. Mandatory error rate telemetry source check
    const errCheck = await checkHttpErrorRate(
      this.errorRateSource,
      this.maxErrorRate,
      this.errorSustainedSec,
      this.errorRateState,
      this.fetchFn,
      { nowSec: now / 1000 },
    );
    if (errCheck.abort) {
      this.triggerAbort(`Preflight failed: ${errCheck.reason}`, {
        type: 'PREFLIGHT_ERROR_RATE',
        check: errCheck,
      });
      return false;
    }

    console.log(
      `[WATCHDOG] Preflight PASSED: edge-1 metrics, 4 legacy sites, and error rate telemetry verified.`,
    );
    return true;
  }

  /**
   * Executes one watchdog monitoring cycle.
   * Fixed monotonic legacy schedule: probe starts are locked to monotonic schedule ticks.
   * Probes run concurrently so delayed RAM or error probes never drift legacy probe starts.
   * FAIL-CLOSED: Returns false if ANY check fails or if any telemetry source is missing.
   */
  async runCycle(now = Date.now()) {
    const tasks = [];

    // 1. Mandatory Edge-1 RAM check (fail-closed)
    tasks.push(
      checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn, {
        expectedNode: this.expectedNode,
        expectedInstance: this.expectedInstance,
        nowSec: now / 1000,
      }).then((ramCheck) => {
        if (ramCheck.abort) {
          this.triggerAbort(ramCheck.reason, { type: 'EDGE_RAM_EXHAUSTION', metric: ramCheck });
          return false;
        }
        return true;
      }),
    );

    // 2. Mandatory Legacy sites check on fixed monotonic schedule (concurrent)
    const isDue = this.nextLegacyCheckAt === 0 || now >= this.nextLegacyCheckAt;
    if (isDue) {
      if (this.nextLegacyCheckAt === 0) {
        this.nextLegacyCheckAt = now + this.legacyCheckIntervalMs;
      } else {
        while (this.nextLegacyCheckAt <= now) {
          this.nextLegacyCheckAt += this.legacyCheckIntervalMs;
        }
      }
      this.legacyRequestStarts.push(now);
      tasks.push(
        checkLegacySites(this.legacySites, 5000, this.fetchFn).then((legacyCheck) => {
          if (legacyCheck.abort) {
            this.triggerAbort(legacyCheck.reason, {
              type: 'LEGACY_SITE_FAILURE',
              site: legacyCheck.failedSite,
            });
            return false;
          }
          console.log(`[WATCHDOG] Legacy sites check: 4/4 PASS (HTTP 200)`);
          return true;
        }),
      );
    }

    // 3. Mandatory Sustained HTTP error rate check (fail-closed)
    tasks.push(
      checkHttpErrorRate(
        this.errorRateSource,
        this.maxErrorRate,
        this.errorSustainedSec,
        this.errorRateState,
        this.fetchFn,
        { nowSec: now / 1000 },
      ).then((errCheck) => {
        if (errCheck.abort) {
          this.triggerAbort(errCheck.reason, {
            type: 'SUSTAINED_HTTP_ERRORS',
            rate: errCheck.rate,
          });
          return false;
        }
        return true;
      }),
    );

    const results = await Promise.all(tasks);
    return results.every(Boolean);
  }

  async start(options = {}) {
    this.running = true;
    const skipPreflight = Boolean(options.skipPreflight);
    const exitOnError = options.exitOnError !== undefined ? options.exitOnError : this.exitOnError;

    console.log(`[WATCHDOG] Platform watchdog started.`);
    console.log(`  - Run ID: ${this.runId}`);
    console.log(`  - Edge-1 Metrics URL: ${this.edgeMetricsUrl || '(missing)'}`);
    console.log(`  - Minimum edge-1 RAM: ${(this.minMemBytes / (1024 * 1024)).toFixed(0)} MiB`);
    console.log(`  - Expected Node: ${this.expectedNode}`);
    console.log(`  - Legacy sites: ${this.legacySites.join(', ')}`);
    console.log(`  - Legacy check interval: ${this.legacyCheckIntervalMs / 1000}s`);
    console.log(`  - Error rate source: ${this.errorRateSource || '(missing)'}`);
    console.log(
      `  - Max HTTP error rate: ${(this.maxErrorRate * 100).toFixed(0)}% for ${this.errorSustainedSec}s`,
    );
    console.log(`  - Target PID: ${this.targetPid || '(none)'}`);
    console.log(`  - Abort Signal File: ${this.abortSignalFile}`);

    // Execute mandatory preflight
    if (!skipPreflight) {
      const preflightOk = await this.preflight();
      if (!preflightOk) {
        if (exitOnError) process.exit(1);
        return false;
      }
    }

    // 1. Independent Monotonic Legacy Scheduler
    const scheduleNextLegacy = (targetTime) => {
      if (!this.running) return;
      const delay = Math.max(0, targetTime - Date.now());
      this.legacyTimer = setTimeout(async () => {
        if (!this.running) return;
        const startAt = Date.now();
        this.legacyRequestStarts.push(startAt);
        const nextTarget = startAt + this.legacyCheckIntervalMs;

        const probePromise = checkLegacySites(this.legacySites, this.legacyTimeoutMs, this.fetchFn);
        this.inFlightProbes.add(probePromise);
        try {
          const res = await probePromise;
          if (res.abort && this.running) {
            this.triggerAbort(res.reason, { type: 'LEGACY_SITE_FAILURE', site: res.failedSite });
            if (exitOnError) process.exit(1);
          } else if (this.running) {
            console.log(`[WATCHDOG] Legacy sites check: 4/4 PASS (HTTP 200)`);
          }
        } finally {
          this.inFlightProbes.delete(probePromise);
        }

        if (this.running) {
          scheduleNextLegacy(nextTarget);
        }
      }, delay);
    };

    // Schedule first legacy probe after legacyCheckIntervalMs
    scheduleNextLegacy(Date.now() + this.legacyCheckIntervalMs);

    // 2. Independent Monotonic Fast Polling Scheduler (RAM + Error Rate)
    const scheduleNextPoll = (targetTime) => {
      if (!this.running) return;
      const delay = Math.max(0, targetTime - Date.now());
      this.pollTimer = setTimeout(async () => {
        if (!this.running) return;
        const startAt = Date.now();
        const nextTarget = startAt + this.pollIntervalMs;

        const ramPromise = checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn, {
          expectedNode: this.expectedNode,
          expectedInstance: this.expectedInstance,
          nowSec: startAt / 1000,
        });
        const errPromise = checkHttpErrorRate(
          this.errorRateSource,
          this.maxErrorRate,
          this.errorSustainedSec,
          this.errorRateState,
          this.fetchFn,
          { nowSec: startAt / 1000, isPreflight: false },
        );

        this.inFlightProbes.add(ramPromise);
        this.inFlightProbes.add(errPromise);

        try {
          const [ramRes, errRes] = await Promise.all([ramPromise, errPromise]);

          if (ramRes.abort && this.running) {
            this.triggerAbort(ramRes.reason, { type: 'EDGE_RAM_EXHAUSTION', metric: ramRes });
            if (exitOnError) process.exit(1);
            return;
          }

          if (errRes.abort && this.running) {
            this.triggerAbort(errRes.reason, {
              type: 'SUSTAINED_HTTP_ERRORS',
              rate: errRes.rate,
            });
            if (exitOnError) process.exit(1);
            return;
          }
        } finally {
          this.inFlightProbes.delete(ramPromise);
          this.inFlightProbes.delete(errPromise);
        }

        if (this.running) {
          scheduleNextPoll(nextTarget);
        }
      }, delay);
    };

    scheduleNextPoll(Date.now() + this.pollIntervalMs);
    return true;
  }

  async stop() {
    this.running = false;
    if (this.legacyTimer) {
      clearTimeout(this.legacyTimer);
      this.legacyTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inFlightProbes.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightProbes));
      this.inFlightProbes.clear();
    }
  }
}

// CLI entry point
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const config = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pid' && args[i + 1]) {
      config.targetPid = Number(args[++i]);
    } else if (arg === '--abort-file' && args[i + 1]) {
      config.abortSignalFile = args[++i];
    } else if (arg === '--metrics-url' && args[i + 1]) {
      config.edgeMetricsUrl = args[++i];
    } else if (arg === '--error-source' && args[i + 1]) {
      config.errorRateSource = args[++i];
    } else if (arg === '--run-id' && args[i + 1]) {
      config.runId = args[++i];
    } else if (arg === '--interval' && args[i + 1]) {
      config.checkIntervalMs = Number(args[++i]) * 1000;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node deploy/lt2/watchdog.mjs [options]`);
      console.log(`Options:`);
      console.log(`  --pid <number>          Process ID to signal on abort (SIGINT)`);
      console.log(`  --abort-file <path>     File to write abort reason JSON (mode 0600)`);
      console.log(`  --metrics-url <url>     URL for edge-1 MemAvailable metrics (fail-closed)`);
      console.log(`  --error-source <url|path> URL or file path for HTTP error rate telemetry`);
      console.log(`  --run-id <id>           Unique run identifier`);
      console.log(`  --interval <seconds>    Polling interval in seconds`);
      process.exit(0);
    }
  }

  const watchdog = new PlatformWatchdog(config);

  process.on('SIGINT', () => {
    console.log(`\n[WATCHDOG] Received SIGINT, shutting down cleanly.`);
    watchdog.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`\n[WATCHDOG] Received SIGTERM, shutting down cleanly.`);
    watchdog.stop();
    process.exit(0);
  });

  watchdog.start().catch((err) => {
    console.error(`[WATCHDOG] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
