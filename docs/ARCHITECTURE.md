# Kiến trúc Winkey

Nền tảng video streaming kiểu YouTube: upload, transcode HLS nhiều độ phân giải, phát qua cache, tài khoản và RBAC, tương tác realtime, gợi ý video.

- Phiên bản hiện tại nhắm tới **quy mô thử nghiệm trên phần cứng tự vận hành** ([INFRASTRUCTURE.md](INFRASTRUCTURE.md)).
- Mọi lựa chọn đều giữ được đường nâng cấp lên cloud ([DECISIONS.md](DECISIONS.md)).

## 1. Sơ đồ triển khai

```
                     Người xem / Creator (trình duyệt)
          HTML + /v1/* API │          │ HLS (.m3u8/.m4s)     │ PUT part (presigned)
                           ▼          ▼                      ▼
        ┌─────────── edge-1 / edge-2 / edge-3 (Oracle, arm64, IP public) ───────────┐
        │  Traefik :443 ── forwardAuth ──► auth-svc                                 │
        │    ├─ <domain>/v1/*        ► auth · upload · video · social · realtime-gw │
        │    ├─ <domain>/*           ► web (Next.js SSR)                            │
        │    ├─ media.<domain>       ► media-cache (nginx, cache local) ─► Garage web│
        │    └─ s3.<domain>          ► Garage S3 API                                │
        │                                                                           │
        │  Garage ×3 (S3, RF2) · NATS JetStream ×3 · PostgreSQL (CNPG P+R) · Valkey │
        └──────────────────────────────▲────────────────────────────────────────────┘
                                       │ Tailscale (WireGuard) — chỉ traffic nội bộ
                                       │ pull job ◄── NATS   ·   push HLS ──► Garage
        ┌──────────────────── gpu-01 (nhà, amd64, không public) ────────────────────┐
        │  transcoder-nvenc ×2 · transcoder-cpu ×1 · raw archive (HDD)              │
        │  VictoriaMetrics · Loki · Grafana · CI runner amd64                       │
        └───────────────────────────────────────────────────────────────────────────┘
```

## 2. Danh mục service

| Service | Ngôn ngữ | Owner | Dữ liệu sở hữu | API / Event | Phase |
|---|---|---|---|---|---|
| `apps/web` | Next.js (App Router) + Tailwind | Antigravity 1 | — | gọi `/v1/*` | P1 |
| `services/auth` | Node.js/TS | Antigravity 3 | schema `auth` | [auth.v1](../contracts/openapi/auth.v1.yaml) · phát `user.registered` | P1 |
| `services/upload` | Go | Sonnet 5.5 | schema `media` (ghi video lúc upload) | [upload.v1](../contracts/openapi/upload.v1.yaml) · phát `video.uploaded` | P1 |
| `services/transcoder` | Go + FFmpeg | Sonnet 5.5 | `media.transcode_jobs`, `video_renditions`; bucket `winkey-media` | nhận `video.uploaded`; phát `video.ready/failed`, `rt.video.*.progress` | P1 |
| `services/video` | Go | Sonnet 5.5 | schema `media` (đọc/sửa metadata) | [video.v1](../contracts/openapi/video.v1.yaml) · phát `video.deleted` | P1 |
| `services/social` | Node.js/TS | Antigravity 3 | schema `social` | comment, like, subscribe | P2 |
| `services/realtime` | Node.js/TS | Antigravity 3 | — | WebSocket; nhận `rt.>` và `video.ready/failed` | P2 |
| `services/reco` | Go/Python | Opus (thiết kế) | ClickHouse/PG | `/v1/feed` | P3 |

## 3. Luồng chính

