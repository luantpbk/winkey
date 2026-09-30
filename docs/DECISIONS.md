# Architecture Decision Records

Mỗi ADR gồm: bối cảnh → quyết định → hệ quả. Muốn đổi một ADR thì viết ADR mới thay thế nó, không sửa ADR cũ.
Trạng thái: **Accepted**, trừ khi ghi khác.

---

### ADR-001 — Topology: edge trên VPS, compute ở nhà
**Bối cảnh.** Phần cứng gồm 3 VPS Oracle (4C/24G/200G, IP public, egress lớn) và 1 máy ở nhà (32 thread, 64 GB, RTX 5060 Ti, sau NAT, uptime và uplink không đảm bảo).
**Quyết định.**
- VPS giữ toàn bộ **đường phục vụ người dùng và dữ liệu trạng thái**.
- Máy nhà (`gpu-01`) chỉ chạy **batch kéo việc từ queue**, không nhận traffic public.
**Hệ quả.** Máy nhà sập thì site vẫn chạy, chỉ có video mới bị xử lý chậm. Đổi lại phải chuyển HLS từ nhà lên edge qua uplink gia đình.

### ADR-002 — Orchestration: k3s
**Bối cảnh.** Kế hoạch gốc dùng EKS. Ở quy mô thử nghiệm cần thứ gì nhẹ nhưng vẫn dùng lại được Helm/manifest khi lên cloud.
**Quyết định.**
- **k3s**, HA với embedded etcd trên 3 VPS (đã xác nhận cùng region). Mạng qua Tailscale.
- ~~`gpu-01` là agent có taint~~ → thay bằng ADR-015 (transcoder chạy ngoài k3s). Ingress dùng Traefik; trên edge-1 Traefik đứng sau nginx của host (ADR-014).
- Cấu hình node bằng **Ansible**. Terraform chỉ dùng cho DNS/OCI nếu cần.
**Hệ quả.** Chart Helm dùng lại được trên EKS/GKE sau này. Phải xử lý MTU flannel qua Tailscale (xem INFRASTRUCTURE §4).

### ADR-003 — Phân việc bằng pull queue
**Quyết định.**
- Worker trên `gpu-01` **kéo** job từ NATS JetStream (pull consumer, heartbeat `InProgress`). Không có service nào gọi *vào* `gpu-01`.
- Kết quả được ghi thẳng vào Garage/PostgreSQL qua Tailscale.
**Hệ quả.** Không cần mở cổng ở nhà. Tắt/bật máy nhà không mất job. Thêm worker mới chỉ cần chạy thêm pod hoặc máy.

### ADR-004 — Object storage: Garage, chỉ dùng S3 API chuẩn
**Bối cảnh.** Không có AWS S3. MinIO bản community không còn được phát hành bản build chính thức từ 2025. Garage được thiết kế cho cluster nhỏ, phân tán địa lý, node không đồng nhất, và có image arm64.
**Quyết định.**
- **Garage**, 3 node trên VPS, `replication_factor = 2`.
- Code **chỉ dùng tập S3 cơ bản**: Put/Get/Head/Delete/List, Multipart, presigned URL, CORS.
- **Không** dùng bucket notification, versioning hay object lock (Garage không hỗ trợ).
- Endpoint cấu hình qua env, tách `S3_ENDPOINT` (nội bộ) và `S3_PUBLIC_ENDPOINT` (dùng để ký presigned URL).
**Hệ quả.** Có thể chuyển sang R2/B2/S3 chỉ bằng cách đổi cấu hình. Event "upload xong" do upload-svc phát, không dựa vào storage.

### ADR-005 — Phát video: media-cache tự vận hành, không proxy video qua Cloudflare
**Bối cảnh.** Không có CloudFront. Điều khoản CDN của Cloudflare (gói thường) không cho phép phục vụ video tỷ trọng lớn, trừ khi video nằm trên R2/Stream.
**Quyết định.**
- `media.winkey.vn` trỏ DNS round-robin vào 3 VPS (DNS-only).
- Mỗi VPS chạy **nginx `proxy_cache`** trên đĩa local, trước Garage web endpoint.
- Object key có version (`a{attempt}`), nên mọi file đều `Cache-Control: public, max-age=31536000, immutable`.
**Hệ quả.** Chi phí 0 trong hạn mức egress Oracle. Không có PoP toàn cầu, nhưng đủ cho người xem ở Việt Nam và khu vực. Hướng nâng cấp: chuyển origin sang **R2 + Cloudflare CDN**.

