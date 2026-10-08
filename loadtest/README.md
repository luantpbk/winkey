# Winkey Load Test Harness (Task LT1 & LT2)

This directory contains the k6 load testing suite for validating Winkey system performance against the P2 exit criterion (**1,000 concurrent viewers with rebuffering < 1%**).

All load tests are executed using Grafana k6 in Docker (pinned by digest). No k6 installation on the host is required.

- **Docker Image Digest**: `grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603`

---

## Safety Rules & Operational Guidelines

> [!CAUTION]
> **CRITICAL RULE**: NEVER run load tests against `winkey.vn` or production infrastructure without the architect's explicit go-ahead in the PR/issue. Load test execution on production is strictly prohibited outside the approved window.

1. **Target Environment**: Local calibration targets dev/systest stack (`http://127.0.0.1:8080`). Production test targets `https://winkey.vn` (on the OCI VM prepared by Antigravity 2).
2. **Ramp-Up Profile**: 50 → 200 → 500 → 1000 viewers (5 min per step), then hold 1000 viewers for 15 minutes.
3. **No Uploads / No Seeding in Production**: In production mode (`https://winkey.vn`), viewers pick from public READY videos (`GET /v1/videos?sort=newest&limit=50`). No video uploads or seed scripts are executed.
4. **No Default Passwords**: `LOADTEST_USER_PASSWORD` is strictly required for production / non-localhost execution. No default passwords allowed.
5. **Legacy Site Watchdog**: Continuous HTTP watchdog polls 4 legacy sites every 30 seconds during execution. If any site fails, immediate auto-abort is triggered.
6. **Automatic Abort**: If HTTP error rate exceeds **5%** for 1 minute, available memory on edge-1 falls below **1 GiB**, or a legacy site fails healthcheck, immediately abort the test run (`Ctrl+C`) and execute immediate data cleanup (`node loadtest/cleanup.mjs`).

---

## 1. Local Calibration (Task LT1)

Before running against production, populate local environment with test clips and users:

```bash
./loadtest/seed.sh
```

### HLS Viewer Simulation (`loadtest/hls-viewers.js`)

Simulates viewer behavior (Adaptive Bitrate streaming, ~10 s buffer maintenance, stall/rebuffer ratio calculation, 20% hot video selection, 10% random seeking).

**50 Viewers:**
```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://127.0.0.1:8080 -e EXECUTOR=constant-vus -e VUS=50 -e DURATION=1m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/hls-viewers.js
```

**200 Viewers:**
```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://127.0.0.1:8080 -e EXECUTOR=constant-vus -e VUS=200 -e DURATION=1m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/hls-viewers.js
```

---

## 2. Task LT2: Production 1,000 Viewers Load Test Procedure

### Execution Constraints & Time Window
- **Approved Time Window**: Strictly between **02:00 – 03:30 AM Vietnam time (UTC+7)** starting the night of **October 9, 2026** (19:00 - 20:30 UTC).
- **Generator Infrastructure**: Executed ONLY from the temporary OCI A1 VM prepared by **Antigravity 2**. Never run from local network or dev hosts.
- **Target URL**: `https://winkey.vn`

### Load Profile & Gate Metrics
- **Ramp Stages**: 50 (5m) → 200 (5m) → 500 (5m) → 1000 (5m) → 1000 (15m).
- **Parallel Browsing**: `api-mix` runs in parallel at 5% of VU count (3 → 10 → 25 → 50 VUs).
- **Pass/Fail Criterion**: Aggregate rebuffer ratio = `sum(stall_ms) / (sum(watch_ms) + sum(stall_ms)) < 1%` (excluding seek stalls).
- **Two Ratios Reported**:
  - `rebuffer_ratio`: Stalls NOT caused by a seek (P2 gate criterion).
  - `rebuffer_ratio_incl_seek`: Informational (includes seek stalls).
- **Thresholds**:
  - `rebuffer_ratio`: Aggregate `< 1%`
  - `http_req_failed`: `< 1%`
  - `startup_time`: `p(75) < 2 s`

