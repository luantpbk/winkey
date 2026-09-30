# Winkey System Tests (`systest`)

Full-stack black-box system tests for Winkey. Built and maintained by **Antigravity 4** (QA / System-Test Engineer).

This suite builds and launches all application microservices (`auth-svc`, `upload-svc`, `video-svc`, `social-svc`, `realtime-svc`, `transcoder`) alongside dev infrastructure services (`postgres`, `valkey`, `nats`, `garage`, `media-cache`, `traefik`) in Docker Compose, running 12 end-to-end integration scenarios through the API gateway (`http://127.0.0.1:8080`).

---

## Prerequisites

- **Host OS**: Linux with Docker (amd64 or arm64)
- **Docker**: Version ≥ 24.0
- **Docker Compose**: Version ≥ 2.20 (`docker compose` v2)
- **Node.js**: Version ≥ 22.0 LTS (uses native `node:test`, `fetch`, and `WebSocket`)
- **System RAM**: Minimum 8 GB available

---

## How to Run

### Clean Run from Scratch (Recommended)

To reset all Docker containers, clean volumes, generate fresh runtime RSA keys and secrets, build service images, and execute the full test suite:

```bash
./systest/run.sh --reset
```

### Fast Run (Reuses Running Containers)

To run the suite against an already running stack without rebuilding or wiping databases:

```bash
./systest/run.sh
```

---

## Scenarios & Proven Behavior

| Scenario | Name | Description & Verification |
|---|---|---|
| **S1** | Service Health | Checks `/readyz` on all 6 application containers to confirm DB, Valkey, NATS, and S3 connectivity. |
| **S2** | Auth & Gateway Identity | Verifies user registration, login, profile retrieval (`GET /v1/auth/me`), and proves that Traefik strips client-spoofed `X-User-Id` / `X-User-Roles` headers on ingress. |
| **S3** | Multipart Upload & Transcoding | Uploads a 10s 720p test video clip (`lavfi testsrc + sine`) via multipart presigned S3 URLs, completes upload, and polls status until `READY` (must complete in $\le 180$ seconds). |
| **S4** | Realtime Gateway | Issues a single-use WebSocket ticket (`POST /v1/realtime/ticket`), connects via WebSocket, and verifies subscription to `video:{id}` room. |
| **S5** | Viewer Playback | Retrieves watch page metadata (`GET /v1/videos/{id}`), fetches HLS master playlist (`master.m3u8`), variant playlist, and 1 media segment (`.m4s`/`.ts`), and verifies storyboard WebVTT (`.vtt`). |
| **S6** | Social Interactions | Posts top-level comments, replies to comments, likes videos, subscribes to creator channels, and checks comment listing and count updates. |
| **S7** | Visibility & Signed URLs | Changes video visibility to `PRIVATE` and asserts that non-owners get HTTP 404 on video/comments/likes within 10s (C4 event propagation); verifies owner receives signed URLs (`/s/{exp}/{sig}/...`); toggles back to `PUBLIC`. |
| **S8** | Moderation Workflow | Promotes moderator account via DB, reports video (`POST /v1/reports`), hides video (`PUT /v1/videos/{id}/moderation`), resolves case, verifies owner 404 on hidden video comments, and restores visibility. |
| **S9** | Diacritics Search | Queries unaccented Vietnamese search string (`ha noi`) and verifies PostgreSQL FTS finds video titled `"Hà Nội mùa thu"`. |
| **S10** | Session & Suspension | Changes user password, checks token/session revocation status, and verifies admin suspension blocks user login with HTTP 403 (`ACCOUNT_SUSPENDED`). |
| **S11** | Video Deletion | Deletes video (`DELETE /v1/videos/{id}`), asserts 404 across all video/comment endpoints, and verifies media storage cleanup. |
| **S12** | Subtitles Track | Verifies WebVTT subtitle track upload and playback listing (`PUT /v1/videos/{id}/subtitles/vi`). |

---

## Failure Diagnostics & Logs

When any test scenario fails, `run.sh` automatically dumps container logs for all microservices into:

```text
systest/.run/logs/
├── auth-svc.log
├── upload-svc.log
├── video-svc.log
├── social-svc.log
├── realtime-svc.log
├── transcoder.log
├── traefik.log
└── postgres.log
```

Inspect these log files to trace error causes across cross-service event flows.

---

## How to Add a New Test Scenario

1. Open `systest/suite/index.mjs`.
2. Add a new `it('S13: <description>', async () => { ... })` block inside the `describe` suite.
3. Use native Node `fetch()` for HTTP API assertions and `assert` for validation.
4. Record scenario results using `recordResult('S13', '<name>', 'PASSED', durationMs)`.
5. Run `./systest/run.sh` to verify your new scenario.

---

## Known Gaps & Pending Tracking

- **[#103](https://github.com/luantpbk/winkey/issues/103)**: Traefik missing routing rules for `/v1/realtime` WebSocket ticket endpoint (`POST /v1/realtime/ticket`). S4 connects to `realtime-svc` port 8003 directly when not routed via Traefik gateway.
- **[#112](https://github.com/luantpbk/winkey/issues/112)**: Traefik missing routing rules for `/v1/reports`, `/v1/moderation` and `/v1/search`. S8 & S9 fallback to direct service calls (`social-svc` / `video-svc`) when not routed via Traefik gateway.