### ADR-006 — Transcoding: HLS CMAF, NVENC trước, x264 dự phòng
**Quyết định.**
- Đầu ra là **HLS với segment fMP4 (CMAF)** dài 4s, keyframe mỗi 2s (`-force_key_frames "expr:gte(t,n_forced*2)"`, tắt scene-cut), GOP đóng, cùng một bộ segment dùng được cho DASH sau này.
- Ladder: 1080p 5000k / 720p 2800k / 480p 1400k. Không upscale; tính theo cạnh ngắn để video dọc đúng. Audio AAC-LC 128k 48 kHz stereo; nguồn không có audio thì chèn track im lặng.
- **Encoder mặc định `h264_nvenc`** (`-preset p5 -tune hq -rc vbr -spatial-aq 1 -no-scenecut 1 -forced-idr 1`). Decode bằng `-hwaccel cuda` và copy frame về RAM để filter CPU (rotate, 10-bit→8-bit, scale) luôn chạy đúng.
- **Fallback `libx264`** khi không có GPU, khi `ENCODER=x264`, hoặc khi NVENC lỗi.
- Tối đa **2 job NVENC song song**. Lý do: thông lượng khối NVENC cố định (~12× realtime tổng, đo 2026-09-29), thêm phiên không tăng tốc; giới hạn phiên của GeForce (≥ 10 phiên với driver 595) không phải ràng buộc.
- FFmpeg ghim bản **BtbN `autobuild-2026-07-31-14-10` (n7.1.5-12)**, gọi qua `FFMPEG_PATH`. Bản 7.1 này không có av1_nvenc; AV1 ở P4 sẽ cần FFmpeg 8.x.
- Pipeline full-GPU (`scale_cuda`, zero-copy) để dành cho P3 (task V4).
**Hệ quả.** Nhanh và rẻ. Ở cùng bitrate, chất lượng NVENC thấp hơn x264 `slow` một chút; chấp nhận được ở giai đoạn này.

### ADR-007 — Dữ liệu: một cluster PostgreSQL, mỗi service một schema
**Quyết định.**
- CloudNativePG (1 primary + 1 replica). Schema `auth`, `media`, `social`, …; mỗi service chỉ ghi schema của mình, bằng role DB riêng.
- **Không có FK chéo schema.** Đọc chéo domain chỉ qua **view được cấp quyền** (ví dụ `auth.public_profiles`).
- Chỉ architect sở hữu `db/migrations`.
**Hệ quả.** Vận hành một DB nhưng ranh giới vẫn rõ, sau này tách DB được. Tính nhất quán chéo domain là eventual (qua event).

### ADR-008 — Messaging: NATS JetStream + transactional outbox
**Quyết định.**
- Domain event được ghi vào bảng `<schema>.outbox` trong cùng transaction với thay đổi nghiệp vụ, rồi relay publish lên JetStream với `Nats-Msg-Id = event_id`.
- Event realtime tạm thời (progress) đi qua core NATS.
- Consumer bắt buộc idempotent.
- **Hoãn Kafka**: JetStream đảm nhận cả analytics event cho tới khi vượt năng lực.
**Hệ quả.** Không mất event khi service crash giữa "ghi DB" và "publish". Phải có relay trong mỗi service có outbox (viết 1 lần trong thư viện dùng chung `libs/go/outbox` và `packages/outbox`).

### ADR-009 — Xác thực ở edge: Traefik forwardAuth
**Quyết định.**
- Traefik gọi `auth-svc GET /v1/auth/verify` cho mọi `/v1/*`. auth-svc kiểm tra JWT hoàn toàn trong bộ nhớ và trả `X-User-Id` / `X-User-Roles`.
- **Gateway bắt buộc xóa các header này nếu client tự gửi**, trước khi forwardAuth chạy.
- Service upstream chỉ tin các header này. NetworkPolicy bảo đảm chỉ Traefik gọi được service.
- Web và API **cùng origin** (`/v1/*`), nên refresh cookie dùng được `SameSite=Strict` và không cần CORS cho API.
**Hệ quả.** Service không cần thư viện JWT. Mỗi request tốn thêm 1 hop nội bộ (~1 ms).

### ADR-010 — Quy ước định danh & dữ liệu
**Quyết định.**
- ID là **UUIDv7** do ứng dụng sinh. Thời gian lưu `timestamptz`, truyền dạng RFC 3339 UTC.
- JSON dùng `snake_case`. Lỗi trả RFC 9457 `application/problem+json` có `code`.
- Phân trang bằng cursor mờ (`next_cursor`). Object key không chứa tên file của người dùng.

### ADR-011 — Thu gọn stack cho quy mô thử nghiệm
| Kế hoạch gốc | Thay bằng (hiện tại) | Điều kiện quay lại |
|---|---|---|
| AWS S3 | Garage | Dung lượng > 150 GB → R2/B2 |
| CloudFront | nginx media-cache ×3 | Người xem ngoài châu Á / > 10 TB/tháng → R2 + Cloudflare hoặc Bunny |
| EKS + Terraform | k3s + Ansible | Cần autoscale node |
| Kong | Traefik + forwardAuth | Cần API key/quota theo khách hàng |
| MongoDB (comment) | PostgreSQL (`social` schema) | Comment > ~50M rows hoặc schema thay đổi liên tục |
| Kafka | NATS JetStream | Analytics > ~5k event/s |
| OpenSearch | PostgreSQL FTS + `unaccent` + `pg_trgm` | Cần relevance tuning/facet → Meilisearch |
| Redis | Valkey (tương thích Redis, BSD license) | — |

### ADR-012 — Image đa kiến trúc
**Quyết định.**
- Mọi image build `linux/amd64` + `linux/arm64` (edge là arm64), đẩy lên GHCR.
- `transcoder` có hai biến thể: `-nvenc` (chỉ amd64, base CUDA runtime) và `-cpu` (đa kiến trúc).
- Dependency native phải được kiểm tra trên arm64 trong CI.

