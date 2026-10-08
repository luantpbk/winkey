# Platform Watchdog for Task LT2 (ADR-034)

This directory contains the independent platform watchdog helper and offline test harness for Winkey's 1,000-viewer load test (Task LT2, ADR-034), maintained by **Antigravity 2** (Platform / DevOps).

---

## 1. Safety Mandate & Watched Conditions

During Task LT2 execution on production, the watchdog runs in the background to safeguard platform stability and existing production workloads. It immediately triggers an auto-abort if any of the following safety boundaries are breached:

1. **edge-1 Host Available Memory (`MemAvailable < 1 GiB`)**:
   - Monitored source: Verified metrics from `edge-1` (NEVER the generator VM's local memory).
   - Threshold: Available memory falling below `1,073,741,824` bytes (1 GiB).
2. **Canonical Four Legacy Sites Health Check**:
   - All four canonical legacy sites must respond with `HTTP 200` every 30 seconds:
     - `https://kendrickheller.com`
     - `https://cuuhohanam.com`
     - `https://kidzlab.edu.vn`
     - `https://sblaichau.vn`
   - Any non-200 status code, connection failure, or timeout (> 5s) triggers an immediate auto-abort.
3. **Sustained Load HTTP Errors (> 5% for 60s)**:
   - If the load test HTTP failure rate exceeds 5% continuously for $\ge 60$ seconds, an auto-abort is triggered. Transient spikes (< 60s) log warnings but do not abort prematurely.

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
node_memory_MemAvailable_bytes 7.481970688e+09
```

Both exposition formats are supported by `parseMemAvailable()`.

---

## 3. Proposed Interface for Antigravity 4 (`lt2-run.sh`)

Antigravity 4 alone modifies the `loadtest` runner. The platform watchdog exposes a clean, decoupled Unix interface for invocation and abort notifications:

### Invocation
```bash
# In lt2-run.sh, start watchdog in background:
./deploy/lt2/watchdog.sh \
  --pid $$ \
  --abort-file /tmp/lt2_abort.signal \
  --metrics-url "http://100.88.247.70:8428/api/v1/query?query=node_memory_MemAvailable_bytes%7Binstance%3D%22100.113.240.3%3A9100%22%7D" &
WATCHDOG_PID=$!
```

### Environment Variables / Options
| Parameter | Default Value | Description |
|---|---|---|
| `--pid` / `TARGET_PID` | `(none)` | PID of the test runner process to signal via `SIGINT` on abort |
| `--abort-file` / `ABORT_SIGNAL_FILE` | `/tmp/lt2_abort.signal` | Path where structured abort JSON is written |
| `--metrics-url` / `EDGE_METRICS_URL` | `(none)` | URL for edge-1 Prometheus/VictoriaMetrics metric |
| `MIN_MEM_AVAILABLE_BYTES` | `1073741824` (1 GiB) | Edge-1 minimum available memory threshold |
| `LEGACY_SITES` | 4 canonical sites | Comma-separated list of legacy site URLs |
| `LEGACY_CHECK_INTERVAL_MS` | `30000` (30s) | Interval between legacy site checks |
| `ERROR_RATE_SOURCE` | `(none)` | URL or local file path to poll load HTTP error rate |
| `MAX_HTTP_ERROR_RATE` | `0.05` (5%) | Maximum allowed HTTP failure rate |
| `ERROR_RATE_SUSTAINED_SEC` | `60` (60s) | Minimum continuous duration before error rate aborts |

### Abort Notification Protocol
When any abort condition is met:
1. Writes atomic JSON sentinel file at `ABORT_SIGNAL_FILE`:
   ```json
   {
     "abort": true,
     "reason": "Edge-1 MemAvailable (820.0 MiB) fell below required safety threshold (1024.0 MiB)",
     "timestamp": "2026-10-09T02:15:30.123Z",
     "details": { "type": "EDGE_RAM_EXHAUSTION", "metric": { "availBytes": 859832320 } }
   }
   ```
2. Sends `SIGINT` to `TARGET_PID` to trigger the runner's cleanup trap.
3. Exits with exit code `1`.

### Clean Teardown
On successful test completion:
```bash
if [[ -n "${WATCHDOG_PID:-}" ]]; then
  kill -SIGTERM "${WATCHDOG_PID}" 2>/dev/null || true
  wait "${WATCHDOG_PID}" 2>/dev/null || true
fi
```
The watchdog exits with exit code `0` on `SIGINT` or `SIGTERM`.

---

## 4. Offline Testing & Verification

Run the test suite offline (runs in < 1 second using Node's built-in test runner):
```bash
node --test deploy/lt2/watchdog.test.mjs
```
