# Winkey Load Test Harness (Task LT2 v2, ADR-034)

This directory contains the k6 load testing suite for validating Winkey system performance against the P2 exit criterion (**1,000 concurrent viewers with rebuffering < 1%** and anonymous API reads).

All load tests are executed using Grafana k6 in Docker (pinned by digest): `grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603`.

---

## Safety Rules & Operational Guidelines

> [!CAUTION]
> **CRITICAL RULE**: Production load testing against `winkey.vn` is strictly gated to the 02:00–03:30 Asia/Ho_Chi_Minh window starting night of Oct 12, 2026, AFTER the architect merges the PR.

1. **Viewers & Anonymous Reads Only**: No account creation, no registration, no comments, no likes, no video uploads. Zero state mutation.
2. **Platform Safety Watchdog**: `deploy/lt2/watchdog.sh` monitors edge-1 RAM, HTTP error rates, and the 4 canonical legacy sites (`kendrickheller.com`, `cuuhohanam.com`, `kidzlab.edu.vn`, `sblaichau.vn`). Any safety breach triggers auto-abort.
3. **Telemetry Placeholder Notice**: The `telemetry.json` file written by `lt2-run.sh` in `/tmp` serves as an initial schema-valid placeholder for the platform watchdog error telemetry check.

---

## Running Scenarios Locally

### Offline Test Runner Suite
```bash
PATH="/tmp/node/bin:$PATH" node --test loadtest/runner.test.mjs
```

### Local Dry Run (50 VUs)
```bash
TARGET_URL=http://127.0.0.1:8080 VUS=50 DURATION=1m ./loadtest/lt2-run.sh
```

---

## LT2 v2 on Production

### Execution Steps
1. Ensure PR is merged to `main` by the architect.
2. Coordinate with **Antigravity 2** on the generator VM during the 02:00–03:30 Asia/Ho_Chi_Minh window.
3. Launch runner:
   ```bash
   TARGET_URL=https://winkey.vn ./loadtest/lt2-run.sh
   ```

### Metrics to Capture
1. **k6 Summaries**: `results/lt2-summary.json` containing aggregate `rebuffer_ratio`, `rebuffer_ratio_incl_seek`, and `http_req_failed`.
2. **Grafana `edge-1` Telemetry**:
   - Host CPU / RAM / Network bandwidth usage.
   - Nginx cache hit ratio (`nginx_cache_hit`).
   - Media-origin upstream latency & time (`media_origin_upstream_time`).
   - Cloudflare R2 egress requests & bandwidth.
3. **Canonical 4 Legacy Sites**:
   - `https://kendrickheller.com`
   - `https://cuuhohanam.com`
   - `https://kidzlab.edu.vn`
   - `https://sblaichau.vn`

### PASS Rule
- Aggregate `rebuffer_ratio < 0.01` (1%)
- Aggregate `http_req_failed < 0.01` (1%)
- `passed === true` in `results/lt2-summary.json` (otherwise exit 1).
- Zero watchdog auto-aborts during full 35-minute run.