### ADR-013 — Giai đoạn phát triển chỉ dùng 1 VPS
**Bối cảnh.** Đang ở giai đoạn phát triển, chưa cần HA; vận hành 3 node tốn công và dễ phân tán sự chú ý.
**Quyết định.**
- Chỉ dùng **edge-1**. Mọi thành phần chạy 1 bản, nhưng cấu hình **giữ nguyên hình dạng đích**, để nâng lên 3 node chỉ là thao tác vận hành, không phải thiết kế lại:
  - k3s khởi tạo bằng `--cluster-init`;
  - manifest giữ anti-affinity dạng `preferred`;
  - stream NATS và CNPG chỉnh số bản sao bằng tham số.
- Garage RF 1 là ngoại lệ: không nâng RF tại chỗ được, nên dữ liệu staging coi như dùng một lần và sẽ migrate bằng rclone.
- Stack dev chung chạy trên gpu-01.
**Hệ quả.** Không có HA. edge-1 sập thì staging sập, nhưng dev trên gpu-01 vẫn chạy. Rủi ro này chấp nhận được cho tới trước P2 (Beta).

### ADR-014 — edge-1: nginx của host đứng trước Traefik
**Bối cảnh.** edge-1 là **máy dùng chung**: nginx trên host đang phục vụ các site cũ (kendrickheller, cuuhohanam, sblaichau, kidzlab) ở cổng 80/443. Nếu để Traefik chiếm 80/443 như ADR-002 dự tính, các site đó sập; điều này đã xảy ra 2 lần khi triển khai I1, tổng khoảng 8 phút.
**Quyết định.**
- Trên edge-1, **nginx của host giữ 80/443** và terminate TLS cho `winkey.vn`, `www.winkey.vn`, `media.winkey.vn`, `s3.winkey.vn`. Cert do **Certbot HTTP-01** trên host cấp. **cert-manager không được triển khai trên edge-1**, để tránh hai hệ thống cert chạy song song.
- nginx proxy tới **Traefik NodePort 30080/30443**, chỉ nghe trên IP Tailscale. Traefik vẫn làm routing và forwardAuth như ADR-009.
- Header chuyển tiếp: nginx **ghi đè** `X-Forwarded-For` bằng `$remote_addr` và đặt `X-Forwarded-Proto: https`.
  - Traefik chỉ tin `X-Forwarded-*` từ `10.42.0.1` và IP Tailscale của node. Hệ quả chấp nhận được: thiết bị admin trong tailnet gọi thẳng `:30080` có thể giả IP client.
  - Vì vậy middleware **xóa `X-User-Id` / `X-User-Roles`** là bắt buộc trên mọi route, không có ngoại lệ.
- `s3.winkey.vn` trong nginx phải có:
  - `client_max_body_size 64m`;
  - `proxy_request_buffering off`;
  - `proxy_read_timeout` / `proxy_send_timeout` ≥ 300s.
- `media.winkey.vn`: **nginx của host làm luôn media-cache** (`proxy_cache` trên đĩa, cho phép Range, tôn trọng `Cache-Control: immutable`). Không cần DaemonSet media-cache trong k3s trên edge-1.
- Mọi thay đổi làm đụng cổng 80/443 hoặc nginx của host phải chạy `ansible --check --diff` trước, đi kèm kế hoạch rollback, và làm trong khung giờ đã báo trước.
**Điều kiện quay lại ADR-002/005** (Traefik giữ 80/443, cert-manager DNS-01, media-cache DaemonSet): các site cũ đã chuyển khỏi edge-1, hoặc Winkey chạy trên edge-2/3 riêng.
**Hệ quả.** Thêm một tầng proxy (nginx → Traefik), độ trễ không đáng kể. Cấu hình phân tán ở hai nơi (nginx host và Traefik) nên cả hai phải nằm trong Ansible.

### ADR-015 — Transcoder chạy ngoài k3s, là worker kéo việc
**Bối cảnh.** Máy nhà có thể chạy Windows (cần xác minh). k3s agent và NVIDIA Container Toolkit không chạy trực tiếp trên Windows. Ngay cả trên Linux, đưa máy nhà vào cluster qua mạng gia đình cũng làm cluster phụ thuộc vào một node kém ổn định.
**Quyết định.**
- **gpu-01 không tham gia k3s.** Transcoder là một **worker độc lập**: một binary Go cộng FFmpeg có NVENC, chạy như systemd service (Linux) hoặc Windows service. Nó chỉ mở kết nối **ra ngoài** qua Tailscale tới NATS, PostgreSQL và Garage trên edge-1. Đây là hệ quả tự nhiên của ADR-003.
- Trên edge-1, NATS, PostgreSQL của Winkey và Garage S3 được mở cho tailnet qua **NodePort cố định chỉ nghe trên IP Tailscale**: **30422** (NATS), **30432** (PostgreSQL Winkey), **30900** (Garage S3). Không bao giờ public. Tailscale ACL cho `tag:gpu` gọi đúng 3 cổng đó.
- **Cổng 5432 của edge-1 là PostgreSQL của host**, chứa dữ liệu các site cũ, và không được mở cho `tag:gpu`. Nếu PostgreSQL host đang nghe trên `0.0.0.0` hoặc trên IP Tailscale, phải giới hạn về `127.0.0.1` (task SEC0).
- Transcoder hỗ trợ cả Linux và Windows. Đường dẫn đi qua `SCRATCH_DIR` / `ARCHIVE_DIR`, không hard-code `/tmp`. FFmpeg được gọi qua đường dẫn cấu hình `FFMPEG_PATH` / `FFPROBE_PATH`.
- Image `transcoder-nvenc` vẫn build cho Linux, để dùng sau này trên máy Linux có GPU.
**Hệ quả.**
- Taint GPU trong k3s, NVIDIA device plugin và KEDA cho transcoder không còn cần trong giai đoạn này; scale bằng `WORKER_CONCURRENCY`.
- Máy nhà tắt/bật thoải mái mà không ảnh hưởng cluster.
- DB credential của transcoder nằm trên máy nhà, nên dùng role `media_svc` riêng với mật khẩu riêng và xoay vòng được.
- ADR-001 và ADR-003 không đổi; phần "gpu-01 là k3s agent" trong ADR-002 bị thay thế.


