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

/**
 * Parses MemAvailable bytes from Prometheus text exposition or VictoriaMetrics/Prometheus JSON.
 * Validates edge-1 node ownership, freshness timestamp, and finite non-negative values.
 */
export function parseMemAvailable(body, options = {}) {
  const { expectedNode = 'edge-1', maxAgeSec = 120, nowSec = Date.now() / 1000 } = options;
  if (!body) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  // 1. Try VictoriaMetrics / Prometheus JSON format:
  // {"status":"success","data":{"result":[{"metric":{"instance":"100.113.240.3:9100","node":"edge-1"},"value":[1791457887,"7481970688"]}]}}
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
          const metricNode = res?.metric?.node;
          const metricInstance = res?.metric?.instance;

          // Validate node ownership
          if (expectedNode) {
            const matchesNode = metricNode === expectedNode;
            const matchesInstance =
              metricInstance &&
              (metricInstance.includes('100.113.240.3') || metricInstance.includes(expectedNode));
            if (!matchesNode && !matchesInstance) {
              continue; // Check other entries if any
            }
          }

          const timestamp = res?.value?.[0];
          const valStr = res?.value?.[1];
          if (valStr !== undefined && valStr !== null) {
            const num = Number(valStr);
            if (!Number.isFinite(num) || num < 0) {
              return {
                error: 'INVALID_METRIC_VALUE',
                reason: `Metric value '${valStr}' is not a valid non-negative finite number`,
              };
            }

            // Freshness verification
            if (timestamp && Number.isFinite(Number(timestamp))) {
              const age = nowSec - Number(timestamp);
              if (age > maxAgeSec) {
                return {
                  error: 'STALE_METRIC',
                  reason: `Telemetry metric is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
                };
              }
            }

            return {
              bytes: Math.round(num),
              timestamp: Number(timestamp) || null,
              node: metricNode || expectedNode,
            };
          }
        }

        if (expectedNode) {
          return {
            error: 'WRONG_NODE',
            reason: `Telemetry does not match expected node '${expectedNode}'`,
          };
        }
      }
    } catch {
      // Fall through to text parsing
    }
  }

  // 2. Try Prometheus text exposition format:
  // node_memory_MemAvailable_bytes{instance="100.113.240.3:9100",node="edge-1"} 7.49856768e+09 1791457887000
  // or node_memory_MemAvailable_bytes 7498567680
  if (expectedNode && text.includes('node=')) {
    const nodeMatch = text.match(/node="([^"]+)"/);
    if (nodeMatch && nodeMatch[1] !== expectedNode && !text.includes(`node="${expectedNode}"`)) {
      return {
        error: 'WRONG_NODE',
        reason: `Metric text contains node='${nodeMatch[1]}' instead of expected '${expectedNode}'`,
      };
    }
  }

  const match = text.match(
    /node_memory_MemAvailable_bytes(?:\{[^}]*\})?\s+([0-9.eE+-]+)(?:\s+(\d+))?/,
  );
  if (match && match[1]) {
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num < 0) {
      return {
        error: 'INVALID_METRIC_VALUE',
        reason: `Parsed metric value '${match[1]}' is not a valid non-negative finite number`,
      };
    }

    const timestampMs = match[2] ? Number(match[2]) : null;
    if (timestampMs && Number.isFinite(timestampMs)) {
      const age = nowSec - timestampMs / 1000;
      if (age > maxAgeSec) {
        return {
          error: 'STALE_METRIC',
          reason: `Telemetry metric is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
        };
      }
    }

    return {
      bytes: Math.round(num),
      timestamp: timestampMs ? timestampMs / 1000 : null,
      node: expectedNode,
    };
  }

  return null;
}

/**
 * HTTP GET helper with TOTAL WALL-CLOCK DEADLINE and BOUNDED BUFFERING.
 * Guarantees timeout even if server trickles bytes slowly or hangs mid-body.
 */
