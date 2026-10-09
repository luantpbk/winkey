# Platform Watchdog for Task LT2 (ADR-034)

This directory contains the independent platform safety watchdog helper, rolling error rate telemetry producer, and offline test harness for Winkey's 1,000-viewer load test (Task LT2, ADR-034), maintained by **Antigravity 2** (Platform / DevOps).

---

## 1. Safety Mandate & Watched Conditions (Fail-Closed)

During Task LT2 execution on production, the watchdog runs in the background to safeguard platform stability and existing production workloads. It operates under a strict **fail-closed** policy: any telemetry loss, missing source, stale metric, wrong node label, or threshold breach triggers an immediate auto-abort.

1. **edge-1 Host Available Memory (`MemAvailable < 1 GiB`)**:
   - Monitored source: Verified metrics from `edge-1` (NEVER the generator VM's local memory).
   - Validations:
     - Strict URL & provenance verification: Exporter URLs must strictly target hostname `100.113.240.3` or `edge-1`, port `9100`, and pathname `/metrics`. Substring or deceptive hostnames (e.g., `100.113.240.3:9100.evil.example`) are rejected.
     - VictoriaMetrics vector JSON: If `__name__` is omitted, query provenance from `sourceUrl` (`node_memory_MemAvailable_bytes`) must be verified; otherwise rejected (`MISSING_METRIC_NAME`).
     - Text metrics: Label series without explicit node/instance identity (`{job="generator-01"}`) from unverified endpoints are rejected (`AMBIGUOUS_SERIES`). Non-finite or `NaN` timestamps are rejected (`INVALID_TIMESTAMP`).
     - Freshness: Metric timestamp must be $\le 120\text{s}$ old (rejects stale metrics).
     - Finite value: Value must be a non-negative finite number.
   - Threshold: Available memory falling below `1,073,741,824` bytes (1 GiB) triggers an immediate auto-abort.
2. **Canonical Four Legacy Sites Health Check (Concurrent & Monotonic)**:
   - All four canonical legacy sites are probed concurrently every 30 seconds:
     - `https://kendrickheller.com`
     - `https://cuuhohanam.com`
     - `https://kidzlab.edu.vn`
     - `https://sblaichau.vn`
   - Total wall-clock deadline: 5s spanning connection, headers, and body transfer.
   - Bounded streaming discard: Valid HTTP 200 responses with bodies exceeding 64 KiB (such as `sblaichau.vn` at ~150 KiB) are streamed and discarded up to 10 MB without unbounded memory buffering (`discardBody: true`), ensuring memory safety without false aborts.
   - Any non-200 status code, connection failure, or timeout triggers an immediate auto-abort.
   - Monotonic scheduling: Legacy checks run on an independent monotonic schedule (`scheduleNextLegacy`), preventing latency in RAM or error probes from drifting legacy probe start ticks.
3. **Sustained Load HTTP Errors (> 5% for 60s across BOTH Workloads)**:
   - Strict 60s dual-workload telemetry schema:
     1. `api_mix` (REST API traffic, comment submissions, auth)
     2. `hls_viewers` (HLS playlists and media segment streaming)
   - Evaluates rolling 60s window numerator (failed requests) / denominator (total requests).
   - Window enforcement: Strictly requires `windowSec === 60`. Any other window (e.g. 2s, 3600s) is rejected (`INVALID_WINDOW`).
   - Strict types: Counts must be non-negative integers; coerced strings, booleans, or nulls are rejected (`INVALID_WORKLOAD_COUNTS`).
   - Workload activity check: During active test runs (`!isPreflight`), zero traffic on either workload triggers an immediate abort (`INACTIVE_WORKLOAD`), preventing API traffic from masking missing HLS traffic or vice-versa.
   - Preflight vs active run lifecycle: Preflight mode (`isPreflight: true`) accepts 0 requests to verify reachability and schema readiness prior to generator startup.
   - If failure rate exceeds 5% continuously for $\ge 60$ seconds, an auto-abort is triggered. Transient spikes (< 60s) log warnings but do not abort prematurely.
   - Unscoped PromQL vectors are disallowed (`UNSCOPED_VECTOR_DISALLOWED`) to guarantee strict dual-workload validation.

---

## 2. Read-Only Proof of `edge-1` MemAvailable Sources

The watchdog queries `edge-1` memory via read-only telemetry over the trusted Tailnet without requiring elevated privileges or additional ports:

### Primary Source: VictoriaMetrics API (on `gpu-01:8428`)
```bash
curl -s 'http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Binstance%3D%22100.113.240.3%3A9100%22%7D'
```
Sample response:
```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name": "node_memory_MemAvailable_bytes",
          "instance": "100.113.240.3:9100",
          "job": "kubernetes-pods",
          "namespace": "observability",
          "node": "edge-1",
          "pod": "node-exporter-cz6p4"
        },
        "value": [1791457887, "7481970688"]
      }
    ]
  }
}
```

### Direct Node Exporter Metric (on `edge-1:9100`)
```bash
curl -s http://100.113.240.3:9100/metrics | grep node_memory_MemAvailable_bytes
```
Sample response:
```text
# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.
# TYPE node_memory_MemAvailable_bytes gauge
node_memory_MemAvailable_bytes 7.481970688e+09 1791457887000
```

Both exposition formats are supported by `parseMemAvailable()`.

---

## 3. Rolling 60s HTTP Error Telemetry Format & Producer

### Structured Workload JSON Format
```json
{
  "version": "1.0",
  "timestamp": 1791469200,
  "windowSec": 60,
  "workloads": {
    "api_mix": { "requests": 500, "failed": 15 },
    "hls_viewers": { "requests": 500, "failed": 15 }
  }
}
```

### In-Memory Producer (`RollingErrorRateProducer`)
A lightweight, high-performance sliding window accumulator is provided in `deploy/lt2/watchdog.mjs`:
```javascript
import { RollingErrorRateProducer } from './watchdog.mjs';

const producer = new RollingErrorRateProducer(60);

// Record events during load generation:
producer.recordSuccess('api_mix', 10);
producer.recordFailure('api_mix', 1);
producer.recordSuccess('hls_viewers', 20);

// Periodically generate snapshot or write to telemetry file:
const sample = producer.getSample();
fs.writeFileSync('/tmp/telemetry.json', JSON.stringify(sample));

// Preflight sample (0 requests, schema-valid):
const preflight = producer.getPreflightSample();
```

---

## 4. Proposed Interface & Lifecycle Protocol for Antigravity 4 (`lt2-run.sh`)

Antigravity 4 alone modifies `loadtest/lt2-run.sh`. The platform watchdog exposes a decoupled interface:

### Invocation & Preflight
```bash
export RUN_ID="lt2_$(date +%s)_$$"

# Start watchdog in background:
./deploy/lt2/watchdog.sh \
  --run-id "${RUN_ID}" \
  --pid $$ \
  --abort-file "/tmp/lt2_abort_${RUN_ID}.signal" \
  --metrics-url "http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Binstance%3D%22100.113.240.3%3A9100%22%7D" \
  --error-source "/tmp/lt2_error_telemetry_${RUN_ID}.json" &
WATCHDOG_PID=$!
```

### Environment Variables / CLI Flags
| Parameter | Default Value | Description |
|---|---|---|
| `--run-id` / `RUN_ID` | auto-generated | Unique run identifier for atomic isolation |
| `--pid` / `TARGET_PID` | `(none)` | PID of the test runner process to signal via `SIGINT` on abort |
| `--abort-file` / `ABORT_SIGNAL_FILE` | `/tmp/winkey_lt2_<runId>/abort.signal` | Path where structured abort JSON is atomically replaced (mode 0600) |
| `--metrics-url` / `EDGE_METRICS_URL` | `(none)` | URL for edge-1 Prometheus/VictoriaMetrics metric (fail-closed) |
| `--error-source` / `ERROR_RATE_SOURCE` | `(none)` | URL or local file path for rolling 60s HTTP error telemetry |
| `MIN_MEM_AVAILABLE_BYTES` | `1073741824` (1 GiB) | Edge-1 minimum available memory threshold |
| `LEGACY_SITES` | 4 canonical sites | Comma-separated list of legacy site URLs |
| `LEGACY_CHECK_INTERVAL_MS` | `30000` (30s) | Interval between legacy site checks |
| `MAX_HTTP_ERROR_RATE` | `0.05` (5%) | Maximum allowed HTTP failure rate |
| `ERROR_RATE_SUSTAINED_SEC` | `60` (60s) | Minimum continuous duration before error rate aborts |

### Atomic Abort Sentinel Protocol
Upon detecting any abort condition:
1. Writes unique temp file in same directory with mode `0600` and fsyncs.
2. Atomically renames temp file to `ABORT_SIGNAL_FILE`:
   ```json
   {
     "abort": true,
     "runId": "lt2_1791469200_12345",
     "reason": "Edge-1 MemAvailable (820.0 MiB) fell below required safety threshold (1024.0 MiB)",
     "timestamp": "2026-10-09T02:15:30.123Z",
     "details": { "type": "EDGE_RAM_EXHAUSTION", "metric": { "availBytes": 859832320 } }
   }
   ```
3. Sends `SIGINT` to `TARGET_PID`.
4. Exits with exit code `1`.

### Runner Teardown & Lifecycle Integration
The runner must implement:
1. **Watchdog Death Observation**: Regularly verify `kill -0 ${WATCHDOG_PID}`. If watchdog dies unexpectedly, trigger immediate emergency stop.
2. **Stop & Wait Run-Owned Containers**: Stop specific run containers (`winkey-lt2-api-mix-${RUN_ID}`, `winkey-lt2-hls-${RUN_ID}`) and `docker wait` them.
3. **Drain & Stop Collector**: Send `SIGTERM` to `comment-collector`, allow buffer flush, wait for exit.
4. **Preserve Run Failure Status**: If aborted by watchdog or workload failure, retain non-zero exit status through cleanup.
5. **Execute Cleanup**: Execute `node loadtest/cleanup.mjs` and propagate status.

---

## 5. Hermetic Offline Testing & Verification

Run the test suite offline (runs in ~1 second using Node 22 native test runner):
```bash
node --test deploy/lt2/watchdog.test.mjs
# or via root package.json:
pnpm run test:watchdog
```
All 67 unit and integration tests run purely offline with zero network or container dependencies. Non-loopback network calls are strictly hard-denied at the socket level (`net.Socket.prototype.connect`).