### ADR-016 — Moderation: mỗi service tự thực thi, social-svc giữ hàng đợi báo cáo
**Bối cảnh.** Task A2 cần: đổi role và khóa tài khoản, cho người dùng báo cáo nội dung, cho moderator xử lý hàng đợi. Dữ liệu cần kiểm soát nằm ở ba schema (`auth`, `media`, `social`), và ADR-007 cấm FK chéo schema.
**Quyết định.**
- Mỗi service tự thực thi hành động trên dữ liệu của mình:
  - auth-svc: role và khóa tài khoản (`/v1/admin/*`), ghi `auth.audit_log` trong cùng transaction;
  - video-svc: ẩn/hiện video (`moderateVideo`), phát event `video.moderated`;
  - social-svc: ẩn/hiện comment (`moderateComment`, đã có từ C1).
- **social-svc giữ báo cáo và hàng đợi** (`social.reports`, `/v1/reports`, `/v1/moderation/*`). Đóng một case chỉ ghi quyết định; hành động thật gọi endpoint của service sở hữu. Không có saga hay lệnh phân tán: giao diện moderator gọi hai request nối tiếp (hành động, rồi đóng case).
- Phân quyền chỉ dựa vào `X-User-Roles` từ gateway (ADR-009). `moderator` xử lý viewer/creator và nội dung; chỉ `admin` đổi role, khóa `moderator` và đọc audit log. Không ai khóa được `admin` hoặc chính mình.
- Role và trạng thái khóa lan tới service khác qua access token, nên **có hiệu lực trong ≤ 15 phút** (TTL access token); ADR-019 rút xuống gần như tức thì. Khóa tài khoản thu hồi mọi refresh token ngay lập tức. Không thêm lần kiểm tra DB vào `verify` (vẫn stateless).
- Video bị ẩn được đối xử như `PRIVATE` với người ngoài; object media không bị xóa. Việc chặn tải media thuộc SEC1, thiết kế ở ADR-017 (URL ký, không dùng cookie).
**Hệ quả.** Không có bảng tổng hợp chung, nên audit của video và comment nằm ở cột `moderated_by/at` của từng bảng thay vì `auth.audit_log`. Người dùng bị khóa vẫn gọi được API tối đa 15 phút. Chấp nhận được ở P2; nếu cần chặn tức thì thì thêm denylist `sid` trong Valkey cho `verify` (việc sau).

### ADR-017 — Chặn tải media của video không công khai (SEC1)
**Bối cảnh.** Media được phục vụ qua `media.winkey.vn` (nginx host → Traefik → Garage web, ADR-014) mà không kiểm tra quyền. Ai biết URL (`/v/{video_id}/a{n}/hls/…`) vẫn tải được HLS của video `PRIVATE`, video bị ẩn (`HIDDEN`, ADR-016) hoặc video của tài khoản bị khóa/xóa. ID là UUIDv7 nên khó đoán, nhưng URL lộ ra (lịch sử trình duyệt, chia sẻ khi còn public) là đủ.
**Quyết định.** Hai đường vào, cả hai do nginx trên host kiểm tra:
- **Đường thường `/v/{video_id}/…`**: nginx gọi `auth_request` tới video-svc `GET /internal/media-access/{video_id}`. video-svc trả `204` khi video `READY` + `PUBLIC` hoặc `UNLISTED` + `moderation_state = VISIBLE` + chủ sở hữu còn trong `auth.public_profiles`; ngược lại trả `403`. nginx cache kết quả **30 giây theo `video_id`**, nên chi phí là 1 truy vấn / video / 30 s, không phải 1 truy vấn / segment. `auth_request` chạy trước khi đọc `proxy_cache`, nên segment đã cache cũng bị chặn ngay khi kết quả hết hạn.
- **Đường ký `/s/{expires}/{sig}/v/{video_id}/…`**: dành cho người được xem video không công khai (chủ sở hữu, moderator, admin). video-svc trả `hls_url`/`thumbnail_url` đã ký trong `Playback`. nginx kiểm bằng `secure_link` (`sig` = base64url không padding của `md5("{expires}/v/{video_id}/ {MEDIA_LINK_SECRET}")`, `expires` = Unix giây, TTL 6 giờ), rồi bỏ tiền tố và phục vụ như đường thường nhưng **không** gọi `auth_request`. Playlist HLS dùng đường dẫn tương đối nên mọi variant/segment tự mang tiền tố ký.
- Không dùng cookie: tránh CORS có credentials cho hls.js và cookie chéo subdomain.
- `MEDIA_LINK_SECRET` (≥ 32 byte ngẫu nhiên) chỉ nằm ở hai nơi: Secret của video-svc và file cấu hình nginx do Ansible sinh (vault / biến môi trường, không vào git).
- Endpoint `/internal/*` của video-svc **không được route public**. nginx gọi nó qua Traefik bằng Host nội bộ `media-auth.internal`, mà mọi vhost public đều ghi đè `Host`, nên client không chạm tới được.
**Hệ quả.**
- Chuyển video sang `PRIVATE` / `HIDDEN` chặn tải media trong ≤ 30 s, không cần xóa hay di chuyển object, không cần purge cache.
- Link ký là **link chia sẻ được trong 6 giờ** (gắn với video, không gắn với người dùng). Chấp nhận được cho người xem có quyền; giảm TTL nếu cần.
- `secure_link` của nginx chỉ hỗ trợ MD5; an toàn đủ dùng vì bí mật đứng cuối chuỗi và có hạn dùng. Nếu cần HMAC thật thì chuyển sang njs (việc sau).
- Video-svc thêm một endpoint nóng; nó phải rẻ (1 truy vấn theo khóa chính, không log từng request ở mức info).

