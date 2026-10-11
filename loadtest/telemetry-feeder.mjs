/* global process, console, setInterval, clearInterval */
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

/**
 * Parses a single line of k6 NDJSON export.
 * Returns { metric: string, time: number, isReq: boolean, isFail: boolean } or null.
 */
export function parseNdjsonLine(line) {
  const trimmed = line ? line.trim() : '';
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    const item = JSON.parse(trimmed);
    if (item.type !== 'Point' || !item.metric) return null;

    const time = item.data?.time ? new Date(item.data.time).getTime() : Date.now();
    if (item.metric === 'http_reqs') {
      const isFailedTag =
        (item.data?.tags?.status && parseInt(item.data.tags.status, 10) >= 400) ||
        Boolean(item.data?.tags?.error);
      return { metric: 'http_reqs', time, isReq: true, isFail: isFailedTag };
    }

    if (item.metric === 'http_req_failed') {
      const isFail = Number(item.data?.value) > 0;
      return { metric: 'http_req_failed', time, isReq: false, isFail };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Processes NDJSON string content into { requests, failed } within [nowMs - windowMs, nowMs].
 */
export function processNdjson(content, nowMs = Date.now(), windowMs = 60000) {
  const cutoff = nowMs - windowMs;
  const lines = typeof content === 'string' ? content.split('\n') : [];
  let requests = 0;
  let failed = 0;

  for (const line of lines) {
    const parsed = parseNdjsonLine(line);
    if (!parsed) continue;
    if (parsed.time < cutoff || parsed.time > nowMs + 15000) continue;

    if (parsed.isReq) {
      requests++;
    }
    if (parsed.metric === 'http_req_failed' && parsed.isFail) {
      failed++;
    }
  }

  failed = Math.min(failed, requests);
  return { requests, failed };
}

/**
 * Builds the watchdog-compatible rolling 60s JSON telemetry payload.
 */
export function buildTelemetryPayload(
  apiCounts = { requests: 0, failed: 0 },
  hlsCounts = { requests: 0, failed: 0 },
  nowSec = Math.floor(Date.now() / 1000),
  windowSec = 60,
) {
  const safeApiReq = Math.max(0, Math.floor(Number(apiCounts.requests) || 0));
  const safeApiFail = Math.min(safeApiReq, Math.max(0, Math.floor(Number(apiCounts.failed) || 0)));

  const safeHlsReq = Math.max(0, Math.floor(Number(hlsCounts.requests) || 0));
  const safeHlsFail = Math.min(safeHlsReq, Math.max(0, Math.floor(Number(hlsCounts.failed) || 0)));

  return {
    version: '1.0',
    timestamp: nowSec,
    windowSec,
    workloads: {
      api_mix: {
        requests: safeApiReq,
        failed: safeApiFail,
      },
      hls_viewers: {
        requests: safeHlsReq,
        failed: safeHlsFail,
      },
    },
  };
}

/**
 * Atomically writes the telemetry file using write-to-tmp and fs.renameSync.
 */
export function writeTelemetryFile(outputPath, payload) {
  const absPath = path.resolve(outputPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = path.join(dir, `.telemetry.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, absPath);
}

/**
 * Stateful byte-offset tailer for a single NDJSON log stream.
 */
export class StreamTailer {
  constructor(filePath) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    this.offset = 0;
    this.remainder = '';
    this.points = [];
  }

  poll() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const stats = fs.statSync(this.filePath);
      if (stats.size < this.offset) {
        // File truncated or rotated: reset
        this.offset = 0;
        this.remainder = '';
        this.points = [];
      }
      if (stats.size === this.offset) {
        return;
      }

      const bytesToRead = stats.size - this.offset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, this.offset);
        this.offset += bytesToRead;
      } finally {
        fs.closeSync(fd);
      }

      const chunk = this.remainder + buffer.toString('utf8');
      const lines = chunk.split('\n');
      this.remainder = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseNdjsonLine(line);
        if (parsed) {
          this.points.push(parsed);
        }
      }
    } catch {
      // Ignore transient read errors while file is actively written by Docker
    }
  }

  getCounts(windowMs = 60000, nowMs = Date.now()) {
    const cutoff = nowMs - windowMs;
    // Fast prune: advance an index cursor past points older than window cutoff (O(n) at 1000 VUs)
    let firstValidIdx = 0;
    while (firstValidIdx < this.points.length && this.points[firstValidIdx].time < cutoff) {
      firstValidIdx++;
    }

    if (firstValidIdx > 0) {
      this.points = this.points.slice(firstValidIdx);
    }

    let requests = 0;
    let failed = 0;
    for (const p of this.points) {
      if (p.isReq) {
        requests++;
      }
      if (p.metric === 'http_req_failed' && p.isFail) {
        failed++;
      }
    }

    failed = Math.min(failed, requests);
    return { requests, failed };
  }
}

/**
 * Background Telemetry Feeder daemon.
 */
export class TelemetryFeeder {
  constructor({
    outputPath,
    apiStreamPath,
    hlsStreamPath,
    intervalMs = 10000,
    windowSec = 60,
  } = {}) {
    this.outputPath = outputPath;
    this.apiTailer = new StreamTailer(apiStreamPath);
    this.hlsTailer = new StreamTailer(hlsStreamPath);
    this.intervalMs = intervalMs;
    this.windowSec = windowSec;
    this.timer = null;
    this.pollTimer = null;
  }

  tick() {
    this.apiTailer.poll();
    this.hlsTailer.poll();

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const windowMs = this.windowSec * 1000;

    const apiCounts = this.apiTailer.getCounts(windowMs, nowMs);
    const hlsCounts = this.hlsTailer.getCounts(windowMs, nowMs);

    const payload = buildTelemetryPayload(apiCounts, hlsCounts, nowSec, this.windowSec);
    if (this.outputPath) {
      writeTelemetryFile(this.outputPath, payload);
    }
    return payload;
  }

  start() {
    // Write initial telemetry immediately
    this.tick();

    // Fast poll stream tailers every 500ms so newly arrived k6 points are ingested quickly
    this.pollTimer = setInterval(() => {
      this.apiTailer.poll();
      this.hlsTailer.poll();
    }, 500);

    // Rewrite telemetry atomically on the requested interval (every 10s)
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// CLI runner
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  let outputPath = process.env.TELEMETRY_FILE || '';
  let apiStreamPath = process.env.API_STREAM || '';
  let hlsStreamPath = process.env.HLS_STREAM || '';
  let intervalSec = 10;
  let windowSec = 60;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (arg === '--api-stream' && args[i + 1]) {
      apiStreamPath = args[++i];
    } else if (arg === '--hls-stream' && args[i + 1]) {
      hlsStreamPath = args[++i];
    } else if (arg === '--interval' && args[i + 1]) {
      intervalSec = Number(args[++i]) || 10;
    } else if (arg === '--window' && args[i + 1]) {
      windowSec = Number(args[++i]) || 60;
    }
  }

  if (!outputPath) {
    console.error('ERROR: --output path is required for telemetry-feeder.');
    process.exit(1);
  }

  console.log(`[telemetry-feeder] Starting feeder daemon:`);
  console.log(`  - Output:      ${outputPath}`);
  console.log(`  - API stream:  ${apiStreamPath || '(none)'}`);
  console.log(`  - HLS stream:  ${hlsStreamPath || '(none)'}`);
  console.log(`  - Interval:    ${intervalSec}s`);
  console.log(`  - Window:      ${windowSec}s`);

  const feeder = new TelemetryFeeder({
    outputPath,
    apiStreamPath,
    hlsStreamPath,
    intervalMs: intervalSec * 1000,
    windowSec,
  });

  const cleanup = () => {
    feeder.stop();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  feeder.start();
}
