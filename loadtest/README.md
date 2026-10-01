# Winkey Load Test Harness (Task LT1)

This directory contains the k6 load testing suite for validating Winkey system performance against the P2 exit criterion (**1,000 concurrent viewers with rebuffering < 1%**).

All load tests are executed using Grafana k6 in Docker (pinned by digest). No k6 installation on the host is required.

- **Docker Image Digest**: `grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603`

---

## Safety Rules & Operational Guidelines

> [!CAUTION]
> **CRITICAL RULE**: NEVER run load tests against `winkey.vn` or production infrastructure without the architect's explicit go-ahead in the PR/issue.

1. **Target Environment**: Local calibration must only target the dev/systest stack (`http://127.0.0.1:8080`).
2. **Ramp-Up Profile**: Always start with 50 VUs, calibrate, monitor container resources (`docker stats`), and ramp up progressively (e.g. 50 → 200 → 500 → 1000). Never start execution abruptly at full load.
3. **Automatic Abort**: If HTTP error rate exceeds **5%**, immediately abort the test run using `Ctrl+C` or `--abort-on-promql-error` / threshold aborts.

---

## 1. Seed Data Preparation

Before running k6 scenarios, populate the target environment with registered users and READY video clips:

```bash
./loadtest/seed.sh
```

This populates `loadtest/seed.json`, `loadtest/videos.json`, and `loadtest/users.json`.

---

## 2. Running Scenarios Locally

### HLS Viewer Simulation (`loadtest/hls-viewers.js`)

Simulates viewer behavior (Adaptive Bitrate streaming, ~10 s buffer maintenance, stall/rebuffer ratio calculation, 20% hot video selection, 10% random seeking).

> [!NOTE]
> A random seek flushes the active playback buffer (`currentBuffer = 0.0`), which counts as a rebuffer event, matching U8 E2E test specifications.

**50 Viewers:**
```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://127.0.0.1:8080 -e VUS=50 -e DURATION=1m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/hls-viewers.js
```

**200 Viewers:**
```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://127.0.0.1:8080 -e VUS=200 -e DURATION=1m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/hls-viewers.js
```

### Browsing API Mix (`loadtest/api-mix.js`)

Simulates background user browsing traffic (70% feed/watch/search reads, 25% social reads, 5% comments & likes writes with authenticated user tokens).

```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://127.0.0.1:8080 -e VUS=20 -e DURATION=1m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/api-mix.js
```

---

## 3. Running Against Target URL

To run against an external test environment (with architect approval):

```bash
docker run --rm --net=host -v $(pwd)/loadtest:/loadtest \
  -e TARGET_URL=http://<target-host>:8080 -e VUS=50 -e DURATION=2m \
  grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603 \
  run /loadtest/hls-viewers.js
```

---

## Performance Thresholds Summary

- **Rebuffer Ratio**: `p(95) < 1%`
- **Startup Time**: `p(75) < 2 s`
- **HTTP Error Rate**: `< 0.5%` (HLS viewers) / `< 1%` (API mix)