### ADR-018 — Phụ đề WebVTT (V5b), auto-caption tách thành V5c
**Bối cảnh.** Roadmap gộp "phụ đề + auto-caption Whisper trên GPU" vào V5b. Auto-caption cần GPU của gpu-01, mà máy này còn chạy việc khác ngoài Winkey (ADR-015; agent không được đụng tới). Phần phụ đề do chủ video tải lên thì không cần GPU và làm được ngay.
**Quyết định.**
- **V5b = phụ đề do chủ video tải lên.** Mỗi video có tối đa 20 track, mỗi ngôn ngữ một track (BCP 47 rút gọn: `vi`, `en`, `en-US`). Bảng `media.video_subtitles` (migration 000010); `source` = `UPLOAD`, còn `AUTO` để dành cho V5c.
- API `PUT`/`DELETE /v1/videos/{id}/subtitles/{lang}`, chỉ chủ video được gọi. Body JSON `{label, content}` (tối đa 512 KiB). video-svc kiểm tra WebVTT phía server (UTF-8, dòng đầu `WEBVTT`, có ít nhất một cue, timing hợp lệ, end > start), rồi chuẩn hóa (bỏ BOM, xuống dòng kiểu LF) trước khi lưu. File sai → `400` `INVALID_WEBVTT`, kèm số dòng lỗi.
- Object nằm ở `v/{video_id}/subtitles/{lang}-{uuidv7}.vtt`. Mỗi lần tải lên dùng **khóa mới**, nên object không bao giờ bị ghi đè và vẫn cache `immutable` được; object cũ bị xóa sau commit (best effort). Vì nằm dưới `v/{id}/` nên URL ký của SEC1 (ADR-017), `mediaAccess` và janitor khi xóa video tự áp dụng mà không phải sửa gì.
- `Playback.subtitles[]` trả `{lang, label, source, url, updated_at}`; `url` được ký giống `hls_url` khi video không công khai. Không phát event nào, vì không service nào khác cần.
- **V5c (auto-caption)** chưa thiết kế. Trước khi làm cần quyết định ngân sách GPU trên gpu-01 (giờ chạy, VRAM, có dừng các việc khác hay không). Khi đó transcoder hoặc một worker riêng sẽ ghi track `source = AUTO`, dùng lại đúng bảng và URL của V5b.
**Hệ quả.** File `.vtt` được phục vụ từ `media.winkey.vn` với `Content-Type: text/vtt`, trình duyệt không chạy nó như HTML. Khi làm SEC1-b, nginx nên thêm `X-Content-Type-Options: nosniff` cho mọi media. Nội dung cue do người dùng viết: player phải hiển thị bằng text track của trình duyệt hoặc hls.js, không chèn `innerHTML`.

### ADR-019 — Thu hồi access token ngay lập tức (A4)
**Bối cảnh.** ADR-016 chấp nhận rằng khóa tài khoản, đổi role, xóa tài khoản và đăng xuất chỉ có hiệu lực sau tối đa 15 phút (TTL của access token), vì `verify` không lưu trạng thái. Trước khi mở beta cho 50 người dùng, cần một tài khoản bị khóa hoặc bị hạ quyền mất quyền ngay, mà `verify` vẫn phải rẻ.
**Quyết định.**
- auth-svc ghi hai loại khóa vào Valkey, cùng TTL = 900 s + 60 s (TTL access token + độ lệch đồng hồ):
  - `auth:revoked:sid:{sid}` khi một phiên bị thu hồi: logout, phát hiện refresh token bị dùng lại, đổi mật khẩu (các phiên khác);
  - `auth:revoked:user:{user_id}` = Unix giây lúc thu hồi, khi mọi access token hiện có của user phải chết: khóa tài khoản, đổi role, xóa tài khoản. Token có `iat` ≤ giá trị này bị từ chối.
