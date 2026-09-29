# Roadmap & Task Board

Mỗi task là một GitHub Issue có tiêu đề `[<ID>] <tên>`, ví dụ `[V2] Transcoding pipeline`. Branch đặt tên `agent/<agent>/<id>-<slug>`.
Trạng thái: ✅ xong · 🟡 đang làm · ⏳ chờ phụ thuộc · ⬜ chưa bắt đầu.

## Phases

| Phase | Thời gian | Mục tiêu | Tiêu chí hoàn thành (phần cứng hiện tại) |
|---|---|---|---|
| **P0 Foundation** | Tuần 1 | Contracts, DB, docs, monorepo, dev env, kiểm chứng phần cứng | `make dev` chạy đủ stack local; CI xanh; checklist I0 có kết quả |
| **P1 MVP** | Tuần 2–6 | Đăng ký/đăng nhập, upload → transcode NVENC → xem, trang chủ, cluster k3s thật | Video 10 phút 1080p **READY < 5 phút** (chưa tính thời gian upload); startup < 2s p75 trong nước; sống sót khi tắt 1 VPS hoặc tắt gpu-01 |
| **P2 Beta** | Tuần 7–12 | Comment realtime, like/subscribe, trang kênh, search, RBAC + moderation, observability, video private | Load test **1.000 người xem đồng thời** với rebuffer < 1%; 50 beta user |
| **P3 V1** | Tuần 13–20 | Recommendation v1, analytics, DASH, transcode song song, phụ đề, thumbnail sprite | Public launch; SLO 99.5% (giới hạn bởi hạ tầng tự vận hành) |
| **P4 Scaling** | Tuần 21+ | R2/CDN, AV1 (av1_nvenc), per-title encoding, DRM, thêm worker GPU, multi-region | Theo tải thực tế |

## Task board

