# Bàn giao vai trò Architect — cập nhật 2026-09-29 14:30 UTC

Tài liệu cho phiên model tiếp theo đảm nhận vai trò **CTO / architect / reviewer / người merge** của Winkey.
Thứ tự đọc: file này → **issue #47 (bảng trạng thái sống, luôn mới nhất)** → `AGENTS.md` → `docs/ARCHITECTURE.md` → `docs/DECISIONS.md` (ADR-001…015) → `docs/ROADMAP.md`.

## 1. Vai trò và quyền

- Người dùng (luantpbk, nói tiếng Việt, **trả lời bằng tiếng Việt**) đã cấp **toàn quyền**, kể cả **merge PR** sau khi review và CI xanh.
- Bạn sở hữu `contracts/`, `db/`, `docs/`, `.github/workflows/contracts.yml`. Chỉ bạn viết migration và sửa contract.
- Các agent khác không tự merge. Bạn review, comment trên PR (cuối mỗi comment có footer Claude Code), và đưa người dùng một đoạn **"Chuyển giúp cho <agent>"** ngắn gọn. Người dùng là người chuyển lời.
- Người dùng muốn **mỗi agent làm xong hẳn việc hiện tại rồi mới nhận việc mới**.
- **Quyết định 14:15:** **không** tự chuyển việc của Antigravity 2 cho agent khác (DATA vẫn ở Antigravity 2). Khi việc đang vướng ở Antigravity 2 thì agent khác được nghỉ.
- **Luôn cập nhật issue #47** sau mỗi merge, review hay giao việc, để phiên sau không bị đứt mạch.
- Branch làm việc:
  - **Không bắt đầu việc mới trên branch trong khi PR của chính branch đó còn mở.**
  - Không force-push. Để đồng bộ sau khi merge: `git checkout -B <branch> origin/main && git merge -s ours origin/<branch>`, rồi push thường.
- Không push được lên branch của agent khác (hệ thống chặn). Muốn sửa gì thì comment bản vá trên PR, hoặc mở PR gỡ chặn riêng từ branch của mình.
- Bảo mật:
  - không dán mật khẩu hay khóa vào chat, PR hoặc repo;
  - agent không dùng sudo trên gpu-01, không đụng miner/ComfyUI;
  - không mở PostgreSQL host (5432) cho tailnet.

## 2. Đội và phạm vi (AGENTS.md)