- Khóa được ghi **sau khi transaction DB commit**. Nếu ghi lỗi thì chỉ log cảnh báo và tăng metric, không làm hỏng request, vì refresh token trong DB vẫn là nguồn sự thật.
- `verify`: kiểm chữ ký xong thì đọc cả hai khóa trong **một** `MGET`, timeout 50 ms. Valkey lỗi hoặc quá chậm thì **fail-open**: cho request đi, tăng `auth_verify_revocation_check_total{result="error"}`. Lý do: Valkey chết không được kéo sập mọi request đã đăng nhập; trong trường hợp đó rủi ro quay về mức ADR-016 (≤ 15 phút).
- Đổi role dùng khóa theo user: client nhận `401`, gọi refresh (refresh token vẫn hợp lệ), nhận token mới mang role mới. Hạ quyền vì thế có hiệu lực ngay mà không bắt đăng nhập lại. Token cấp trong cùng giây với lúc thu hồi cũng bị từ chối; client chỉ phải refresh thêm một lần.
**Hệ quả.**
- Mỗi request đã đăng nhập tốn thêm một round trip tới Valkey (< 1 ms trong cluster).
- Kết nối WebSocket đang mở của realtime-gw không bị cắt ngay, vì vé kết nối chỉ kiểm lúc bắt tay; đó là việc sau, nếu cần.
- ADR-016 đoạn "≤ 15 phút" được thay bằng ADR này, trừ lúc Valkey lỗi.
- **Bổ sung (A5):** realtime-gw đọc khóa `auth:revoked:user:{user_id}` do auth-svc ghi, với đúng định dạng ở trên (giá trị là Unix giây). Định dạng khóa này từ giờ là **giao ước giữa auth-svc và realtime-gw**, đổi phải qua kiến trúc sư.
  - Mỗi 30 giây, gateway kiểm tra các kết nối đã đăng nhập của nó bằng **một** `MGET` theo lô user id.
  - Kết nối nào có thời điểm xác thực (lúc dùng ticket) ≤ mốc thu hồi thì bị đóng với mã `4401`. Mã này đã được dành sẵn trong `contracts/realtime/README.md`.
  - Ticket không mang `sid`, nên đăng xuất một phiên (khóa `sid`) không cắt WebSocket. Chỉ khóa tài khoản, đổi role và xóa tài khoản mới cắt.
  - Valkey lỗi thì bỏ qua lượt kiểm tra đó (fail-open, có metric).

### ADR-020 — Feed thịnh hành v1 (R2-a)
**Bối cảnh.** Trang chủ mới chỉ có feed "mới nhất". Recommendation v1 (R2) cần một nguồn ứng viên đầu tiên chạy được trên hạ tầng hiện có (PostgreSQL, không ClickHouse), dựa trên dữ liệu đã tin cậy được: lượt xem đã lọc view ảo của C3.
**Quyết định.**
- Bộ flush view (C3) ghi thêm số view theo **giờ UTC** vào `media.video_views_hourly` (migration 000011), **trong cùng transaction** với `view_count`, bằng upsert cộng dồn. video-svc xóa bucket cũ hơn 8 ngày.
- Mỗi 10 phút, **một** replica video-svc (giữ `pg_try_advisory_lock`) tính lại bảng xếp hạng:
  - điểm = Σ view_giờ × 0,5^(tuổi_giờ / 24) trên 72 giờ gần nhất (chu kỳ bán rã 24 giờ);
  - chỉ lấy video mà feed công khai được hiện: `PUBLIC`, `READY`, `VISIBLE`, chủ kênh còn hoạt động;
  - bỏ video có điểm < 1; giữ top 200.
  - Bảng `media.trending` được thay toàn bộ trong một transaction (DELETE + INSERT), nên người đọc không bao giờ thấy bảng dở dang.
- `GET /v1/videos?sort=trending` đọc `media.trending` theo `rank`, cursor là rank, cache `public, max-age=60`. Không trộn với feed mới nhất; client tự quyết khi bảng rỗng.
- Like chưa được tính: số like nằm ở social-svc, video-svc chỉ có bản sao `like_count` lấy từ event. Có thể thêm vào công thức ở v2 mà không đổi schema của `trending`.
**Hệ quả.**
- Mỗi lần flush thêm một câu upsert theo lô, tối đa vài nghìn dòng mỗi giờ.
- Việc tính lại là một câu truy vấn aggregate trên tối đa 72 giờ bucket, có index theo `hour`.
- Video bị chuyển sang PRIVATE/HIDDEN vẫn nằm trong bảng tối đa 10 phút. Vì vậy câu đọc vẫn lọc lại theo điều kiện feed công khai, để nó không bao giờ lộ ra.
- R2 đầy đủ (co-view, theo subscription, A/B) sẽ dùng lại `video_views_hourly` hoặc ClickHouse của R1.

### ADR-021 — Feed "Đang theo dõi" (R2-b)
**Bối cảnh.** Người dùng đã subscribe kênh (C1) nhưng chưa có chỗ xem video mới của các kênh đó. Dữ liệu subscribe nằm ở social-svc, còn danh sách video ở video-svc. ADR-007 cấm FK và truy vấn chéo schema giữa các service.
**Quyết định.**
- video-svc giữ **projection riêng** `media.subscriptions` (migration 000012), dựng từ event `social.subscription.changed`:
  - durable `video-subscriptions` trên stream `SOCIAL`, `deliver_policy: all`;
  - `subscribed=true` → upsert, `false` → delete, xử lý tuần tự theo thứ tự stream.