**Upload → READY**
1. Web gọi `POST /v1/uploads`, upload-svc tạo `media.videos` (`UPLOADING`) và multipart upload trên Garage.
2. Web xin presigned URL theo lô 100 part, rồi `PUT` thẳng lên `s3.<domain>`, tối đa 4 part song song, lưu lại `ETag` của từng part. Có thể resume.
3. `POST …/complete`: upload-svc hoàn tất multipart. Trong **một transaction**, nó set `UPLOADED` và ghi `video.uploaded` vào outbox; relay publish lên JetStream.
4. Transcoder trên gpu-01 kéo job:
   - `UPLOADED→PROCESSING`, tạo `transcode_jobs`.
   - Tải file gốc về NVMe scratch và chép sang archive.
   - `ffprobe`, rồi chạy FFmpeg (NVENC) và phát progress qua core NATS.
   - Upload `v/{id}/a{n}/…` lên Garage.
   - Trong 1 transaction: ghi renditions, set `READY` và `hls_master_key`, ghi `video.ready` vào outbox.
5. realtime-gw đẩy trạng thái tới Studio. Trước khi có realtime-gw (P2), Studio poll `GET /v1/uploads/{id}` mỗi 5s.

**Xem video**
1. Web SSR gọi `GET /v1/videos/{id}` (video-svc, cache Valkey 30s) và render trang có poster.
2. Player (hls.js; Safari dùng HLS native) tải `https://media.<domain>/v/{id}/a{n}/hls/master.m3u8` qua media-cache và tự chọn chất lượng (ABR).
3. **Không service nào nằm trên đường truyền byte video.**

**Xác thực**
1. Đăng nhập trả access token (15 phút, giữ trong bộ nhớ) và cookie refresh `wk_rt` (HttpOnly, SameSite=Strict, xoay vòng mỗi lần dùng).
2. Mỗi `/v1/*` đi qua Traefik forwardAuth tới `/v1/auth/verify`, rồi tới upstream kèm `X-User-Id` / `X-User-Roles`.

## 4. Quy ước chung (bắt buộc với mọi service)

| Hạng mục | Quy ước |
|---|---|
| Contract | `contracts/` là nguồn sự thật. Lệch contract = bug. Đổi contract phải qua architect |
| ID, thời gian, JSON, lỗi, phân trang | Xem ADR-010 |
| Cấu hình | Chỉ qua biến môi trường; không có secret trong repo; mỗi service có `.env.example` |
| Log | JSON một dòng: `ts`, `level`, `msg`, `service`, `trace_id`, `request_id`; không log token, mật khẩu, email |
| Trace/Metric | OpenTelemetry (OTLP) và `/metrics` Prometheus |
| Health | `GET /healthz` (sống) và `GET /readyz` (sẵn sàng: DB/NATS/S3 kết nối được) |
| Shutdown | Bắt SIGTERM, dừng nhận việc mới, hoàn tất trong 30s (transcoder: NAK job đang chạy) |
| Object key | `winkey-raw`: `{owner_id}/{video_id}/source` · `winkey-media`: `v/{video_id}/a{attempt}/hls/…`, `v/{video_id}/a{attempt}/thumb/poster.jpg` |
| Image | Đa kiến trúc (ADR-012), chạy non-root, `readOnlyRootFilesystem` nếu có thể |

## 5. Cấu trúc repo

```
apps/web/                 Next.js                          Antigravity 1
services/auth/            auth-svc (TS)                    Antigravity 3
services/social/          social-svc (TS, P2)              Antigravity 3
services/realtime/        realtime-gw (TS, P2)             Antigravity 3
services/upload/          upload-svc (Go)                  Sonnet 5.5
services/transcoder/      transcoder (Go + FFmpeg)         Sonnet 5.5
services/video/           video-svc (Go)                   Sonnet 5.5
libs/go/                  thư viện Go dùng chung (outbox, httpx, config, obs)   Sonnet 5.5
packages/api-client/      client TS sinh từ OpenAPI        Antigravity 1
packages/outbox/          relay outbox cho service TS      Antigravity 3
contracts/                OpenAPI + event schema           Opus
db/                       migrations + SQL tests           Opus
deploy/                   compose (dev), ansible, k3s/helm, observability        Antigravity 2
.github/workflows/        CI                               Antigravity 2 (contracts.yml: Opus)
docs/                     kiến trúc, ADR, roadmap, prompts Opus
```
