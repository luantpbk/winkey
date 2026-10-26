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

## Simulated Users Pipeline (`--sim`, ADR-038)

SIM1 runs full product journeys with simulated personas against the real frontend and backend microservices (no MSW mocks).

### Running Simulated Users

```bash
# Full reset, seed, personas & load profile:
./systest/run.sh --sim --reset

# Fast run on existing stack:
./systest/run.sh --sim
```

- **Runtime Duration**: ~15–20 minutes.
- **Workflow**:
  1. Bootstraps complete stack including real `web-svc` with Traefik routing `/` to Next.js.
  2. Seeds 20 users (`sim_u01`..`sim_u20`), 1 curator (`sim_curator`), 1 moderator (`sim_mod`), 40 clips with diacritics & tags, 4 playlists, 2 series.
  3. Executes Playwright persona journeys:
     - `anon-viewer`: Cinema rows, series, tag SEO (`h1`, canonical, CollectionPage JSON-LD, `robots` index/noindex), 308 redirect for unslugified diacritics, video playback, series episode navigation with private skip, search, sitemap validation.
     - `member`: Invite-only registration, login, "Lưu" (playlist save), page reload cookie-refresh path, clock fast-forward 16m refresh test, concurrent two-tab refresh deduplication via `navigator.locks`, return_to redirect on sign-out, comments and likes.
     - `creator`: UI video upload, Studio metadata/tags edit, "Bộ phim" series creation, video deletion.
     - `moderator`: Report handling, hiding content, owner studio notice, public 404, restoration.
  4. Runs localhost-only k6 concurrency simulation (`hls-viewers` 100 VUs + `api-mix` 20 VUs) generating `perf.json`.
  5. Validates relative performance budget (`systest/perf-budget.mjs`, >20% p95 regression = fail).

### Reading Reports & Artifacts

All run outputs are archived in `systest/.run/report/`:
- `summary.md`: Markdown summary of overall status, persona results, and execution parameters.
- `perf.json`: Endpoint p50/p95 response times, error rates, and rebuffer metrics.
- `playwright-artifacts/`: Traces, videos, and screenshots captured automatically on any test failure.

### Adding a Persona for a New Feature

1. Create a new test file: `systest/personas/<feature>.spec.ts`.
2. Add a new project definition in `systest/playwright.config.ts`.
3. Assert on user-facing visual and interactive outcomes using Playwright matchers (`expect(locator)...`).
4. Read seeded entities dynamically from `systest/.run/seed-manifest.json`.

---

## Unit Testing

Run hermetic unit tests verifying manifest schema validation, relative performance budget math, and localhost guard:

```bash
node --test systest/tests/sim-unit.test.mjs
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

---

## UX1 Phase 0: Automated UI Audit (--ui-audit, ADR-044)

Bộ công cụ tự động hóa kiểm tra giao diện người dùng và khả năng tiếp cận (Accessibility) dựa theo đặc tả **ADR-044**.

### 🎯 Phạm vi & Cơ chế hoạt động
- **Ma trận kiểm thử:** Quét qua **8 viewports** tiêu chuẩn với **4 personas** người dùng khác nhau (`anon`, `member`, `creator`, `admin`).
- **Loại kiểm tra:**
  - Layout: Tràn ngang (`overflow-x`), diện tích cảm ứng < 44×44px (`touch-target`), chữ bị cắt không có ellipsis.
  - Accessibility: Tuân thủ WCAG với `@axe-core/playwright` (`axe-a11y`, critical -> P0, serious -> P1).
  - TV Navigation: Phím Tab/Enter, chỉ báo focus nhìn thấy được, đóng dialog bằng phím Esc (`tv-focus`).
  - Active Mutation: Kiểm tra các phần tử tương tác không phản hồi (`dead-control`), giới hạn 80 elements/trang.
  - Web Vitals: Đo CLS và LCP qua `PerformanceObserver`.
- **Độ an toàn:** Chạy hoàn toàn trên stack giả lập cục bộ với cơ chế denylist bảo vệ tuyệt đối (không bấm xoá, đăng xuất, báo cáo, chặn, nộp upload, đổi mật khẩu).

### 🚀 Lệnh thực thi & Tùy chọn
Thực thi trực tiếp từ thư mục gốc của hệ thống:
```bash
# Chạy UI audit tiêu chuẩn và kiểm tra CI gate
./systest/run.sh --ui-audit

# Chạy kèm đồng bộ kết quả lên GitHub Issues
./systest/run.sh --ui-audit --sync-gh
# Hoặc sử dụng biến môi trường:
SYNC_GH=true ./systest/run.sh --ui-audit
```

### 📂 Quản lý Báo cáo & Đồng bộ GitHub
- **Báo cáo chi tiết:** Lưu trữ tại `systest/ui-audit/report/<date>/report.md` (track trên Git).
- **Artifacts nhị phân:** Các file ảnh chụp màn hình (`.png`, `.jpg`) được loại trừ qua `.gitignore` nhằm tối ưu hóa dung lượng repository.
- **Root-Cause Clustering:** Kết quả vi phạm được tự động nhóm theo nguyên nhân gốc rễ và đồng bộ trực tiếp lên GitHub Issues (nhãn `ux1` + `p0`/`p1`/`p2` giao Antigravity 1, và `backend` cho lỗi thiếu API).

### 🛑 Chính sách CI Gate (ADR-044)
- Kiểm tra tự động số lượng lỗi P0 sau khi quét.
- Nếu **P0 > 0**, runner sẽ thoát với mã **`exit 1`** để ngăn chặn việc merge PR vi phạm tiêu chuẩn ADR-044.