### P0
| ID | Task | Owner | Phụ thuộc | Trạng thái |
|---|---|---|---|---|
| F2 | API + event contracts (`contracts/`) | Opus | — | ✅ |
| F4 | Data model + migrations + SQL tests (`db/`) | Opus | — | ✅ |
| DOC | Kiến trúc, hạ tầng, ADR, roadmap, AGENTS.md, prompts | Opus | — | ✅ |
| BOOT | Bootstrap edge-1: Tailscale, firewall, hostname ([runbook](runbooks/edge-1-bootstrap.md)) | Claude (phiên Windows) | — | ✅ |
| I1-e1 | k3s trên edge-1 sau nginx host (ADR-014), `deploy/ansible/` (PR #5; follow-up cho EDGE nằm trong comment review) | Claude (phiên Windows) | BOOT | ✅ |
| SEC0 | edge-1: đóng Cockpit :9090 và :7890 khỏi public (chỉ qua Tailscale); PostgreSQL host chỉ nghe `127.0.0.1`; hardening SSH; thêm `www.winkey.vn` vào DNS + cert | **Bạn** / Antigravity 2 | — | ⬜ |
| TS | Gộp mọi thiết bị về **một tailnet**; xác minh máy nhà 192.168.1.4 là Linux hay Windows và đúng là thiết bị `gpu-01`; áp policy mới §4.2 | **Bạn** | — | ⬜ |
| I0 | Kiểm chứng phần cứng (checklist INFRASTRUCTURE §9; chỉ edge-1 + gpu-01, ADR-013). Đã xong: cùng region, Tailscale direct, PAYG, domain `winkey.vn`. Còn: `uname -m`, uplink, NVENC benchmark; **bạn**: chuyển NS sang Cloudflare, áp policy Tailscale §4.2 | Antigravity 2 + **bạn** | — | 🟡 |
| F1 | Tooling monorepo: pnpm + Turborepo (TS), `go.work` (Go), lint/format, CI build + test + image đa kiến trúc lên GHCR | Antigravity 2 | — | ⬜ |
| F3 | `deploy/compose/dev.yml`: PostgreSQL 17, Valkey, NATS (JetStream), Garage (+ tạo bucket/key/CORS), job migrate; `make dev` | Antigravity 2 | F4 | ⬜ |

### P1 — MVP
| ID | Task | Owner | Phụ thuộc | Độ phức tạp |
|---|---|---|---|---|
| LIB | `libs/go`: config, logger, OTel, outbox relay, problem+json, UUIDv7 | Sonnet 5.5 | F2 | TB · 🟡 review |
| V1 | upload-svc | Sonnet 5.5 | F2, F4, LIB | TB · 🟡 review |
| V2 | transcoder (NVENC + x264, CMAF HLS) | Sonnet 5.5 | V1 | **Cao** · 🟡 review (chờ benchmark NVENC trên gpu-01) |
| V3 | Điều phối job: heartbeat, retry, DLQ, janitor upload bỏ dở | Sonnet 5.5 | V2 | TB · 🟡 review |
| V3b | Reconciler job kẹt: ghi `transcode_jobs.heartbeat_at` mỗi lần `InProgress`; job RUNNING có heartbeat > 10 phút → attempt FAILED, re-enqueue hoặc fail video (migration 000004); pin FFmpeg release + sha256 trong Dockerfile | Sonnet 5.5 | V2 | TB |
| CI-GO | Workflow `go.yml` tạm thời: vet, test `-race` với container (`WINKEY_REQUIRE_DOCKER=1`), cross-build arm64/windows; F1 sẽ thay thế | Opus | — | ✅ |
| S1 | video-svc (feed, watch, studio, delete) | Sonnet 5.5 | V2 | TB |
| A1 | auth-svc (password, Google OAuth, JWT RS256, refresh rotation, `/verify`) | Antigravity 3 | F2, F4 | TB |
| PKG | `packages/api-client` sinh từ OpenAPI (openapi-typescript + openapi-fetch) | Antigravity 1 | F2 | Thấp |
| PKG2 | `packages/outbox` (relay outbox cho service TS) | Antigravity 3 | F2 | Thấp |
| U1 | Web: layout, trang chủ, trang xem SSR, đăng nhập/đăng ký, upload (multipart, resume) | Antigravity 1 | F2 (Prism mock) | TB |
| PL1 | Player: hls.js, ABR, chọn chất lượng, phím tắt, nhớ vị trí, đo QoE | Antigravity 1 | S1 | TB |
| I1 | Ansible: hardening, Tailscale, k3s (edge-1 ✅ qua I1-e1; edge-2/3 sau). gpu-01: worker transcoder ngoài k3s (ADR-015): driver NVIDIA, FFmpeg NVENC, service | Antigravity 2 | I0 | **Cao** |
| STO | Garage cluster ×3, bucket + CORS (`ExposeHeaders: ETag`) + web endpoint | Antigravity 2 | I1 | TB |
| DATA | CloudNativePG + backup, NATS cluster + stream theo `contracts/events/README.md`, Valkey | Antigravity 2 | I1 | **Cao** |
| EDGE | Traefik: routing, forwardAuth, **xóa header định danh trên mọi route**, rate limit; edge-1: nginx host (TLS Certbot, media `proxy_cache`, cấu hình upload s3) theo ADR-014; mở NATS/PG/Garage cho tailnet qua NodePort 30422/30432/30900 trên IP Tailscale (ADR-015) | Antigravity 2 | I1, A1 | **Cao** |
| I2 | Helm chart cho từng service + pipeline deploy (GitOps: Argo CD hoặc Flux) | Antigravity 2 | I1 | TB |
| Q1 | E2E Playwright: đăng ký → upload → READY → xem; k6 smoke | Antigravity 1 | U1, V2, A1 | TB |

### P2 — Beta
| ID | Task | Owner | Phụ thuộc |
|---|---|---|---|
| A2 | RBAC + trang admin/moderation | Antigravity 3 (+ Antigravity 1 UI) | A1 |
| C1 | social-svc: comment 2 cấp (schema `social`), like, subscribe | Antigravity 3 | A1 |
| C2 | realtime-gw: WebSocket, room theo video/user, NATS fan-out | Antigravity 3 | C1 |
| C3 | View counter (Valkey → flush PG), chống view ảo | Sonnet 5.5 | S1 |
| U2 | Creator Studio realtime | Antigravity 1 | C2 |
| SR1 | Search: PG FTS + `unaccent` (tiếng Việt không dấu) + `pg_trgm` | Sonnet 5.5 (+ Opus migration) | S1 |
| I3 | Observability: OTel collector, VictoriaMetrics, Loki, Grafana, dashboard QoE + pipeline, cảnh báo | Antigravity 2 | I2 |
| SEC1 | Video private: signed cookie ở media-cache; WAF/rate limit; hàng đợi moderation | Opus (thiết kế) → Antigravity 2 / Sonnet | EDGE, A2 |

### P3 — V1
| ID | Task | Owner |
|---|---|---|
| R1 | Analytics: heartbeat xem → JetStream → ClickHouse (gpu-01) | Antigravity 2 + Sonnet |
| R2 | Recommendation v1: candidate (trending, co-view, subscription) + ranking; khung A/B | Opus (thiết kế) + Sonnet |
| V4 | Full-GPU pipeline + transcode song song theo chunk + DASH manifest | Opus + Sonnet |
| V5 | Thumbnail sprite, phụ đề WebVTT, auto-caption (Whisper trên GPU) | Sonnet |
| LEGAL | Rà soát nghĩa vụ pháp lý trước khi mở public tại Việt Nam (nền tảng có nội dung do người dùng tạo, ví dụ Nghị định 147/2024/NĐ-CP): đăng ký/giấy phép, xác thực tài khoản, gỡ nội dung vi phạm | **Bạn** (+ tư vấn pháp lý) |
