# Bàn giao vai trò Architect (Claude Opus) — 2026-09-29 12:10 UTC

Tài liệu cho phiên Claude Opus tiếp theo đảm nhận vai trò **CTO / architect / reviewer / người merge** của Winkey.
Đọc hết file này, rồi `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-001…015), `docs/ROADMAP.md`.

## 1. Vai trò và quyền

- Người dùng (luantpbk, nói tiếng Việt, **trả lời bằng tiếng Việt**) đã cấp **toàn quyền**, kể cả **merge PR** sau khi review và CI xanh.
- Bạn sở hữu `contracts/`, `db/`, `docs/`, `.github/workflows/contracts.yml`. Chỉ bạn viết migration và sửa contract.
- Các agent khác không tự merge. Bạn review, comment trên PR (tiếng Việt hoặc Anh, cuối mỗi comment có footer Claude Code), và đưa người dùng một đoạn "chuyển giúp cho <agent>" ngắn gọn. Người dùng là người chuyển lời.
- Người dùng muốn **mỗi agent làm xong hẳn việc hiện tại rồi mới nhận việc mới**.
- Branch làm việc của bạn: mỗi phiên có branch riêng. Các lưu ý:
  - **Không bắt đầu việc mới trên branch trong khi PR của chính branch đó còn mở.** Lỗi này đã xảy ra ở #38.
  - Không force-push. Để đồng bộ branch sau khi merge: `git checkout -B <branch> origin/main && git merge -s ours origin/<branch>`, rồi push thường.
- Bảo mật:
  - không bao giờ dán mật khẩu hay khóa vào chat, PR hoặc repo;
  - agent không dùng sudo trên gpu-01, không đụng miner/ComfyUI;
  - không mở PostgreSQL host (5432) cho tailnet.

## 2. Đội và phạm vi (AGENTS.md)

| Agent | Sở hữu |
|---|---|
| Sonnet 5.5 | `libs/go`, `services/upload`, `services/transcoder`, `services/video` |
| Antigravity 1 | `apps/web`, `e2e/`, `packages/api-client` |
| Antigravity 2 | `deploy/`, `.github/workflows/*` (trừ contracts.yml), file tooling ở root |
| Antigravity 3 | `services/auth`, `services/social`, `services/realtime`, `packages/outbox` |

Khi main bị đỏ do file của agent khác, architect được sửa tối thiểu để gỡ chặn (đã làm ở #18, #20, #31, #38, #44), và ghi rõ trong PR.

## 3. Hạ tầng (thông số thật)

- **edge-1**: VPS Oracle, 138.2.93.173, user `opc`, aarch64, Oracle Linux 9, tailnet 100.113.240.3.
  - k3s nằm sau nginx host (ADR-014, NodePort 30080/30443), TLS bằng Certbot.
  - Máy dùng chung với các site cũ (sblaichau.vn…), trong đó có PostgreSQL host ở cổng 5432, không được đụng.
  - Domain `winkey.vn`, đã có bản ghi www.
- **gpu-01**: máy ở nhà, hostname X9DRL-3F-iF, tailnet 100.88.247.70, LAN 192.168.1.4.
  - Phần cứng: 2× E5-2690, 64 GB RAM, RTX 5060 Ti. Ubuntu 26.04, driver 595.
  - FFmpeg BtbN n7.1.5 đặt ở `/opt/ffmpeg-7.1`, gọi qua `FFMPEG_PATH`.
  - GPU đang dùng chung với miner và ComfyUI. Cấu hình transcoder: `HWACCEL_DECODE=false`, `WORKER_CONCURRENCY=1`. Benchmark ở INFRASTRUCTURE §6: NVENC decode CPU đạt 5.6× realtime.
  - Transcoder chạy ngoài k3s như pull worker (ADR-015), nối tới NATS/PG/Garage qua NodePort 30422/30432/30900, chỉ trên IP Tailscale.
- Việc người dùng tạm hoãn: đóng Cockpit :9090/:7890, renew cert sblaichau.vn, dọn dẹp gpu-01. Còn chờ: bind PostgreSQL host về 127.0.0.1 (đã gửi hướng dẫn).

## 4. Đã merge vào main

- **P0**:
  - Contracts OpenAPI (auth, upload, video, **social**, common) và event schema: video.*, user.registered, **social.***.
  - Migration 000001–000005, trong đó 000005 là schema `social`, kèm SQL test 001–003.
  - Docs và ADR.
  - F1: monorepo pnpm/turbo, CI `ci.yml` và `images.yml` build đa kiến trúc.
  - F3/F3b: `deploy/compose` + `make dev`, workflow `verify-compose` chạy trên PR.
  - Ansible edge-1 (I1-e1).
- **Go (Sonnet)**:
  - LIB (#8), upload-svc V1 (#9), transcoder V2+V3 (#10), V3b reconciler + FFmpeg pin (#19), V3c HWACCEL_DECODE (#33);
  - video-svc S1 (#36);
  - `libs/go/s3x`, client S3 dùng chung (#43).
- **TS**:
  - `packages/outbox` PKG2 (#15);
  - auth-svc A1 (#16) và A1b (#37, package `@winkey/auth`);
  - `packages/api-client` PKG (#21).
- **CI/đặc thù quan trọng**:
  - Turbo chạy strict env, nên `WINKEY_REQUIRE_DOCKER` phải được khai báo trong `turbo.json`. Test container phải **fail**, không được skip, trong CI.
  - `agentGuidance: false` trong turbo.json, vì turbo tự chèn block vào AGENTS.md.
  - Root lint & format chạy trên mọi PR.
  - `packages/api-client` có `lint = check-stale`: mọi thay đổi trong `contracts/openapi` đòi sinh lại types. Agent phải merge main rồi mới chạy `generate`.
  - vitest cần `hookTimeout: 120_000` cho testcontainers.
  - Dockerfile TS build từ root: `pnpm install --frozen-lockfile` rồi `pnpm deploy`.

## 5. Đang mở (lúc bàn giao)

| PR / việc | Agent | Trạng thái | Việc tiếp theo |
|---|---|---|---|
| **#22** U1 web + e2e | Antigravity 1 | Blocker bảo mật đã sửa (xóa mock `/v1` route, refresh qua lock, same-origin `/v1` qua Next rewrite). Còn 2 lỗi eslint (`apps/web/next-env.d.ts` phải gitignore; khối rỗng ở `e2e/tests/winkey.spec.ts:104`) và phải trả lại 2 dòng gốc trong `.prettierignore` (`deploy/ansible/**`, `.github/workflows/contracts.yml`) | Merge khi CI xanh |
| **#39** EDGE (Traefik k3s + nginx edge-1) | Antigravity 2 | 🔴 smoke test whoami trả 404 mà vẫn tính là pass, phải là 200 và header đã bị bỏ. 🔴 rateLimit phải có `sourceCriterion.ipStrategy.depth: 1`. 🟠 thiếu route social (priority 85). 🟠 media.winkey.vn phải gửi đúng Host/bucket cho Garage, chứng minh bằng file thật MISS→HIT. 🟠 merge main + format:check | Chờ push lại kèm output smoke test mới |
| **C1** social-svc | Antigravity 3 | Đang làm theo `docs/prompts/antigravity-3_C1_social.md` | Review theo brief: test PG17+NATS thật, event validate bằng schema, projection `social.videos` từ video.ready/deleted |
| **S2** like_count | Sonnet | Đã giao (comment cuối trên #43) | video-svc tiêu thụ `social.video.like_changed`, gán `like_count` tuyệt đối, invalidate cache |
| Dependabot #23–#30 | — | Chưa xử lý | Để Antigravity 2 gom lại. Lưu ý TypeScript 6, eslint 10, setup-node/setup-go v7 có thể phá CI |

Các routine đã hẹn của phiên cũ sẽ bị hủy khi bàn giao. Phiên mới nên tự đặt check-in hằng giờ cho các PR đang mở.

## 6. Việc còn lại tới hết P1 (critical path)

EDGE (#39) → **STO** (Garage production + bucket/CORS/website alias) → **DATA** (CNPG/NATS/Valkey) → **I2** (Helm + deploy lên edge-1) + transcoder chạy như service trên gpu-01 → **U1/PL1** (player) → **Q1** (e2e đăng ký→upload→READY→xem, k6 smoke). Q1 xanh trên edge-1 là điều kiện đóng P1.

Nợ kỹ thuật và việc nhỏ:
- xóa dòng "#34" trong `services/video/README.md` (Sonnet);
- thêm `social.v1.yaml` vào generator của api-client (Antigravity 1);
- script `lint` cho `packages/outbox` (Antigravity 3);
- giảm dần `any` trong web và outbox.

## 7. Cách review đã dùng (giữ nguyên chuẩn)

- Đọc diff thật và log CI thật, không tin báo cáo của agent. Nhiều lần "đã xanh" hóa ra test đang bị skip, hoặc smoke test coi 404 là pass.
- Với test container: kiểm tra log CI rằng suite **thực sự chạy**, đúng số test và thời gian hợp lý.
- Blocker dán nhãn 🔴, nên sửa 🟠, gợi ý 🟡. Kèm lệnh hoặc bản vá cụ thể.
- Merge bằng squash, truyền `expectedHeadSha`. Sau đó đồng bộ branch của mình.
- Khi đổi contract: nghĩ trước tới các test hoặc bản generated phụ thuộc vào nó (bài học từ #41 → #44 và #21).