export function fetchWithWallClockDeadline(urlStr, timeoutMs = 5000, maxBytes = MAX_PAYLOAD_BYTES) {
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

    const parsed = parseMemAvailable(res.body, options);
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

  // Concurrent execution across all target legacy sites
  const probePromises = sites.map(async (site) => {
    try {
      const res = await fetchFn(site, timeoutMs, 65536);
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
 * Parses HTTP error rate telemetry across both workloads (api-mix and hls-viewers).
 * Validates rolling 60s structure, numerator/denominator, freshness, and finite non-negative values.
 */
export function parseHttpErrorRate(bodyOrData, options = {}) {
  const { maxAgeSec = 120, nowSec = Date.now() / 1000 } = options;
  if (bodyOrData === null || bodyOrData === undefined || bodyOrData === '') {
    return { error: 'EMPTY_TELEMETRY', reason: 'Error rate telemetry data is empty' };
  }

  let data = bodyOrData;
  if (typeof bodyOrData === 'string') {
    const trimmed = bodyOrData.trim();
    if (trimmed.startsWith('{')) {
      try {
        data = JSON.parse(trimmed);
      } catch (err) {
        return { error: 'MALFORMED_JSON', reason: `Malformed JSON telemetry: ${err.message}` };
      }
    } else {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return {
          error: 'INVALID_RATE',
          reason: `Raw rate string '${trimmed}' is not a finite number in [0, 1]`,
        };
      }
      return { rate: num };
    }
  }

  // 1. VictoriaMetrics / Prometheus vector response format:
  // {"status":"success","data":{"result":[{"metric":{},"value":[1791457887,"0.04"]}]}}
  if (data?.status === 'success' && Array.isArray(data?.data?.result)) {
    if (data.data.result.length === 0) {
      return {
        error: 'EMPTY_RESULT',
        reason: 'VictoriaMetrics query returned empty vector for error rate',
      };
    }
    const res = data.data.result[0];
    const timestamp = res?.value?.[0];
    const valStr = res?.value?.[1];
    if (valStr !== undefined) {
      const num = Number(valStr);
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        return {
          error: 'INVALID_RATE',
          reason: `PromQL error rate value '${valStr}' is not finite in [0, 1]`,
        };
      }
      if (timestamp && Number.isFinite(Number(timestamp))) {
        const age = nowSec - Number(timestamp);
        if (age > maxAgeSec) {
          return {
            error: 'STALE_METRIC',
            reason: `Error rate telemetry is stale (${age.toFixed(0)}s old, limit: ${maxAgeSec}s)`,
          };
        }
      }
      return { rate: num, timestamp: Number(timestamp) || null };
    }
  }

  // 2. Structured JSON with rolling 60s numerator/denominator across workloads:
  // { "windowSec": 60, "totalRequests": 1000, "failedRequests": 30, "workloads": { "api_mix": {...}, "hls_viewers": {...} } }
  let totalRequests = data?.totalRequests;
  let failedRequests = data?.failedRequests;

  // Aggregate workloads if structured by workload
  if (data?.workloads && typeof data.workloads === 'object') {
    let aggTotal = 0;
    let aggFailed = 0;
    let hasWorkloadData = false;
    for (const [, w] of Object.entries(data.workloads)) {
      if (w && typeof w === 'object') {
        const reqs = Number(w.requests ?? w.total ?? 0);
        const fails = Number(w.failed ?? w.errors ?? 0);
        if (Number.isFinite(reqs) && Number.isFinite(fails)) {
          aggTotal += reqs;
          aggFailed += fails;
          hasWorkloadData = true;
        }
      }
    }
    if (hasWorkloadData && (totalRequests === undefined || totalRequests === null)) {
      totalRequests = aggTotal;
      failedRequests = aggFailed;
    }
  }

  if (totalRequests !== undefined && totalRequests !== null) {
    const total = Number(totalRequests);
    const failed = Number(failedRequests ?? 0);
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(failed) || failed < 0) {
      return {
        error: 'INVALID_COUNTS',
        reason: `Request counts (total=${totalRequests}, failed=${failedRequests}) must be non-negative finite numbers`,
      };
    }
    if (failed > total) {
      return {
        error: 'INVALID_COUNTS',
        reason: `Failed requests (${failed}) cannot exceed total requests (${total})`,
      };
    }
    const calculatedRate = total === 0 ? 0.0 : failed / total;
    return { rate: calculatedRate, totalRequests: total, failedRequests: failed };
  }

  // 3. Direct rate field in JSON
  const directRate = data?.rate ?? data?.http_req_failed ?? data?.value;
  if (directRate !== undefined && directRate !== null) {
    const num = Number(directRate);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
      return {
        error: 'INVALID_RATE',
        reason: `Direct rate value '${directRate}' is not a finite number in [0, 1]`,
      };
    }
    return { rate: num };
  }

  return {
    error: 'UNRECOGNIZED_FORMAT',
    reason: 'Telemetry JSON does not contain recognized rate or request counts',
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

  const currentRate = parsed.rate;
  const now = Date.now();

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
export class PlatformWatchdog {
  constructor(config = {}) {
    this.runId =
      config.runId ||
      process.env.RUN_ID ||
      `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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
    this.abortSignalFile =
      config.abortSignalFile || process.env.ABORT_SIGNAL_FILE || '/tmp/lt2_abort.signal';
    this.fetchFn = config.fetchFn || fetchWithWallClockDeadline;
    this.expectedNode = config.expectedNode || process.env.EXPECTED_NODE || 'edge-1';

    this.running = false;
    this.errorRateState = { firstExceededAt: null };
    this.lastLegacyCheckAt = 0;
    this.timer = null;
  }

  /**
   * Triggers auto-abort:
   * - Atomically persists abort payload using mode 0600 private replacement
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

    // 1. Atomic private replacement of abort signal file (mode 0600)
    try {
      const payloadStr = JSON.stringify(abortPayload, null, 2);
      const targetPath = path.resolve(this.abortSignalFile);
      const dir = path.dirname(targetPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Write to unique temp file in same directory for atomic rename
      const tmpFile = path.join(
        dir,
        `.${path.basename(targetPath)}.${this.runId}.${Date.now()}.tmp`,
      );
      fs.writeFileSync(tmpFile, payloadStr, {
        encoding: 'utf8',
        mode: 0o600,
      });

      // Explicit fsync
      try {
        const fd = fs.openSync(tmpFile, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {
        // fsync best effort
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
  async preflight() {
    console.log(`[WATCHDOG] Running preflight telemetry and site verification...`);

    // 1. Mandatory edge-1 RAM telemetry source check
    const ramCheck = await checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn, {
      expectedNode: this.expectedNode,
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

    // 3. Mandatory error rate telemetry source check
    const errCheck = await checkHttpErrorRate(
      this.errorRateSource,
      this.maxErrorRate,
      this.errorSustainedSec,
      this.errorRateState,
      this.fetchFn,
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
   * FAIL-CLOSED: Returns false if ANY check fails or if any telemetry source is missing.
   */
  async runCycle() {
    const now = Date.now();

    // 1. Mandatory Edge-1 RAM check (fail-closed)
    const ramCheck = await checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn, {
      expectedNode: this.expectedNode,
    });
    if (ramCheck.abort) {
      this.triggerAbort(ramCheck.reason, { type: 'EDGE_RAM_EXHAUSTION', metric: ramCheck });
      return false;
    }

    // 2. Mandatory Legacy sites check on explicit 30s schedule (concurrent)
    if (now - this.lastLegacyCheckAt >= this.legacyCheckIntervalMs) {
      this.lastLegacyCheckAt = now;
      const legacyCheck = await checkLegacySites(this.legacySites, 5000, this.fetchFn);
      if (legacyCheck.abort) {
        this.triggerAbort(legacyCheck.reason, {
          type: 'LEGACY_SITE_FAILURE',
          site: legacyCheck.failedSite,
        });
        return false;
      }
      console.log(`[WATCHDOG] Legacy sites check: 4/4 PASS (HTTP 200)`);
    }

    // 3. Mandatory Sustained HTTP error rate check (fail-closed)
    const errCheck = await checkHttpErrorRate(
      this.errorRateSource,
      this.maxErrorRate,
      this.errorSustainedSec,
      this.errorRateState,
      this.fetchFn,
    );
    if (errCheck.abort) {
      this.triggerAbort(errCheck.reason, { type: 'SUSTAINED_HTTP_ERRORS', rate: errCheck.rate });
      return false;
    }

    return true;
  }

  async start() {
    this.running = true;
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
    const preflightOk = await this.preflight();
    if (!preflightOk) {
      process.exit(1);
    }

    const loop = async () => {
      if (!this.running) return;
      const ok = await this.runCycle();
      if (!ok) {
        process.exit(1);
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.checkIntervalMs);
      }
    };

    await loop();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
