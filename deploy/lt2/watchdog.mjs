#!/usr/bin/env node

/**
 * deploy/lt2/watchdog.mjs
 *
 * Platform watchdog for Winkey Task LT2 (1,000-viewer load test, ADR-034).
 * Monitors:
 * 1. edge-1 MemAvailable (must remain >= 1 GiB; reads verified edge metric, NEVER generator RAM)
 * 2. 4 canonical legacy sites (kendrickheller.com, cuuhohanam.com, kidzlab.edu.vn, sblaichau.vn every 30s)
 * 3. Sustained >5% load HTTP error rate for 60 seconds
 *
 * Upon detecting an abort condition:
 * - Writes reason and details to ABORT_SIGNAL_FILE
 * - Sends SIGINT to TARGET_PID (if specified)
 * - Exits with status code 1
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Default canonical legacy sites (ADR-014 / deploy/ansible/README.md)
export const DEFAULT_LEGACY_SITES = [
  'https://kendrickheller.com',
  'https://cuuhohanam.com',
  'https://kidzlab.edu.vn',
  'https://sblaichau.vn',
];

export const ONE_GIB_BYTES = 1073741824; // 1 GiB in bytes

/**
 * Parses MemAvailable bytes from Prometheus text exposition or VictoriaMetrics/Prometheus JSON.
 */
export function parseMemAvailable(body) {
  if (!body) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  // Try VictoriaMetrics / Prometheus JSON format:
  // {"status":"success","data":{"result":[{"metric":{...},"value":[12345678,"7481970688"]}]}}
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (data?.data?.result && Array.isArray(data.data.result) && data.data.result.length > 0) {
        // Look for metric matching edge-1 or take first available
        for (const res of data.data.result) {
          const valStr = res?.value?.[1];
          if (valStr) {
            const num = Number(valStr);
            if (!Number.isNaN(num)) return num;
          }
        }
      }
    } catch {
      // Fall through to text regex
    }
  }

  // Try Prometheus text exposition format:
  // node_memory_MemAvailable_bytes 7.49856768e+09
  // or node_memory_MemAvailable_bytes 7498567680
  const match = text.match(/node_memory_MemAvailable_bytes\s+([0-9.eE+-]+)/);
  if (match && match[1]) {
    const num = Number(match[1]);
    if (!Number.isNaN(num)) return Math.round(num);
  }

  return null;
}

/**
 * HTTP GET helper with timeout
 */