### Production Accounts & Teardown Protocol
- Writes (comments, likes) use **at most 5 temporary `lt2_*` accounts** registered using `LT2_INVITE_CODE`.
- Pre-creates `loadtest/lt2_accounts.json` containing only public user metadata (handles and emails; **no passwords or tokens** stored on disk).
- **Teardown & Account Deletion**:
  - Deletes all created comments (`DELETE /v1/comments/{id}`).
  - Re-logs in immediately before account deletion (`POST /v1/auth/login`) to obtain a fresh access token.
  - Calls `DELETE /v1/auth/me` with `{ confirm_handle: handle, password: password }` and asserts HTTP **204** success.
  - Teardown runs automatically on test completion or abort (k6 `teardown()` + standalone `node loadtest/cleanup.mjs`).

### Execution Command
```bash
TARGET_URL=https://winkey.vn LOADTEST_USER_PASSWORD=<secure_pass> LT2_INVITE_CODE=<invite_code> LEGACY_SITES="<site1_url> <site2_url> <site3_url> <site4_url>" ./loadtest/lt2-run.sh
```

### Environment Variables Reference

| Variable | Description | Required / Default |
|---|---|---|
| `TARGET_URL` | Base URL of the Winkey gateway | Default: `https://winkey.vn` |
| `LOADTEST_USER_PASSWORD` | Password used for `lt2_*` temporary accounts | Required for production / non-localhost |
| `LT2_INVITE_CODE` | Registration invite code (if required) | Optional |
| `LEGACY_SITES` | Space-separated URLs of legacy sites monitored by watchdog | Optional |
| `COLLECTOR_PORT` | Port for real-time comment journal collector | Default: `9999` |
| `ALLOW_OUTSIDE_WINDOW` | Set `true` to bypass 02:00–03:30 AM VN window check for local tests | Default: `false` |

---

## 3. Fail-Closed & Data Recovery Architecture

- **Fail-Closed Preseed & Collector**: `preseed.mjs` and `comment-collector.mjs` fail closed (`process.exit(1)`) if account creation or collector health verification fails.
- **Fail-Closed Video Pool**: If no valid video samples exist in `seed.json` or `/v1/videos`, k6 scenarios fail closed immediately.
- **Paginated Comment Discovery with Real Request Timeouts**: `cleanup.mjs` performs automatic comment discovery across target videos using OpenAPI contract author metadata (`author: { id, handle, email }`) and cursor pagination (`next_cursor`). Every fetch call during discovery uses `AbortSignal.timeout` linked to the remaining discovery budget. If discovery fails, returns non-200 (including 404), has an invalid payload/cursor, or exceeds deadline before deletion starts, all accounts and comments are retained for retry recovery without deleting user accounts.
- **Token Renewal Error Handling**: If in-memory token renewal fails in `api-mix.js`, the stale token is cleared (`user.token = null`) to prevent repeated invalid requests and retried safely on subsequent VU iterations.
- **Retention Recovery**: When `cleanup.mjs` encounters deletion errors (HTTP $\neq 204$), unremoved accounts (`lt2_accounts.json`) and comments (`lt2_comments.json`) are retained for retry recovery. `cleanup.mjs` exits with non-zero exit code (`1`) on any failure.
- **Dual Generator Abortion**: `lt2-run.sh` traps `EXIT`, `SIGINT`, `SIGTERM` signals and terminates both `PID_HLS` and `PID_API` containers immediately.

---

## 4. Immediate Abort & Emergency Protocol

If any abort condition is met (HTTP errors > 5%, Edge RAM < 1 GiB, legacy site failure):
1. Stop k6 test immediately (`Ctrl+C` or automatic SIGINT trigger from watchdog).
2. Both k6 containers are terminated automatically by `lt2-run.sh`.
3. Standalone data cleanup script executes:
```bash
TARGET_URL=https://winkey.vn LOADTEST_USER_PASSWORD=<secure_pass> node ./loadtest/cleanup.mjs
```
