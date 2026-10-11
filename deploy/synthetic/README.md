# Production Synthetic Monitoring (MON1)

Production synthetic monitoring for Winkey based on **ADR-038** ("Simulated users before real users").

## Overview

A lightweight, zero-dependency Node 22 synthetic probe runs every 10 minutes (`*/10 * * * *`) via GitHub Actions (`.github/workflows/synthetic.yml`) to continuously monitor core user journeys and production availability without generating artificial views or writes.

- **Cadence:** Every 10 minutes + `workflow_dispatch` manual trigger.
- **Timeout:** 3 minutes workflow timeout, 8 seconds per HTTP request.
- **User-Agent:** `WinkeySynthetic/1.0` (tracked in Nginx access logs).
- **Secrets:** `PROBE_EMAIL` and `PROBE_PASSWORD` configured as GitHub Actions repository secrets and masked with `::add-mask::`.
- **Status:** Verified on production edge-1.

## Checks Performed

| Check | Target | Purpose / Assertions |
|---|---|---|
| `healthz` | `GET /healthz` | Asserts HTTP 200 health probe. |
| `readyz` | `GET /readyz` | Asserts HTTP 200 readiness probe. |
| `home` | `GET /` | Asserts HTTP 200 and presence of cinema catalog markup (`"cinema"`, `initialHeroVideos`, `cinema-`). |
| `watch` | `GET /watch/<id>` | Lists `/v1/videos?limit=5`, picks first public video, verifies HTTP 200, `<script type="application/ld+json">` with `VideoObject`. |
| `hls` | `GET <master.m3u8>` & `<seg_00000.m4s>` | Fetches master playlist from video `playback.hls_url`, resolves first rendition playlist, and fetches the first media segment (HTTP 200). Never sends playback heartbeats or view reporting events (zero view count pollution). |
| `tag` | `GET /tag/<slug>` | Lists `/v1/tags?min_videos=2&limit=1`, fetches tag landing page (HTTP 200), asserts `<link rel="canonical">` and tag link. |
| `sitemap` | `GET /sitemap.xml` | Asserts HTTP 200, valid termination with `</urlset>`, and at least 1 `<url>` entry. |
| `auth` | `login` → `me` → `refresh` → `me` → `logout` | Authenticates as `synthetic_probe`, checks user profile, rotates refresh session cookie `wk_rt`, verifies refreshed token, and logs out. Catches the "Lưu" failure class without writing any persistent data on production. |

## Alert Lifecycle

Managed by `deploy/synthetic/alert-manager.mjs`:
- **Alert Trigger:** Opens or updates a GitHub issue titled `[synthetic] <check> failing` (label: `synthetic`) after **2 consecutive failures** of the same check.
- **Alert Resolution:** Automatically closes the issue after **3 consecutive green runs**.
- **Job Summary:** Outputs a markdown status table with timings for each run into `$GITHUB_STEP_SUMMARY`.

## Credentials & Provisioning

- The `synthetic_probe` user is registered with a dedicated invite code on `edge-1` in `auth-secrets`.
- Credentials are saved on `edge-1` in `/etc/winkey/probe.env` (`chmod 600`) and stored in GitHub repository secrets:
  - `PROBE_EMAIL`: `synthetic_probe@winkey.vn`
  - `PROBE_PASSWORD`: Stored securely in GitHub Actions secrets.