- Stream `SOCIAL` chỉ giữ 7 ngày, nên migration 000012 **backfill một lần** từ `social.subscriptions`. Việc này làm được vì role migrator sở hữu cả hai schema. Consumer phát lại stream sau đó cũng vô hại, vì mọi thao tác đều idempotent và theo đúng thứ tự.
- `GET /v1/feed/subscriptions`:
  - chỉ trả video mà feed công khai được hiện, của các kênh người gọi theo dõi;
  - xếp mới nhất trước theo `(published_at, id)`, có cursor;
  - dùng index riêng `videos_owner_published`;
  - `private, no-store`.
- Nhất quán sau vài giây: một lượt subscribe mới xuất hiện trong feed khi consumer xử lý xong event.
**Hệ quả.**
- video-svc tiêu thụ thêm một subject của `SOCIAL`; NATS user của video cần quyền tạo durable này.
- Người theo dõi hàng nghìn kênh làm câu truy vấn nặng hơn. Chấp nhận ở beta: truy vấn dùng index theo `owner_id` và giới hạn `limit`. Nếu cần, ở R2 đầy đủ sẽ chuyển sang fan-out-on-write.

### ADR-022 — Analytics người xem (R1): heartbeat → JetStream → ClickHouse trên gpu-01
**Bối cảnh.** Tiêu chí P2 là "rebuffer < 1 %" với 1.000 người xem, nhưng hiện chưa có dữ liệu QoE thật từ player. Recommendation (R2) và thống kê cho creator cũng cần watch time theo video/kênh. `video_views_hourly` (ADR-020) chỉ đếm view, không có thời lượng xem hay chất lượng phát. gpu-01 có 64 GB RAM và một ổ NVMe 512 GB rảnh (quyết định của chủ dự án, 2026-09-30). Máy này mạnh nhưng uptime yếu (ADR-015).
**Quyết định.**
- **Thu thập:** player gửi `POST /v1/playback/heartbeats` (video-svc, `recordPlaybackHeartbeats`) theo lô ≤ 20 sample:
  - `start` khi hiện frame đầu (kèm `startup_ms`);
  - `heartbeat` khoảng mỗi 30 s;
  - `end` khi dừng (`sendBeacon` lúc ẩn trang).

  Các bộ đếm là **delta** kể từ sample trước của cùng playback, nên mất một sample chỉ mất khoảng thời gian của nó, không bao giờ đếm trùng. `recordView` (C3) vẫn là nguồn duy nhất của `view_count`.
- **Truyền:** video-svc kiểm tra quyền đọc video (cùng quy tắc `getVideo`), gắn `owner_id`, `received_at` và `viewer_key`, rồi publish **thẳng** `analytics.playback` lên stream JetStream `ANALYTICS`.
  - Stream: file, `replicas 1`, `max_age 7d`, `max_bytes 5 GiB`, `discard old`.
  - Đây là ngoại lệ có chủ đích với ADR-008: telemetry không phải domain event, đi qua outbox thì mỗi heartbeat thành một lần ghi PostgreSQL.
  - `event_id` = UUIDv5(`playback_id:seq`), dùng làm `Nats-Msg-Id`.
  - Publish lỗi thì bỏ sample và tăng metric; request vẫn trả `202`.
- **Riêng tư:**
  - Không chuyển IP hay user agent đi đâu.
  - `viewer_key` = HMAC-SHA256(`ANALYTICS_VIEWER_SALT`, user id hoặc hash ẩn danh của C3), nên ClickHouse không bao giờ chứa user id dạng rõ.
  - Salt là Secret của video-svc, không vào git.
- **Lưu trữ:** ClickHouse **một node trên gpu-01**, chạy bằng Docker (image pin digest), ngoài k3s như transcoder.
  - Dữ liệu nằm trên ổ NVMe 512 GB, mount tại `/srv/winkey-analytics` (chủ dự án mount và cấp quyền một lần; agent không dùng sudo).
  - Chỉ nghe `127.0.0.1`.
  - Giới hạn `max_server_memory_usage` 12 GB, container 14 GB, để không tranh RAM với ComfyUI và miner.
- **Ghi:** `analytics-worker` (Go, `services/analytics`, owner Sonnet) chạy trên gpu-01 cạnh ClickHouse, kéo từ NATS qua NodePort Tailscale 30422.
  - Durable `analytics-clickhouse`, `max_deliver -1`.
  - Lô tối đa 5 000 message hoặc 2 s, ghi một `INSERT`, chỉ ack sau khi INSERT thành công.
  - Khử trùng lặp ba lớp: JetStream (`Nats-Msg-Id`), `insert_deduplication_token` của lô, và `ReplacingMergeTree` theo `(video_id, playback_id, seq)`.
  - gpu-01 tắt thì message chờ trong stream (≤ 7 ngày / 5 GiB); bật lại thì worker đọc bù.
- **Schema ClickHouse** do architect giữ trong `db/clickhouse/` (file đánh số, idempotent). Worker áp dụng lúc khởi động và ghi vào `winkey.schema_migrations`.
  - `playback_events`: dữ liệu thô, TTL 90 ngày.
  - `video_qoe_hourly`: AggregatingMergeTree theo giờ và video, qua materialized view, TTL 2 năm. Cột: sample, start, watch time, rebuffer, lỗi, quantile startup p50/p95, uniq viewer.
