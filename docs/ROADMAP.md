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
| TS | Gộp mọi thiết bị về **một tailnet**; xác minh máy nhà là thiết bị `gpu-01`; áp policy mới §4.2 | **Bạn** | — | ✅ (gpu-01 = Ubuntu 26.04, 100.88.247.70) |
| V2b-prep | gpu-01: driver ≥ 570, FFmpeg 7.1 NVENC, scratch/archive, Go, SSH LAN | Claude (phiên local) | TS | ✅ |
| I0 | Kiểm chứng phần cứng (checklist INFRASTRUCTURE §9; chỉ edge-1 + gpu-01, ADR-013). Đã xong: cùng region, Tailscale direct, PAYG, domain `winkey.vn`. Đã có: `aarch64`, NVENC benchmark. Còn: uplink nhà; **bạn**: chuyển NS sang Cloudflare, áp policy Tailscale §4.2 | Antigravity 2 + **bạn** | — | 🟡 |
| F1 | Tooling monorepo: pnpm + Turborepo (TS), `go.work` (Go), lint/format, CI build + test + image đa kiến trúc lên GHCR | Antigravity 2 | — | ✅ (#14) |
| F3 | `deploy/compose/dev.yml`: PostgreSQL 17, Valkey, NATS (JetStream), Garage (+ tạo bucket/key/CORS), job migrate; `make dev` | Antigravity 2 | F4 | ✅ (#17) |

### P1 — MVP
| ID | Task | Owner | Phụ thuộc | Độ phức tạp |
|---|---|---|---|---|
| LIB | `libs/go`: config, logger, OTel, outbox relay, problem+json, UUIDv7 | Sonnet 5.5 | F2 | TB · ✅ (#8) |
| V1 | upload-svc | Sonnet 5.5 | F2, F4, LIB | TB · ✅ (#9) |
| V2 | transcoder (NVENC + x264, CMAF HLS) | Sonnet 5.5 | V1 | **Cao** · ✅ (#10); benchmark NVENC thật = V2b |
| V3 | Điều phối job: heartbeat, retry, DLQ, janitor upload bỏ dở | Sonnet 5.5 | V2 | TB · ✅ (#10) |
| V3b | Reconciler job kẹt (heartbeat, re-enqueue/fail qua outbox), pin FFmpeg BtbN n7.1.5 + sha256 cho cả image cpu và nvenc; benchmark GPU thật (V2b) | Sonnet 5.5 | V2 | TB · ✅ (#19) |
| V3c | `HWACCEL_DECODE` (mặc định `true`) nối vào `NoHWDecode`; gpu-01 dùng `HWACCEL_DECODE=false`, `WORKER_CONCURRENCY=1` | Sonnet 5.5 | V3b | Thấp · ✅ (#33) |
| CI-GO | Workflow `go.yml` tạm thời: vet, test `-race` với container (`WINKEY_REQUIRE_DOCKER=1`), cross-build arm64/windows | Opus | — | ✅ (F1 đã thay bằng `ci.yml`) |
| S1 | video-svc (feed, watch, studio, delete) | Sonnet 5.5 | V2 | TB · ✅ (#36) |
| A1 | auth-svc (password, Google OAuth, JWT RS256, refresh rotation, `/verify`) | Antigravity 3 | F2, F4 | TB · ✅ (#16) |
| PKG | `packages/api-client` sinh từ OpenAPI (openapi-typescript + openapi-fetch) | Antigravity 1 | F2 | Thấp |
| PKG2 | `packages/outbox` (relay outbox cho service TS) | Antigravity 3 | F2 | Thấp · ✅ (#15) |
| U1 | Web: layout, trang chủ, trang xem SSR, đăng nhập/đăng ký, upload (multipart, resume) | Antigravity 1 | F2 (Prism mock) | TB |
| PL1 | Player: hls.js, ABR, chọn chất lượng, phím tắt, nhớ vị trí, đo QoE · ✅ (#59) | Antigravity 1 | S1 | TB |
| U3 | Web social: comment 2 cấp, like, subscribe trên trang xem/kênh. [Brief](prompts/antigravity-1_U3_social-ui.md) · ✅ (#69) | Antigravity 1 | C1 ✅, PL1 ✅ | TB |
| I1 | Ansible: hardening, Tailscale, k3s (edge-1 ✅ qua I1-e1; edge-2/3 sau). gpu-01: worker transcoder ngoài k3s (ADR-015): driver NVIDIA, FFmpeg NVENC, service | Antigravity 2 | I0 | **Cao** |
| STO | Garage (1 node RF 1 bây giờ, ×3 RF 2 sau), bucket + CORS (`ExposeHeaders: ETag`) + web endpoint, key theo từng service. [Brief](prompts/antigravity-2_STO_garage.md) · ✅ (#67) | Antigravity 2 | I1, EDGE ✅ | **Cao** |
| DATA | CloudNativePG + backup, NATS cluster + stream theo `contracts/events/README.md`, Valkey. [Brief](prompts/antigravity-2_DATA_k3s.md) · ✅ (#81) | Antigravity 2 | I1 | **Cao** |
| EDGE ✅ (#39) | Traefik: routing, forwardAuth, **xóa header định danh trên mọi route**, rate limit; edge-1: nginx host (TLS Certbot, media `proxy_cache`, cấu hình upload s3) theo ADR-014; mở NATS/PG/Garage cho tailnet qua NodePort 30422/30432/30900 trên IP Tailscale (ADR-015) | Antigravity 2 | I1, A1 | **Cao** |
| I2 | Deploy mọi service lên k3s edge-1: kustomize + Ansible role (như STO/DATA; Helm/GitOps để sau khi có nhiều node), image pin digest, Secrets, route Traefik đầy đủ. [Brief](prompts/antigravity-2_I2_apps.md) · ✅ (#93; bỏ workaround sau #94) | Antigravity 2 | DATA ✅ | TB |
| QA1 | System test toàn stack trên Linux: compose override chạy mọi service + transcoder CPU, 12 kịch bản black-box qua gateway (upload → READY → xem, social, visibility, moderation, search, thu hồi phiên, xóa). [Brief](prompts/antigravity-4_QA1_system-tests.md) · ✅ (#102, 12/12 kịch bản trên arm64) | Antigravity 4 | F3 ✅ |
| Q1 | E2E Playwright: đăng ký → upload → READY → xem; k6 smoke | Antigravity 1 | U1, V2, A1 | TB |

### P2 — Beta
| ID | Task | Owner | Phụ thuộc |
|---|---|---|---|
| A2 | RBAC + moderation backend: `/v1/admin/*` (auth-svc), báo cáo + hàng đợi `/v1/reports`, `/v1/moderation/*` (social-svc). Contract + migration 000006, ADR-016, [brief](prompts/antigravity-3_A2_moderation.md) · ✅ (#72) | Antigravity 3 | A1 ✅, C1 ✅ |
| A3 | auth-svc: tự quản lý tài khoản — sửa tên hiển thị/handle, đặt/đổi mật khẩu (đăng xuất thiết bị khác), xóa tài khoản (ẩn danh hóa, giải phóng email/handle). Contract `updateMe`/`changePassword`/`deleteMe`, [brief](prompts/antigravity-3_A3_account-self-service.md) · ✅ (#80) | Antigravity 3 | A2 ✅ |
| A4 | auth-svc: thu hồi access token ngay (ADR-019): denylist `sid` + mốc thu hồi theo user trong Valkey, `verify` 1 `MGET` fail-open. [Brief](prompts/antigravity-3_A4_session-revocation.md) · ✅ (#92) | Antigravity 3 | A3 ✅ |
| A5 | realtime-gw đóng WebSocket (4401) của user bị thu hồi (ADR-019, phần bổ sung A5), sweep 30 s bằng MGET. [Brief](prompts/antigravity-3_A5_realtime-revocation.md) · ✅ (#108) | Antigravity 3 | A4 ✅ |
| S4 | video-svc: `moderateVideo` + event `video.moderated`, ẩn video HIDDEN với người ngoài. [Brief](prompts/sonnet_S4_video-moderation.md)  · ✅ (#71) | Sonnet 5.5 | S1 ✅ |
| U4 | Web admin/moderation UI (danh sách user, đổi role, khóa, hàng đợi báo cáo, nút báo cáo). [Brief](prompts/antigravity-1_U4_admin-moderation-ui.md) · ✅ (#95) | Antigravity 1 | A2 ✅, S4 ✅ |
| C1 | social-svc: comment 2 cấp (schema `social`), like, subscribe. Contract `social.v1.yaml`, migration 000005, event `social.*`, [brief](prompts/antigravity-3_C1_social.md) · ✅ (#48) | Antigravity 3 | A1 ✅ |
| C2 | realtime-gw: WebSocket, room theo video/user, NATS fan-out. Contract `contracts/realtime/` + `realtime.v1.yaml`, [brief](prompts/antigravity-3_C2_realtime.md) · ✅ (#57) | Antigravity 3 | C1 ✅ |
| C3 | View counter (Valkey → flush PG), chống view ảo. Contract `recordView` trong `video.v1.yaml`, [brief](prompts/sonnet_C3_views.md) · ✅ (#52) | Sonnet 5.5 | S1 ✅ |
| C4 | social-svc biết visibility của video: video `PRIVATE` trả 404 comment/like cho người ngoài. Migration 000009, event `video.visibility_changed`, `video.ready.visibility`. C4-a social-svc (Antigravity 3), C4-b producer (Sonnet, sau V5a). [Brief](prompts/antigravity-3_C4_social-visibility.md) · ✅ (#84, #87) | Antigravity 3 + Sonnet | C1 ✅, SEC1-a ✅ |
| U2 | Creator Studio realtime + like/comment realtime trên trang xem. [Brief](prompts/antigravity-1_U2_studio-realtime.md) | Antigravity 1 | C2 ✅ |
| SR1 | Search: PG FTS + `unaccent` (tiếng Việt không dấu) + `pg_trgm`. Contract `searchVideos`/`suggestSearch`, migration 000007, [brief](prompts/sonnet_SR1_search.md) · ✅ (#75, #78) | Sonnet 5.5 | S1 ✅ |
| LT1 | Bộ load test k6 (người xem HLS mô phỏng player, đo rebuffer; API mix), hiệu chỉnh local 50/200 viewer. LT2 = chạy 1.000 viewer trên edge-1 khi I2 + SEC1-b xong và bạn duyệt giờ chạy. [Brief](prompts/antigravity-4_LT1_load-test.md) | Antigravity 4 | QA1 |
| I3 | Observability: OTel collector, VictoriaMetrics, Loki, Grafana, dashboard QoE + pipeline, cảnh báo | Antigravity 2 | I2 |
| SEC1 | Chặn tải media của video không công khai (ADR-017): SEC1-a video-svc ký URL `/s/{exp}/{sig}/…` + `mediaAccess` (Sonnet); SEC1-b nginx `secure_link` + `auth_request` cache 30 s, route Traefik nội bộ (Antigravity 2, sau I2). [Brief](prompts/sonnet_SEC1_media-access.md) · SEC1-a ✅ (#82) · SEC1-b ✅ (#109) | Opus (thiết kế ✅) → Sonnet / Antigravity 2 | EDGE ✅, A2 ✅, S4 ✅ |

### P3 — V1
| ID | Task | Owner |
|---|---|---|
| R1 | Analytics (ADR-022): player gửi heartbeat QoE/watch time → video-svc → JetStream `ANALYTICS` → analytics-worker → ClickHouse trên gpu-01 (NVMe 512 GB). R1-a video-svc + worker ([Brief](prompts/sonnet_R1_analytics.md)), R1-infra stream/route/deploy gpu-01 ([Brief](prompts/antigravity-2_R1_analytics-infra.md)), player gửi heartbeat U8 ([Brief](prompts/antigravity-1_U8_player-heartbeats.md)) · U8 ✅ (#128) | Opus (thiết kế ✅) → Sonnet + Antigravity 2 |
| R2-a | Feed thịnh hành v1 (ADR-020): view theo giờ trong flush C3, bảng xếp hạng tính lại mỗi 10 phút, `listVideos?sort=trending`, migration 000011. [Brief](prompts/sonnet_R2a_trending.md) · ✅ (#101) | Sonnet |
| R2-b | Feed "Đang theo dõi" (ADR-021): projection `media.subscriptions` từ `social.subscription.changed`, migration 000012 (có backfill), `GET /v1/feed/subscriptions`. [Brief](prompts/sonnet_R2b_subscription-feed.md) · ✅ (#110) | Sonnet |
| N1 | Thông báo trong app (ADR-023): `social.notifications` (migration 000013), 4 loại (video mới của kênh theo dõi, comment, reply, subscriber mới), `listNotifications` / `getUnreadNotificationCount` / `markNotificationsRead`; N1-a social-svc ([Brief](prompts/antigravity-3_N1_notifications.md)), route `/v1/notifications` (Antigravity 2), chuông trên web N1-web ([Brief](prompts/antigravity-1_N1web_notification-bell.md), Antigravity 1) · N1-web ✅ (#132) · N1-a ✅ (#130) | Opus (thiết kế ✅) → Antigravity 3 |
| N2 | Gợi ý thông báo realtime (ADR-023 phần bổ sung): realtime-gw gửi `notification.hint {kind}` vào `user:{id}` từ `social.comment.created` / `social.subscription.changed`; web giãn polling khi socket đang kết nối. N2-a realtime-gw ([Brief](prompts/antigravity-3_N2_notification-hints.md)), N2-web ([Brief](prompts/antigravity-1_N2web_notification-hints.md), Antigravity 1) | Opus (thiết kế ✅) → Antigravity 3 |
| R2 | Recommendation v1 đầy đủ: co-view, theo subscription, ranking; khung A/B (sau R2-a) | Opus (thiết kế) + Sonnet |
| V4 | Full-GPU pipeline + transcode song song theo chunk + DASH manifest | Opus + Sonnet |
| V5a | Storyboard xem trước khi tua: sprite 160×90 + WebVTT `#xywh`, migration 000008, `Playback.storyboard_url`. [Brief](prompts/sonnet_V5a_storyboard.md) · ✅ (#86) | Sonnet |
| V5b | Phụ đề WebVTT do chủ video tải lên (ADR-018): migration 000010, `putSubtitle`/`deleteSubtitle`, `Playback.subtitles`. [Brief](prompts/sonnet_V5b_subtitles.md) · ✅ (#91) | Sonnet |
| V5c | Auto-caption (Whisper trên gpu-01) ghi track `source = AUTO`; chờ quyết định ngân sách GPU (ADR-018) | Opus (thiết kế) + Sonnet |
| LEGAL | Rà soát nghĩa vụ pháp lý trước khi mở public tại Việt Nam (nền tảng có nội dung do người dùng tạo, ví dụ Nghị định 147/2024/NĐ-CP): đăng ký/giấy phép, xác thực tài khoản, gỡ nội dung vi phạm | **Bạn** (+ tư vấn pháp lý) |