| Agent | Sở hữu | Hiện tại |
|---|---|---|
| Sonnet 5.5 | `libs/go`, `services/upload`, `services/transcoder`, `services/video` | **Tạm nghỉ** (xong C3 #52) |
| Antigravity 1 | `apps/web`, `e2e/`, `packages/api-client` | **PL1** player (+ thêm social/realtime vào generator api-client, gọi `recordView`), branch `agent/ag1/pl1-player` |
| Antigravity 2 | `deploy/`, `.github/workflows/*` (trừ contracts.yml), tooling ở root | **#39 EDGE**, sau đó STO → DATA → I2 |
| Antigravity 3 | `services/auth`, `services/social`, `services/realtime`, `packages/outbox` | **C2** realtime-gw (brief `docs/prompts/antigravity-3_C2_realtime.md`), branch `agent/ag3/c2-realtime` |

Khi main bị đỏ do file của agent khác, architect được sửa tối thiểu để gỡ chặn (tiền lệ: #18, #20, #31, #38, #44, #54), và ghi rõ trong PR.

## 3. Hạ tầng (thông số thật)

- **edge-1**: Oracle, 138.2.93.173, user `opc`, aarch64, Oracle Linux 9, tailnet 100.113.240.3. 4 vCPU / 24 GB dùng chung; Winkey giới hạn requests ≤ 2 vCPU / 10 GB. k3s sau nginx host (ADR-014, NodePort 30080/30443), TLS Certbot. PostgreSQL host 5432 của site cũ: không đụng. Domain `winkey.vn` (+ www).
- **gpu-01**: nhà, tailnet 100.88.247.70, LAN 192.168.1.4; 2× E5-2690, 64 GB, RTX 5060 Ti, Ubuntu 26.04, driver 595. FFmpeg ở `/opt/ffmpeg-7.1`. GPU dùng chung với miner/ComfyUI: `HWACCEL_DECODE=false`, `WORKER_CONCURRENCY=1`. Transcoder chạy ngoài k3s (ADR-015), nối NATS/PG/Garage qua NodePort 30422/30432/30900 trên IP Tailscale. Code systemd đã có (V3d #49); **người dùng phải tự chạy các bước root** trong `services/transcoder/deploy/gpu-01/README.md` sau khi DATA lên edge-1.
- Việc người dùng tạm hoãn: đóng Cockpit :9090/:7890, renew cert sblaichau.vn, dọn gpu-01, SSH hardening. Hướng dẫn bind PostgreSQL host về 127.0.0.1 đã gửi.

## 4. Đã merge vào main (tới 14:30)

- **Contracts/DB (architect):**
  - OpenAPI auth, upload, video, social, **realtime** (#50), common;
  - events video.*, user.registered, social.*;
  - **WebSocket protocol `contracts/realtime/`** (#50);
  - **`recordView`** (C3) trong `video.v1.yaml` (#50);
  - migration 000001–000005 (000005 = social).
- **Go (Sonnet):**
  - LIB #8, upload V1 #9, transcoder V2/V3 #10, V3b #19, V3c #33;
  - video-svc S1 #36;
  - s3x #43;
  - **S2 like_count #45**;
  - **V3d systemd gpu-01 #49**;
  - **C3 view counter #52**.
- **TS:**
  - outbox PKG2 #15, **TD1 #51** (bỏ `any`, thêm script lint);
  - auth A1 #16/A1b #37;
  - api-client PKG #21;
  - **social-svc C1 #48**;
  - **web U1 #22**.
- **Infra:** F1 monorepo/CI, F3/F3b compose (#17, #42), Ansible edge-1 I1-e1.
- **Gỡ chặn:** #54 (test s3x sau khi smithy-go 1.28.2 đổi URL bulk-delete). Dependabot Go #26, #28 đã merge.

## 5. Đang mở (lúc bàn giao)

| PR / việc | Agent | Trạng thái | Việc tiếp theo |
|---|---|---|---|
| **#39** EDGE | Antigravity 2 | Head **570d834**, CI xanh. Theo comment của agent, đã xử lý: trustedIPs (HelmChartConfig), smoke test chặt (XFF = IP thật, bắt buộc 429 khi bắn song song, media fail trừ khi `SKIP_MEDIA=1`), `targetPort: http` cho social, route `/v1/realtime` + WebSocket trong nginx. **Chưa có** 🟠 output thật của `deploy/edge/smoke-test.sh` chạy từ máy ngoài edge-1 sau khi apply playbook | Đọc diff 570d834 xác nhận các điểm trên; đòi output smoke test thật; đạt thì merge |
| PL1 | Antigravity 1 | Đang làm, chưa có PR | Review: ngưỡng view `min(30 s, duration/2)`, gọi 1 lần/`playback_id`, api-client `check-stale` xanh |
| C2 | Antigravity 3 | Đang làm, chưa có PR | Review theo brief C2: ticket GETDEL một lần, ajv validate mọi message server, 2 instance cùng nhận event (ephemeral consumer), không lộ progress của owner khác |
| Dependabot #23, #24, #25, #27, #29, #30 | — | Chưa xử lý | Giao Antigravity 2 sau #39. TS6, eslint10, setup-node/go v7 có thể phá CI. **Dependabot Go đổi version cho mọi module qua `go.work`**: chạy đủ job Go trước khi merge |

## 6. Critical path P1

EDGE (#39) → **STO** (Garage + bucket/CORS/web) → **DATA** (brief `docs/prompts/antigravity-2_DATA_k3s.md`) → **I2** (Helm + deploy edge-1; nhớ `HTTP_PORT=3004` cho social) → transcoder trên gpu-01 → PL1 → **Q1** (e2e đăng ký→upload→READY→xem + k6 smoke; cần job CI e2e riêng cho `test:e2e`). Q1 xanh trên edge-1 thì đóng P1. Tất cả EDGE/STO/DATA/I2 là của Antigravity 2.

## 7. Cách review (giữ nguyên chuẩn) và bài học

- Đọc diff thật và log CI thật, không tin báo cáo của agent. Với test container: kiểm tra log rằng suite **thực sự chạy** (thời gian hợp lý, không skip).
- Blocker 🔴, nên sửa 🟠, gợi ý 🟡, kèm lệnh hoặc bản vá cụ thể. Merge squash với `expectedHeadSha` (SHA đủ 40 ký tự), rồi đồng bộ branch.
- Contract đổi: sinh lại types api-client trong cùng PR; kiểm tra contract test của service liên quan (#41→#44, #21, #50).
- Kysely: raw `sql` trong `.where()` **không tự bao ngoặc**; điều kiện OR phải bọc ngoặc (#48).
- `pnpm-lock.yaml` conflict: lấy bản của main rồi `pnpm install`, không giải tay (#22).
- Turbo `test` không được chạy Playwright/e2e (#22 timeout).
- Job CI Go/TS chỉ chạy khi thư mục đổi, nên main có thể đỏ ngầm (#54). Khi merge dependabot, chạy đủ mọi job.
- Race detector: helper test dùng chung (contract `Spec.Check`) phải an toàn khi gọi song song (#52).
- Log CI dài: proxy chặn tải blob log; dùng subagent đọc log qua MCP `get_job_logs` với `tail_lines` lớn.
- Mỗi lần ngồi lại: đọc #47, liệt kê PR mở, đặt check-in hằng giờ (`send_later`) cho tới khi hết PR mở.
