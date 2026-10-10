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
| SEC0 | edge-1: đóng Cockpit :9090 và :7890 khỏi public (chỉ qua Tailscale); PostgreSQL host chỉ nghe `127.0.0.1`; hardening SSH; thêm `www.winkey.vn` vào DNS + cert | Antigravity 2 (BETA-ops A) + **bạn** (OCI, DNS) | — | ✅ #264 |
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
| A6 | auth-svc: quên mật khẩu + xác minh email (ADR-026): migration 000016 (`email_tokens`, `mail_queue`), `requestPasswordReset`/`resetPassword`/`resendEmailVerification`/`verifyEmail`, gửi mail SMTP qua hàng đợi giao dịch. [Brief](prompts/antigravity-3_A6_password-reset-email-verify.md) · ✅ #167 · gửi mail thật qua Resend trên edge-1 ✅ #189 (2026-10-01) | Antigravity 3 | A4 ✅ |
| A6-web | web: trang quên mật khẩu, đặt lại mật khẩu, xác minh email, banner nhắc xác minh, thông báo `oauth_unavailable` trên /login. [Brief](prompts/antigravity-1_A6web_password-reset-verify-pages.md) · ✅ #179 | Antigravity 1 | A6 ✅ |
| UQ1 | upload-svc: hạn mức upload (ADR-027): 3 đang tải, 20 lượt/24 h, 50 GiB/24 h, `429 UPLOAD_QUOTA_EXCEEDED`. [Brief](prompts/sonnet-2_UQ1_upload-quotas.md) · ✅ #161 | Sonnet 2 | — |
| UQ1-b | upload-svc: hạn mức ngày tính từ sổ `media.upload_ledger` chỉ append (ADR-027 phần bổ sung, migration 000017), để xoá rồi upload lại không lách được. [Brief](prompts/sonnet-2_UQ1b_upload-ledger.md) · ✅ #173 | Sonnet 2 | UQ1 |
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
| LT2 | **v2 (ADR-034 bổ sung 2026-10-10): chỉ đo người xem** HLS ẩn danh + API chỉ đọc, không tài khoản/ghi; watchdog `deploy/lt2/` (#279); VM OCI tạm; khung 02:00–03:30 từ đêm 12/10/2026; đạt = rebuffer gộp không tính tua < 1 %, lỗi < 1 %. Điều kiện để mời đợt 2 (> 20 người). [Brief](prompts/antigravity-4_LT2v2_viewers-only.md) · ⬜ (#263 đóng, thay bằng v2) | Antigravity 4 | LT1, #279 |
| I3 | Observability (ADR-029): vmagent + Alloy trên edge-1 → VictoriaMetrics, Loki, Grafana trên gpu-01; dashboard dịch vụ, pipeline, QoE, dữ liệu; cảnh báo email. OTel tracing để sau. [Brief](prompts/antigravity-2_I3_observability.md) · ✅ #214 (follow-up DEP-4: node-exporter edge-1 chỉ nghe IP nội bộ) | Antigravity 2 | I2 |
| INF-R2 | Hạ tầng mở rộng (ADR-032): R2 làm object storage chính (bỏ Garage, `media-origin` sau nginx gate), node gia đình `tag:worker` (node-01 tạm hoãn; gpu-01 làm vault tạm), edge-1 về 2 OCPU / 12 GB. Thứ tự: INF-0 (đo edge-1) → INF-R2a (gồm vault tạm trên gpu-01) → INF-R2b → INF-E1; INF-W1 khi node-01 tham gia; INF-W2 (cụm Garage ở các nhà) khi có ≥ 3 node. Tầng nóng = nginx cache trên edge (phụ lục ADR-032). [Brief](prompts/antigravity-2_INF_r2-workers-edge.md) · ⬜ | Opus (thiết kế ✅) → Antigravity 2 | I3 |
| QOE1 | Điều tra rebuffer ratio 2.6 % (mục tiêu P2 < 1 %): số liệu thật hay do cách đo, phân rã theo phiên/rendition/client/trước-sau R2, cấu hình hls.js; chỉ điều tra, báo cáo thành issue, sửa giao sau. [Brief](prompts/chatgpt_QOE1_rebuffer-investigation.md) · ⬜ | ChatGPT | I3, R1 |
| SEC1 | Chặn tải media của video không công khai (ADR-017): SEC1-a video-svc ký URL `/s/{exp}/{sig}/…` + `mediaAccess` (Sonnet); SEC1-b nginx `secure_link` + `auth_request` cache 30 s, route Traefik nội bộ (Antigravity 2, sau I2). [Brief](prompts/sonnet_SEC1_media-access.md) · SEC1-a ✅ (#82) · SEC1-b ✅ (#109) | Opus (thiết kế ✅) → Sonnet / Antigravity 2 | EDGE ✅, A2 ✅, S4 ✅ |

### P3 — V1
| ID | Task | Owner |
|---|---|---|
| R1 | Analytics (ADR-022): player gửi heartbeat QoE/watch time → video-svc → JetStream `ANALYTICS` → analytics-worker → ClickHouse trên gpu-01 (NVMe 512 GB). R1-a video-svc + worker ([Brief](prompts/sonnet_R1_analytics.md)), R1-infra stream/route/deploy gpu-01 ([Brief](prompts/antigravity-2_R1_analytics-infra.md)), player gửi heartbeat U8 ([Brief](prompts/antigravity-1_U8_player-heartbeats.md)) · U8 ✅ (#128) | Opus (thiết kế ✅) → Sonnet + Antigravity 2 |
| R1-b | Thống kê cho creator (ADR-022 bổ sung R1-b): analytics-worker tổng hợp ClickHouse → `analytics.video_daily` trong PG (migration 000015); `getVideoStats`/`getChannelStats` ở video-svc. [Brief](prompts/sonnet_R1b_creator-stats.md) (Sonnet) · role `analytics_svc` + grant + env gpu-01 (Antigravity 2) · trang thống kê studio (Antigravity 1, brief sau) · ⬜ | Opus (thiết kế ✅) → Sonnet + Antigravity 2 |
| R2-a | Feed thịnh hành v1 (ADR-020): view theo giờ trong flush C3, bảng xếp hạng tính lại mỗi 10 phút, `listVideos?sort=trending`, migration 000011. [Brief](prompts/sonnet_R2a_trending.md) · ✅ (#101) | Sonnet |
| R2-b | Feed "Đang theo dõi" (ADR-021): projection `media.subscriptions` từ `social.subscription.changed`, migration 000012 (có backfill), `GET /v1/feed/subscriptions`. [Brief](prompts/sonnet_R2b_subscription-feed.md) · ✅ (#110) | Sonnet |
| N1 | Thông báo trong app (ADR-023): `social.notifications` (migration 000013), 4 loại (video mới của kênh theo dõi, comment, reply, subscriber mới), `listNotifications` / `getUnreadNotificationCount` / `markNotificationsRead`; N1-a social-svc ([Brief](prompts/antigravity-3_N1_notifications.md)), route `/v1/notifications` (Antigravity 2), chuông trên web N1-web ([Brief](prompts/antigravity-1_N1web_notification-bell.md), Antigravity 1) · N1-web ✅ (#132) · N1-a ✅ (#130) | Opus (thiết kế ✅) → Antigravity 3 |
| N2 | Gợi ý thông báo realtime (ADR-023 phần bổ sung): realtime-gw gửi `notification.hint {kind}` vào `user:{id}` từ `social.comment.created` / `social.subscription.changed`; web giãn polling khi socket đang kết nối. N2-a realtime-gw ([Brief](prompts/antigravity-3_N2_notification-hints.md)), N2-web ([Brief](prompts/antigravity-1_N2web_notification-hints.md), Antigravity 1) · N2 ✅ (#136) · N2-web ✅ (#137) | Opus (thiết kế ✅) → Antigravity 3 |
| PL1 | Danh sách phát + "Xem sau" (ADR-024): `social.playlists`/`playlist_items` (migration 000014), 10 endpoint trong social-svc ([Brief](prompts/antigravity-3_PL1_playlists.md), Antigravity 3), `batchGetVideos` ở video-svc ([Brief](prompts/sonnet_PL1v_batch-get-videos.md), Sonnet, sau R1), UI ([Brief](prompts/antigravity-1_PL1web_playlists.md), Antigravity 1), route `/v1/playlists` + `/v1/me/watch-later` (Antigravity 2) | Opus (thiết kế ✅) → Antigravity 3 + Sonnet + Antigravity 1 |
| R2-c | Video liên quan v1 (ADR-025): `GET /v1/videos/{id}/related`, trộn tương tự tiêu đề + cùng kênh + thịnh hành, cache 5 phút. [Brief](prompts/sonnet_R2c_related-videos.md) (Sonnet), UI cột "Xem tiếp" (Antigravity 1): [brief](prompts/antigravity-1_R2cweb_related-column.md) · backend ✅ #158, web ✅ #192 | Opus (thiết kế ✅) → Sonnet + Antigravity 1 |
| R1-b-web | Trang thống kê studio: `getChannelStats` + `getVideoStats`. [Brief](prompts/antigravity-1_R1bweb_studio-stats.md) · ✅ #169 | Antigravity 1 |
| R2 | Recommendation v1 "Dành cho bạn" (ADR-028): job `reco` trong analytics-worker → `analytics.video_coview`/`viewer_history` (migration 000018); `getRecommendedFeed` ở video-svc; tab trên trang chủ. [Brief backend](prompts/chatgpt_R2_reco-backend.md) (ChatGPT: R2-w, R2-v), [brief web](prompts/antigravity-1_R2web_for-you.md) (Antigravity 1) · ✅ code #210 #213 #209 #219, chờ deploy. A/B + đo theo surface = R2-ab (sau) | Opus (thiết kế ✅) → ChatGPT + Antigravity 1 |
| R2-ab | Đo hiệu quả "Dành cho bạn" (ADR-030): `surface` trong heartbeat, A/B theo hash user (reco/control), ClickHouse `0002_reco_ab` + `reco_ab_daily`, dashboard. [Brief backend](prompts/chatgpt_R2ab_reco-ab-backend.md) (ChatGPT: worker trước, rồi video-svc), [brief web](prompts/antigravity-1_R2abweb_surface.md) (Antigravity 1); Antigravity 2: quyền `grafana_ro` + dashboard + deploy theo thứ tự · 🟡 | Opus (thiết kế ✅) → ChatGPT + Antigravity 1 + Antigravity 2 |
| CIN1 | **Trang chủ phim** `/` (ADR-033 + phần bổ sung 2026-10-07): thiết kế `docs/design/cinema-home/`, `CinemaShell` (thanh trên trong suốt, tab dưới trên mobile), banner trending + xem trước tắt tiếng, các hàng cuộn ngang, hàng biên tập từ `CINEMA_CURATOR_HANDLE`, hộp chi tiết `?v=`; lưới cũ chuyển sang `/kham-pha`. Chỉ web. [Brief](prompts/antigravity-1_CIN1_cinema-page.md) · ✅ #267, deploy #269 | Opus (thiết kế ✅) → Antigravity 1 |
| CIN2 | **Bộ phim + phát theo tập** (ADR-035): `Playlist.is_series` (migration 000019), `listCinemaCatalog`, `listSeriesEpisodes`, `getSeriesEpisode` ở social-svc dựa trên projection `social.videos`, không sửa Go. Briefs: [social](prompts/antigravity-3_CIN2_social-series.md) (Antigravity 3), [web](prompts/antigravity-1_CIN2_web-series.md) (Antigravity 1), [routes + rollout](prompts/antigravity-2_CIN2_routes-and-lt2.md) (Antigravity 2) · ✅ #291 #293, deploy #294 #295 | Opus (thiết kế ✅) → Antigravity 3 + 1 + 2 |
| PL2-web | **Trang Thư viện** `/thu-vien`: quản lý danh sách phát của mình (tạo, badge "Bộ phim", chọn nhiều video của mình để thêm), nối sidebar "Thư viện" và "Danh sách của tôi". Lỗ hổng user phát hiện 2026-10-10. Chỉ web. [Brief](prompts/antigravity-1_PL2_library-page.md) · ⬜ | Antigravity 1 |
| BETA1 | Beta kín bằng mã mời (ADR-034): `REGISTRATION_MODE=invite` + `INVITE_CODES` ở auth-svc, contract `invite_code` (✅ architect). [Brief](prompts/antigravity-3_BETA1_invite-codes.md) · ✅ #265, deploy #268 | Antigravity 3 |
| BETA1-web | Ô mã mời, `?invite=`, ô đồng ý điều khoản, trang `/dieu-khoan` `/quyen-rieng-tu` `/quy-tac-cong-dong` (nguồn `docs/legal/`), chân trang + `FEEDBACK_URL`. Sau CIN1. [Brief](prompts/antigravity-1_BETA1web_invite-legal.md) · ✅ #270, deploy #274 | Antigravity 1 |
| BETA-ops | SEC0 + dọn tài khoản test #249 + deploy BETA1/CIN1/BETA1-web + VM tạo tải LT2 (ADR-034). [Brief](prompts/antigravity-2_BETA-ops_sec0-cleanup-deploy.md) · A ✅ #264 · B ✅ #249/#266 · C1 ✅ #268 · C2 (CIN1) ⏳ · D ⏳ | Antigravity 2 (+ bạn: OCI, DNS www, xác nhận tài khoản giữ lại) |
| V4 | Rút ngắn upload → READY (ADR-031): V4-a đo từng bước (`transcoder_stage_seconds`), V4-b upload segment trong lúc encode + archive song song; V4-c (x264 cho 480p) chỉ khi số đo cho thấy encode là nút thắt; full-GPU/chunk/DASH hoãn (số đo V2b: NVENC bão hoà, NVDEC chậm khi GPU dùng chung). [Brief](prompts/sonnet-2_V4_transcode-latency.md) · V4-a ✅ #236 (Sonnet 2); V4-b chuyển cho ChatGPT ([brief tiếp quản](prompts/chatgpt_V4b_transcoder-takeover.md)) 🟡 | Opus (thiết kế ✅) → Sonnet 2 (tạm dừng) → ChatGPT + Antigravity 2 |
| V5a | Storyboard xem trước khi tua: sprite 160×90 + WebVTT `#xywh`, migration 000008, `Playback.storyboard_url`. [Brief](prompts/sonnet_V5a_storyboard.md) · ✅ (#86) | Sonnet |
| V5a-b | Tạo bù storyboard cho video READY chưa có (video cũ hoặc bước storyboard từng lỗi): CLI `storyboard-backfill` trong transcoder, dùng lại code V5a, an toàn khi chạy lại. [Brief](prompts/sonnet-2_V5ab_storyboard-backfill.md) · ✅ #155 | Sonnet 2 | V5a ✅ |
| V5b | Phụ đề WebVTT do chủ video tải lên (ADR-018): migration 000010, `putSubtitle`/`deleteSubtitle`, `Playback.subtitles`. [Brief](prompts/sonnet_V5b_subtitles.md) · ✅ (#91) | Sonnet |
| V5c | Auto-caption (Whisper trên gpu-01) ghi track `source = AUTO`; chờ quyết định ngân sách GPU (ADR-018) | Opus (thiết kế) + Sonnet |
| LEGAL | Rà soát nghĩa vụ pháp lý trước khi mở public tại Việt Nam (nền tảng có nội dung do người dùng tạo, ví dụ Nghị định 147/2024/NĐ-CP): đăng ký/giấy phép, xác thực tài khoản, gỡ nội dung vi phạm | **Bạn** (+ tư vấn pháp lý) |