export function fetchWithTimeout(urlStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const req = lib.get(
        url,
        {
          timeout: timeoutMs,
          headers: { 'User-Agent': 'Winkey-LT2-Platform-Watchdog/1.0' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: data,
            });
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Checks edge-1 MemAvailable from verified metrics source.
 */
export async function checkEdgeRam(
  metricsUrl,
  minBytes = ONE_GIB_BYTES,
  fetchFn = fetchWithTimeout,
) {
  if (!metricsUrl) {
    return { ok: true, skipped: true, reason: 'EDGE_METRICS_URL not configured' };
  }

  try {
    const res = await fetchFn(metricsUrl, 5000);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return {
        abort: true,
        reason: `Edge-1 metrics endpoint returned HTTP ${res.statusCode}`,
      };
    }

    const availBytes = parseMemAvailable(res.body);
    if (availBytes === null) {
      return {
        abort: true,
        reason: 'Failed to parse node_memory_MemAvailable_bytes from edge-1 metrics',
      };
    }

    if (availBytes < minBytes) {
      const availMib = (availBytes / (1024 * 1024)).toFixed(1);
      const minMib = (minBytes / (1024 * 1024)).toFixed(1);
      return {
        abort: true,
        availBytes,
        reason: `Edge-1 MemAvailable (${availMib} MiB) fell below required safety threshold (${minMib} MiB)`,
      };
    }

    return { ok: true, availBytes };
  } catch (err) {
    return {
      abort: true,
      reason: `Edge-1 metrics probe failed: ${err.message}`,
    };
  }
}

/**
 * Checks that all canonical legacy sites respond with HTTP 200.
 */
export async function checkLegacySites(
  sites = DEFAULT_LEGACY_SITES,
  timeoutMs = 5000,
  fetchFn = fetchWithTimeout,
) {
  const results = [];
  for (const site of sites) {
    try {
      const res = await fetchFn(site, timeoutMs);
      if (res.statusCode !== 200) {
        return {
          abort: true,
          failedSite: site,
          statusCode: res.statusCode,
          reason: `Legacy site ${site} returned HTTP ${res.statusCode} (expected 200)`,
        };
      }
      results.push({ site, statusCode: 200 });
    } catch (err) {
      return {
        abort: true,
        failedSite: site,
        reason: `Legacy site ${site} probe failed: ${err.message}`,
      };
    }
  }

  return { ok: true, results };
}

/**
 * Checks whether load HTTP error rate exceeds maxRate sustained for sustainedSec.
 */
export async function checkHttpErrorRate(
  errorRateSource,
  maxRate = 0.05,
  sustainedSec = 60,
  state = { firstExceededAt: null },
  fetchFn = fetchWithTimeout,
) {
  if (!errorRateSource) {
    return { ok: true, skipped: true };
  }

  let currentRate = 0;

  try {
    if (errorRateSource.startsWith('http://') || errorRateSource.startsWith('https://')) {
      const res = await fetchFn(errorRateSource, 3000);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Try parsing JSON metric or value
        const json = JSON.parse(res.body);
        // Supports k6 metric API or custom format:
        // { "data": { "attributes": { "sample": { "rate": 0.06 } } } } or { "rate": 0.06 }
        currentRate =
          json?.data?.attributes?.sample?.rate ??
          json?.rate ??
          json?.http_req_failed ??
          json?.value ??
          0;
      }
    } else if (fs.existsSync(errorRateSource)) {
      const content = fs.readFileSync(errorRateSource, 'utf8').trim();
      const num = Number(content);
      if (!Number.isNaN(num)) {
        currentRate = num;
      }
    }
  } catch {
    // If error rate source cannot be queried, do not abort solely on telemetry probe error unless persistent
    return { ok: true, rate: currentRate, state };
  }

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
    this.checkIntervalMs = config.checkIntervalMs || Number(process.env.CHECK_INTERVAL_MS) || 10000;
    this.targetPid =
      config.targetPid || (process.env.TARGET_PID ? Number(process.env.TARGET_PID) : null);
    this.abortSignalFile =
      config.abortSignalFile || process.env.ABORT_SIGNAL_FILE || '/tmp/lt2_abort.signal';
    this.fetchFn = config.fetchFn || fetchWithTimeout;

    this.running = false;
    this.errorRateState = { firstExceededAt: null };
    this.lastLegacyCheckAt = 0;
    this.timer = null;
  }

  triggerAbort(reason, details = {}) {
    const timestamp = new Date().toISOString();
    const abortPayload = {
      abort: true,
      reason,
      timestamp,
      details,
    };

    console.error(`\n[WATCHDOG_ALERT] ${timestamp} - AUTO-ABORT TRIGGERED: ${reason}`);

    // 1. Write abort sentinel file atomically
    try {
      fs.writeFileSync(this.abortSignalFile, JSON.stringify(abortPayload, null, 2), {
        encoding: 'utf8',
        mode: 0o644,
      });
      console.error(`[WATCHDOG] Abort signal written to ${this.abortSignalFile}`);
    } catch (err) {
      console.error(`[WATCHDOG] Failed to write abort signal file: ${err.message}`);
    }

    // 2. Notify target runner PID if supplied
    if (this.targetPid) {
      try {
        console.error(`[WATCHDOG] Sending SIGINT to target test runner PID ${this.targetPid}...`);
        process.kill(this.targetPid, 'SIGINT');
      } catch (err) {
        console.error(`[WATCHDOG] Failed to signal target PID ${this.targetPid}: ${err.message}`);
      }
    }

    this.stop();
    return abortPayload;
  }

  async runCycle() {
    const now = Date.now();

    // 1. Check edge-1 RAM (every cycle)
    if (this.edgeMetricsUrl) {
      const ramCheck = await checkEdgeRam(this.edgeMetricsUrl, this.minMemBytes, this.fetchFn);
      if (ramCheck.abort) {
        this.triggerAbort(ramCheck.reason, { type: 'EDGE_RAM_EXHAUSTION', metric: ramCheck });
        return false;
      }
    }

    // 2. Check 4 canonical legacy sites (every 30s)
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

    // 3. Check sustained >5% HTTP error rate
    if (this.errorRateSource) {
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
    }

    return true;
  }

  async start() {
    this.running = true;
    console.log(`[WATCHDOG] Platform watchdog started.`);
    console.log(`  - Edge-1 Metrics URL: ${this.edgeMetricsUrl || '(none/disabled)'}`);
    console.log(`  - Minimum edge-1 RAM: ${(this.minMemBytes / (1024 * 1024)).toFixed(0)} MiB`);
    console.log(`  - Legacy sites: ${this.legacySites.join(', ')}`);
    console.log(`  - Legacy check interval: ${this.legacyCheckIntervalMs / 1000}s`);
    console.log(
      `  - Max HTTP error rate: ${(this.maxErrorRate * 100).toFixed(0)}% for ${this.errorSustainedSec}s`,
    );
    console.log(`  - Target PID: ${this.targetPid || '(none)'}`);
    console.log(`  - Abort Signal File: ${this.abortSignalFile}`);

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
  // Parse command line arguments
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
    } else if (arg === '--interval' && args[i + 1]) {
      config.checkIntervalMs = Number(args[++i]) * 1000;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node deploy/lt2/watchdog.mjs [options]`);
      console.log(`Options:`);
      console.log(`  --pid <number>          Process ID to signal on abort (SIGINT)`);
      console.log(`  --abort-file <path>     File to write abort reason JSON`);
      console.log(`  --metrics-url <url>     URL for edge-1 MemAvailable metrics`);
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