- **Đọc:** R1 chỉ thu và lưu. Dashboard QoE ở Grafana (I3) đọc ClickHouse qua datasource trên gpu-01. API thống kê cho creator, co-view và recommendation là việc sau (R1-b, R2).
**Hệ quả.**
- Có số đo rebuffer, startup và watch time thật để xét tiêu chí P2 và để LT2 đối chiếu.
- gpu-01 thêm hai tiến trình dài hạn. Khi máy tắt, analytics chỉ trễ, site không bị ảnh hưởng.
- Một ngoại lệ với ADR-008 (outbox), giới hạn ở subject `analytics.*` và ghi rõ trong `contracts/events/README.md`.
- Gateway cần route `/v1/playback` tới video-svc (Traefik dev và k8s).
- Hướng mở rộng: ClickHouse replica hoặc chuyển về edge khi có edge-2/3; GeoIP (`country`, hiện luôn null).

### ADR-023 — Thông báo trong app (N1)
**Bối cảnh.** Người dùng đã comment, reply và subscribe được (C1), nhưng không biết khi kênh mình theo dõi ra video mới hay khi có người trả lời mình. Catalog event ghi consumer "notify (P3)" nhưng chưa có thiết kế. Chưa có hạ tầng gửi push/e-mail, và chưa cần: bản beta chỉ cần chuông thông báo trên web.
**Quyết định.**
- **Ở đâu:** trong social-svc, không tạo service mới. Mọi dữ liệu cần để tạo thông báo (subscription, comment, projection `social.videos`) đã nằm ở schema `social`. Bảng `social.notifications` (migration 000013), API `listNotifications`, `getUnreadNotificationCount`, `markNotificationsRead` trong `social.v1.yaml`; gateway chuyển `/v1/notifications` tới social-svc.
- **Bốn loại, tạo lúc ghi (fan-out on write), một hàng cho mỗi người nhận:**
  - `VIDEO_COMMENT` (chủ video, khi có comment cấp 1) và `COMMENT_REPLY` (tác giả comment cha, khi có reply): tạo **trong cùng transaction** với `INSERT` comment, cạnh outbox.
  - `NEW_SUBSCRIBER` (chủ kênh): trong cùng transaction với lượt subscribe mới.
  - `VIDEO_PUBLISHED` (mọi subscriber của kênh): consumer `social-videos` hiện có, trong cùng transaction với cập nhật projection, **chỉ khi** event làm video chuyển từ "chưa có / không PUBLIC" sang `PUBLIC` và không `hidden` (`video.ready` lần đầu hoặc `video.visibility_changed` → `PUBLIC`). `UNLISTED` không thông báo.
  - Không bao giờ thông báo cho chính người gây ra (`CHECK user_id <> actor_id`).
- **Idempotent:** unique index `(user_id, kind, COALESCE(comment_id, video_id, actor_id))`, mọi lệnh ghi dùng `ON CONFLICT DO NOTHING`. `video.ready` gửi lại khi re-encode, đổi PUBLIC → PRIVATE → PUBLIC, hay bỏ rồi subscribe lại đều không tạo thông báo thứ hai.
- **ID:** UUIDv7 do app sinh như mọi bảng khác. Fan-out đọc `subscriber_id` theo trang 1 000 (keyset) và chèn bằng `unnest` của mảng id sinh trong app, cùng một transaction.
- **Lọc lúc đọc, không xóa lúc ghi:** không trả thông báo có video `hidden` hoặc `PRIVATE`, comment không còn `VISIBLE`, hay actor không có trong `auth.public_profiles`. Video hoặc comment bị xóa thật thì FK `ON DELETE CASCADE` xóa luôn thông báo. Badge đếm theo cùng quy tắc, dừng ở 100 (`capped`).
- **Giữ 90 ngày:** janitor trong social-svc xóa theo lô 5 000 hàng mỗi 10 phút, dùng `pg_try_advisory_lock` để chỉ một replica chạy.
- **Giao tới client:** polling `getUnreadNotificationCount` mỗi 60 s khi tab đang hiện, và khi mở chuông thì gọi `listNotifications`. Không qua realtime-gw ở N1.
- **Không kèm tiêu đề video / nội dung comment:** client lấy qua `getVideo` / `getComment` khi hiển thị. Đây là giới hạn đã biết: tiêu đề nằm ở video-svc, `video.ready` không mang tiêu đề, và chép sang social-svc thì phải đồng bộ khi đổi tên.
**Hệ quả.**
- Thêm một bảng lớn nhất của schema `social`. Kênh có N subscriber tạo N hàng mỗi video; ở quy mô beta (≤ 10⁵ subscriber mỗi kênh) mỗi lô fan-out vẫn nằm trong `ack_wait 30s` của consumer. Vượt mức này thì chuyển fan-out sang job riêng, hoặc fan-out on read cho kênh lớn.
- Người mới subscribe không nhận thông báo cho video đã ra trước đó (đúng ý đồ).
- Hướng mở rộng: push qua realtime-gw (room `user:{id}`), Web Push / e-mail tổng hợp, cài đặt tắt từng loại, gom nhóm ("A và 5 người khác đã comment").
