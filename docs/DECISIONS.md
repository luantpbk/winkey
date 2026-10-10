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
**Bổ sung (2026-10-01, lúc chuẩn bị gpu-01).**
- Không có ổ 512 GB trống riêng: `/srv/winkey-analytics` là bind mount của `/mnt/nvme_models/winkey-analytics` trên NVMe Kingmax, **dùng chung** với model ComfyUI và scratch của transcoder (còn trống 127 GB lúc cài). Dữ liệu thô chỉ giữ 90 ngày nên vẫn đủ cho beta; cảnh báo khi còn < 20 GB (I3). Có ổ riêng thì chỉ cần đổi mount, không đổi đường dẫn.
- gpu-01 trước đó chưa có Docker. Chủ dự án đã cài `docker.io` + `docker-compose-v2` của Ubuntu với `iptables: false` (Docker không sửa firewall của máy đang chạy miner/ComfyUI) và `data-root` trên `/srv/winkey-analytics/docker` (ổ `/` chỉ còn khoảng 18 GB). Hệ quả: container dùng `network_mode: host`, ClickHouse tự giới hạn `listen_host` loopback.
- Nhóm `docker` tương đương root, nên quy tắc "agent không sudo trên gpu-01" giờ được giữ bằng review: compose không `privileged`, chỉ mount `/srv/winkey-analytics/{clickhouse,backup}` và `db/clickhouse` (read-only).
**Bổ sung (2026-10-01, khi merge R1 #131).**
- **Retry trong tiến trình, cùng token.** Khi INSERT lỗi, worker không Nak rồi kéo lại. Nó retry đúng lô đó với cùng `insert_deduplication_token`, có back-off và gửi `InProgress` để giữ message. Lý do: token chỉ khử trùng lặp khi cùng các message tạo thành cùng một block, còn kéo lại có thể gom lô khác đi. Mỗi lần thử bị giới hạn bởi `CLICKHOUSE_INSERT_TIMEOUT` (mặc định 30 s, chỉ nhận 1–30 s, tức ≤ ack_wait/2).
- **Rủi ro còn lại (chấp nhận cho beta).** Nếu worker chết sau khi INSERT đã commit nhưng trước khi ack, lô sẽ được giao lại và có thể gom khác đi. Khi đó token không khớp. `playback_events` vẫn đúng nhờ ReplacingMergeTree (sau merge, truy vấn dùng `FINAL` hoặc khử theo khóa). Riêng `video_qoe_hourly` có thể **đếm hai lần** cho lô đó. Trường hợp này hiếm (cần crash đúng trong khoảng hẹp đó). Nếu cần số chính xác thì dựng lại giờ bị ảnh hưởng từ `playback_events`.
- `event_id` trùng trong cùng một lô bị bỏ trước khi INSERT. Message sai schema bị `Term`.
- Testkit pin ClickHouse 26.9.6.6 cho CI, còn gpu-01 chạy 25.8 LTS (do CPU không có AVX2). SQL trong `db/clickhouse/` phải tương thích cả hai.

**Bổ sung (2026-10-01): R1-b, thống kê cho creator.**
- **Vấn đề.** ClickHouse chỉ nghe loopback trên gpu-01, và gpu-01 có uptime yếu (ADR-015). Nếu video-svc đọc thẳng ClickHouse, ta phải mở ClickHouse ra tailnet (thêm bề mặt tấn công), và trang thống kê sẽ lỗi mỗi khi gpu-01 tắt.
- **Quyết định.** analytics-worker tổng hợp `video_qoe_hourly` thành **`analytics.video_daily` trong PostgreSQL** (migration 000015). video-svc chỉ đọc PostgreSQL.
  - Worker kết nối PG qua NodePort 30432, giống transcoder. Role `analytics_svc` chỉ được `USAGE` và CRUD trên schema `analytics`. `media_svc` được `USAGE` và `SELECT` trên `analytics.video_daily`.
  - Ngày tính theo **Asia/Ho_Chi_Minh** (UTC+7, không có giờ mùa hè, nên `toDate(hour, 'Asia/Ho_Chi_Minh')` trên giờ UTC là đúng).
  - Mỗi `ROLLUP_INTERVAL` (mặc định 10 phút), worker tính lại các ngày trong `ROLLUP_WINDOW_DAYS` (mặc định 3, tính cả hôm nay) rồi `INSERT … ON CONFLICT (video_id, day) DO UPDATE`. Lúc khởi động, cửa sổ là `ROLLUP_BACKFILL_DAYS` (mặc định 8), đủ phủ 7 ngày stream giữ lại sau khi gpu-01 tắt lâu. Thao tác idempotent, chạy lại bao nhiêu lần cũng ra cùng kết quả.
  - Mỗi ngày một lần, worker xoá các dòng có `day` cũ hơn 730 ngày.
  - Lỗi rollup không làm worker `not ready` (ingest vẫn chạy), chỉ tăng metric `analytics_rollup_errors_total` và để `analytics_rollup_last_success_timestamp_seconds` đứng yên.
- **API** (`video.v1.yaml`, tag `studio`): `getVideoStats` (`GET /v1/studio/videos/{id}/stats`) và `getChannelStats` (`GET /v1/studio/stats`).
  - Khoảng thời gian 1–90 ngày, không cũ quá 730 ngày. Mặc định 28 ngày gần nhất.
  - `days` liệt kê đủ mọi ngày trong khoảng, ngày không có dữ liệu thì điền 0.
  - Chỉ owner hoặc admin xem được; người khác nhận `404`.
  - `refreshed_at` cho biết số liệu cũ đến đâu.
- **Hệ quả và giới hạn.**
  - `starts` là số phiên phát, khác `view_count` chống gian lận (C3). API trả cả hai và ghi rõ nghĩa từng số.
  - `viewers` là số người xem duy nhất trong ngày (xấp xỉ, `uniq`). Số này không cộng dồn được nên không có ở tổng kênh.
  - Rủi ro đếm đôi đã nêu ở bổ sung R1 vẫn còn ở bảng ngày.
  - Dòng của video đã xoá vẫn ở lại đến hạn 730 ngày nhưng không bao giờ hiển thị, vì mọi truy vấn đều join `media.videos` để kiểm tra chủ sở hữu.
  - Khi gpu-01 tắt, số liệu chỉ đứng yên, trang không lỗi.

- **Bổ sung #193 (2026-10-04, PR #203): phát lại sau khi đã ghi.**
  - Nguyên nhân thật của test "chập chờn" `TestClickHouseDownMidRun…`: một `INSERT` có thể đã commit nhưng worker mất phản hồi. Worker cũ bỏ lô đó và giữ ack tới hết `AckWait` (60 s). Khi phát lại, ranh giới lô khác đi, token khác, nên phần chồng lấn bị ghi lần hai: chờ lâu hơn thì thấy 14 000 dòng thay vì 10 000. Đây là lỗi đếm đôi thật, không phải lỗi hạ tầng test.
  - Sửa (analytics-worker):
    - khi dừng (ctx bị huỷ), lô chưa ack được `Nak` để phát lại ngay;
    - lô có message phát lại (`NumDelivered > 1`) tra trước `event_id` đã có trong `winkey.playback_events` theo khoá sắp xếp `(video_id, playback_id, seq)`, theo cửa sổ 1 000 dòng, rồi chỉ `INSERT` phần còn thiếu với token tính lại;
    - lỗi tra cứu được thử lại và không ack; sau khi tra xong, các lần thử lại `INSERT` giữ nguyên dòng và token.
  - Thay cho dòng "rủi ro đếm đôi … vẫn còn" ở trên: rủi ro do crash giữa `INSERT` và ack đã được đóng, với hai giới hạn còn lại:
    - chỉ đúng khi có **một** worker ghi (như đang triển khai trên gpu-01); hai worker song song có thể cùng tra rồi cùng ghi. Muốn chạy nhiều worker phải có ADR mới;
    - cửa sổ dedup hữu hạn của ClickHouse vẫn áp dụng cho các lần thử lại trong tiến trình.
  - Bảng ngày (R1-b) tính lại từ ClickHouse nên hưởng cùng bản sửa.

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
**Bổ sung (2026-10-01, N2: gợi ý realtime).**
- realtime-gw gửi message `notification.hint {kind}` vào room `user:{id}` của người nhận, suy ra từ event đã có. Không cần event mới và không đụng social-svc:
  - `social.comment.created` → `VIDEO_COMMENT` (cho chủ video) hoặc `COMMENT_REPLY` (cho tác giả comment cha), cùng điều kiện với N1;
  - `social.subscription.changed` với `subscribed=true` → `NEW_SUBSCRIBER` (cho chủ kênh).
- Gợi ý không mang id hay nội dung. Client chỉ gọi lại `getUnreadNotificationCount`. Như vậy quy tắc lọc (ẩn, PRIVATE, actor bị khóa, trùng lặp) vẫn chỉ nằm ở social-svc, và một gợi ý thừa chỉ tốn một request.
- `VIDEO_PUBLISHED` không có gợi ý: fan-out tới mọi subscriber qua WebSocket quá tốn. Web vẫn poll, nhưng khi socket đang kết nối thì giãn chu kỳ từ 60 s lên 5 phút (N2-web, Antigravity 1).
- Event tới realtime-gw sau khi outbox relay đã publish, tức là sau khi transaction ghi thông báo đã commit. Vì vậy request đếm lại luôn thấy thông báo mới.

### ADR-024 — Danh sách phát và "Xem sau" (PL1)
**Bối cảnh.** Người xem đã có feed, tìm kiếm và thông báo, nhưng chưa có cách lưu video để xem sau hay gom thành danh sách phát. Chủ kênh cũng chưa có danh sách phát trên trang kênh. Video nằm ở video-svc, còn quan hệ giữa người dùng và nội dung (comment, like, subscribe) nằm ở social-svc (ADR-007).
**Quyết định.**
- **Chủ sở hữu:** social-svc. Hai bảng `social.playlists` và `social.playlist_items` (migration 000014). Item tham chiếu projection `social.videos` bằng FK `ON DELETE CASCADE`, nên `video.deleted` tự xóa video khỏi mọi danh sách. Không cần consumer mới.
- **"Xem sau"** là một playlist `kind = WATCH_LATER`:
  - mỗi user tối đa 1 (unique index một phần), luôn `PRIVATE` (CHECK);
  - tạo lười khi gọi `getWatchLater` lần đầu, bằng `INSERT … ON CONFLICT DO NOTHING`;
  - thêm và bớt video bằng chính các endpoint item.
- **Giới hạn:** 200 playlist mỗi user, 5 000 item mỗi playlist. Giới hạn item được bảo đảm bằng CHECK `item_count ≤ 5000`; trigger giữ `item_count` và `updated_at`.
- **Thứ tự:** `position bigint` thưa, cách nhau 2^20.
  - Thêm vào cuối: `max + 2^20`.
  - Di chuyển: lấy điểm giữa hai hàng xóm. Khi không còn khe, đánh số lại cả playlist trong cùng transaction; ràng buộc unique `(playlist_id, position)` là `DEFERRABLE` nên được phép trùng tạm thời.
- **Hiển thị:**
  - Playlist `PRIVATE` chỉ chủ xem được; người khác nhận 404. `UNLISTED` thì ai có link cũng xem được. Trang kênh chỉ liệt kê `PUBLIC`, trừ khi chính chủ đang xem.
  - Video trong playlist bị ẩn hoặc `PRIVATE` thì bị lọc lúc đọc, trừ khi người gọi là chủ video. Riêng `item_count` vẫn đếm mọi hàng.
- **Tiêu đề và thumbnail:** social-svc chỉ lưu id video. Client gọi `batchGetVideos` mới ở video-svc (`GET /v1/videos/batch?ids=…`, tối đa 50 id, trả đúng thứ tự, lặng lẽ bỏ video không đọc được), mỗi trang một lần. Không chép tiêu đề sang social-svc, để khỏi phải đồng bộ khi đổi tên.
- **Không phát event** ở PL1. Chưa ai cần; khi tìm kiếm playlist hoặc recommendation cần thì thêm `social.playlist.*` qua outbox.
- **Gateway:** `/v1/playlists` và `/v1/me/watch-later` đi tới social-svc. `/v1/channels/{id}/playlists` đã đi sẵn nhờ `PathPrefix(/v1/channels)`. `/v1/videos/batch` đi tới video-svc qua route `/v1/videos` đã có.
**Hệ quả.**
- Có tính năng lưu video và playlist mà không cần đồng bộ dữ liệu mới giữa các service.
- Mỗi trang playlist cần 2 request (items, rồi batch videos). Chấp nhận được; nếu cần có thể gộp phía BFF sau này.
- Video bị ẩn vẫn chiếm chỗ trong giới hạn 5 000 item của playlist; chấp nhận.
- Mở rộng sau: playlist cộng tác, lưu playlist của người khác, phát liên tục (autoplay next) trên trang xem, tìm kiếm playlist.

### ADR-025 — Video liên quan v1 (R2-c), chưa cá nhân hoá
**Bối cảnh.** Trang xem chưa có danh sách "xem tiếp", nên người xem rời trang sau mỗi video. Recommendation đầy đủ (R2: co-view, theo lịch sử) cần dữ liệu xem đủ lớn mà beta chưa có. Hạ tầng có sẵn: chỉ mục tìm kiếm SR1 (`search_vector`), bảng `media.trending` (R2-a) và chủ kênh của video.
**Quyết định.**
- Thêm endpoint `listRelatedVideos` (`GET /v1/videos/{id}/related`, video-svc). Không cần migration, mọi dữ liệu đã có trong schema `media`.
- Ứng viên chỉ gồm video công khai xem được (`PUBLIC`, `READY`, `moderation_state = VISIBLE`), bỏ chính video nguồn, mỗi video xuất hiện tối đa 1 lần. Ba nguồn:
  1. **Tương tự:** tối đa 8 video, xếp theo `ts_rank(search_vector, q)`, với `q` = `plainto_tsquery('simple', winkey_fold(title nguồn))` nối bằng OR (dùng `websearch_to_tsquery` hoặc ghép `|`), để có kết quả cả khi không khớp toàn bộ từ. Dùng chỉ mục `videos_search_fts`.
  2. **Cùng kênh:** tối đa 4 video mới nhất của chủ video nguồn.
  3. **Thịnh hành:** lấy theo `media.trending.rank` để lấp cho đủ `limit`.
- **Thứ tự trộn cố định:** 1, 1, 2, 1, 3, rồi lặp lại; nguồn nào hết thì lấy nguồn kế tiếp; bỏ trùng. Kết quả giống nhau với mọi người xem, nên cache 5 phút (Valkey, khoá theo `video_id` + `limit`) kèm `Cache-Control: public, max-age=300`.
- Nếu video nguồn không xem được với người gọi (riêng tư, ẩn, chưa READY), trả `404` như `getVideo`. Video riêng tư của chính owner cũng trả 404 vì kết quả là chung cho mọi người.
**Hệ quả.**
- Có "xem tiếp" ngay, không tốn hạ tầng mới. Chi phí là 3 truy vấn ngắn khi cache trượt.
- Chất lượng chỉ ở mức khá: dựa vào chữ trong tiêu đề, chưa hiểu nội dung. R2 (co-view từ `analytics.video_daily` và ClickHouse, theo subscription, A/B) thay thế sau mà không đổi contract, vì contract không hứa cách xếp hạng.

### ADR-026 — Quên mật khẩu và xác minh email (A6)
**Bối cảnh.** auth-svc chưa có cách lấy lại tài khoản khi quên mật khẩu, và `email_verified` luôn là false với tài khoản đăng ký bằng email. Trước khi mở beta công khai, cả hai đều bắt buộc. Ngoài ra, việc xác thực tài khoản là một phần của LEGAL. Chưa có hạ tầng gửi mail.
**Quyết định.**
- **Token dùng một lần.** Lưu trong bảng `auth.email_tokens` (migration 000016):
  - giá trị 256 bit ngẫu nhiên, mã hoá base64url (43 ký tự); DB chỉ lưu SHA-256 của nó;
  - kèm `purpose` (`VERIFY_EMAIL` hoặc `RESET_PASSWORD`) và địa chỉ `email` đã nhận token;
  - hạn dùng: reset 1 giờ, verify 48 giờ.
  - Token chỉ hợp lệ khi `email` vẫn bằng email hiện tại của user và user đang `ACTIVE`.
  - Mọi trường hợp sai (không tồn tại, hết hạn, đã dùng, user bị khoá) đều trả chung `400 INVALID_TOKEN`.
- **Bốn endpoint mới:**
  - `requestPasswordReset`: luôn trả `202`, kể cả khi email không có tài khoản, để không lộ email nào đã đăng ký. Tối đa 3 mail mỗi user mỗi giờ.
  - `resetPassword`: đổi mật khẩu, đánh dấu đã dùng mọi token reset của user, xác minh luôn email, thu hồi mọi phiên (refresh family và mốc thu hồi ADR-019), rồi gửi mail báo `PASSWORD_CHANGED`.
  - `resendEmailVerification`: cần đăng nhập. Trả `409 EMAIL_ALREADY_VERIFIED` nếu đã xác minh. Tối đa 3 lần mỗi giờ.
  - `verifyEmail`: không cần đăng nhập, vì link có thể được mở trên thiết bị khác.
  - `register` tự gửi mail xác minh đầu tiên. Chưa xác minh thì chưa bị chặn chức năng nào; quyết định chặn (nếu cần) để lại cho LEGAL.
- **Gửi mail qua hàng đợi giao dịch `auth.mail_queue`.** Cách làm giống outbox (ADR-008):
  - Request ghi một dòng vào hàng đợi trong cùng transaction.
  - Một vòng lặp nền trong auth-svc lấy dòng bằng `FOR UPDATE SKIP LOCKED` và gửi.
  - Lỗi thì backoff, tối đa 8 lần, sau đó đánh dấu `dead_at`.
  - Khi đã gửi hoặc bỏ cuộc thì xoá `params` (link chứa token). Ràng buộc trong DB bắt buộc điều này.
  - Không đi qua NATS, vì nội dung chứa token.
  - Dòng cũ hơn 7 ngày bị xoá.
- **Transport:** `MAIL_TRANSPORT=smtp|log`.
  - `smtp` dùng `SMTP_URL`, `MAIL_FROM`.
  - `log` chỉ ghi log "mail suppressed" kèm template và id, không có địa chỉ hay token. Đây là mặc định ở dev và CI.
  - Môi trường dev dùng Mailpit để thử thật.
  - Nhà cung cấp SMTP cho production do **bạn** chọn. Antigravity 2 đưa thông tin đó vào secret.
**Hệ quả.**
- Người dùng tự lấy lại tài khoản. Email được xác minh là nền cho bước xác thực tài khoản sau này (LEGAL).
- Khi production chưa có SMTP, mail nằm chờ trong hàng đợi, rồi `dead` sau 8 lần thử. Phải có SMTP trước khi mở beta.
- Token chỉ tồn tại dạng rõ trong DB trong khoảng thời gian chờ gửi.

### ADR-027 — Hạn mức upload (UQ1)
**Bối cảnh.** `createUpload` chỉ giới hạn kích thước một file (20 GiB). Một tài khoản có thể mở hàng trăm upload, làm đầy bucket và giữ GPU bận. Mở beta công khai thì phải chặn điều này. Contract đã khai báo `429`, nhưng upload-svc chưa áp dụng.
**Quyết định.**
- upload-svc kiểm tra hạn mức trong transaction tạo video, có `pg_advisory_xact_lock` theo `owner_id` để hai request song song không cùng lọt.
- Ba giới hạn, cấu hình bằng env:
  - tối đa 3 video đang `UPLOADING`;
  - tối đa 20 upload bắt đầu trong 24 giờ trượt;
  - tối đa 50 GiB `size_bytes` trong 24 giờ.
- Tính trên mọi dòng `media.videos` của owner tạo trong cửa sổ, bất kể trạng thái sau đó, nên xoá rồi upload lại không lách được. Không cần migration: dùng chỉ mục `videos_owner_created` có sẵn.
- Role `admin` được miễn.
- Khi vượt: `429 UPLOAD_QUOTA_EXCEEDED` kèm `Retry-After`, và metric `upload_quota_rejections_total{limit}`.
**Hệ quả.** Một tài khoản chỉ gây thiệt hại tối đa 50 GiB mỗi ngày. Creator lớn cần hạn mức cao hơn thì nâng env, hoặc sau này làm hạn mức theo user.
**Bổ sung 2026-10-01 (UQ1-b, sửa thiết kế).** Gạch đầu dòng "xoá rồi upload lại không lách được" ở trên **sai**: video bị xoá cứng (`DELETE FROM media.videos` ở video-svc, và ở upload-svc khi abort), nên dòng đã xoá biến khỏi cửa sổ 24 giờ.
- Migration `000017_upload_ledger` thêm `media.upload_ledger (video_id, owner_id, size_bytes, created_at)`: một dòng cho mỗi `createUpload` qua được kiểm tra, ghi **trong cùng transaction** với dòng video. Không FK tới `media.videos` hay `auth.users`, nên xoá video không ảnh hưởng tới sổ.
- Sổ chỉ append: trigger chặn `UPDATE`, và chặn `DELETE` dòng trẻ hơn 25 giờ. Janitor của upload-svc xoá dòng cũ hơn 48 giờ.
- `daily_count` và `daily_bytes` tính từ sổ. `concurrent` vẫn tính từ `media.videos` (`status = 'UPLOADING'`), vì upload đã xoá thì không còn chiếm chỗ.
- Upload bị abort vẫn được tính trong hạn mức ngày, và đó là chủ ý: 20 lần mỗi ngày là đủ cho người dùng thật.
- Migration chép các video tạo trong 25 giờ gần nhất vào sổ, nên lúc chuyển sang sổ không mất số liệu.

### ADR-028 — Recommendation v1 "Dành cho bạn" (R2)
**Bối cảnh.** Đã có ba nguồn chưa cá nhân hoá: thịnh hành (R2-a, ADR-020), "Đang theo dõi" (R2-b, ADR-021) và video liên quan theo tiêu đề (R2-c, ADR-025). ClickHouse trên gpu-01 (ADR-022) đã ghi mỗi lượt phát kèm `viewer_key`. Hai ràng buộc từ R1-b vẫn giữ: ClickHouse chỉ nghe loopback trên gpu-01, và gpu-01 có uptime yếu, nên video-svc **không bao giờ** đọc thẳng ClickHouse.
**Quyết định.**
- **Tính ngoại tuyến (analytics-worker, gpu-01), job `reco`** mỗi `RECO_INTERVAL` (mặc định 30 phút; một worker, như ADR-022 bổ sung #193):
  - *Lượt xem đủ:* với mỗi cặp (`viewer_key`, `video_id`) trong `RECO_WINDOW_DAYS` (mặc định 30) ngày, tổng `watched_ms` (khử trùng theo `(video_id, playback_id, seq)`) ≥ `RECO_MIN_WATCH_MS` (mặc định 20 000).
  - *Co-view* → `analytics.video_coview` (migration 000018): dùng lượt xem đủ của **mọi** người xem (đăng nhập và ẩn danh). `co_viewers` = số người xem khác nhau đã xem đủ cả hai video; `score` = `co_viewers / sqrt(viewers(a) · viewers(b))`. Bỏ cặp có `co_viewers < 3` (vừa là nhiễu, vừa để không cặp nào lộ lịch sử của một người). Mỗi video giữ `RECO_NEIGHBORS` (mặc định 30) hàng xóm có `score` cao nhất.
  - *Lịch sử* → `analytics.viewer_history`: chỉ người xem **đã đăng nhập** (`authenticated = true`), tối đa `RECO_HISTORY` (mặc định 50) video xem đủ gần nhất mỗi người, kèm `last_watched_at` và `watched_ms`.
  - Mỗi lần chạy thay **toàn bộ** nội dung hai bảng trong **một** transaction PostgreSQL (DELETE rồi COPY/INSERT), nên người đọc không bao giờ thấy bảng dở dang. Lỗi chỉ tăng `analytics_reco_errors_total`; `analytics_reco_last_success_timestamp_seconds` đứng yên. Ingest không bị ảnh hưởng, `/readyz` không đổi.
  - gpu-01 tắt: hai bảng chỉ cũ đi, feed vẫn chạy.
- **Phục vụ (video-svc):** `getRecommendedFeed` (`GET /v1/feed/recommended`, auth tuỳ chọn).
  - Người gọi đã đăng nhập: `viewer_key = analytics.ViewerKey(ANALYTICS_VIEWER_SALT, "u:" + user_id)`, đúng hàm R1 đang dùng. Đọc tối đa 50 dòng lịch sử.
  - Ba điểm thành phần cho mỗi ứng viên `v`:
    - `s_c(v) = Σ_h score(h, v) · 0.5^(tuổi_ngày(h) / 7)`, với `h` chạy qua lịch sử. Sau đó chia cho max để về [0, 1].
    - `s_s(v) = 0.5^(tuổi_giờ(v) / 72)` cho video đăng trong 14 ngày gần nhất của các kênh người gọi theo dõi (`media.subscriptions`).
    - `s_t(v) = 1 − (rank − 1) / 200` theo `media.trending`.
  - `final = 1.0·s_c + 0.7·s_s + 0.3·s_t`. Hoà điểm thì xếp theo `published_at` DESC, rồi `id` DESC.
  - Loại bỏ: video đã có trong lịch sử, video của chính người gọi, và video không qua điều kiện feed công khai (cùng điều kiện đọc của `media.trending`).
  - Lấp đầy: thiếu thì nối video công khai mới nhất (chưa bị loại) vào sau các ứng viên có điểm, theo `published_at` DESC, `id` DESC.
  - Đa dạng (best effort, chốt ở #208): gọi `L` là danh sách trên (ứng viên theo điểm, rồi phần lấp đầy). Chọn lần lượt từng vị trí: lấy phần tử **đầu tiên còn lại** trong `L` mà nếu đặt vào thì trong 10 vị trí liên tiếp kết thúc tại đó không có quá 2 video cùng kênh. Nếu không phần tử nào thoả, lấy phần tử đầu tiên còn lại. Dừng khi đủ 200 hoặc hết `L`. Không bao giờ bỏ video hợp lệ; luật áp một lần trên cả danh sách nên đúng qua ranh giới trang.
  - Ẩn danh: `s_c = s_s = 0`, tức thịnh hành rồi mới nhất. Không cần Valkey; `Cache-Control: public, max-age=60`.
  - Phân trang: trang đầu tính danh sách và lưu id vào Valkey `reco:{user_id}:{list_id}` với TTL 10 phút. `cursor` là opaque {`list_id`, `offset`}. List hết hạn thì tính lại và tiếp tục ở cùng `offset` (chấp nhận hiếm khi trùng hoặc hụt). Đăng nhập: `private, no-store`.
  - Metric: `video_reco_requests_total{mode="personal|fallback|anonymous"}`, `video_reco_compute_seconds`.
- **Riêng tư.** PostgreSQL chỉ có `viewer_key` (HMAC), không có user id rõ. Lịch sử tự rơi khỏi bảng sau `RECO_WINDOW_DAYS` không xem. Muốn xoá ngay khi xoá tài khoản thì cần thêm việc riêng (chưa làm ở v1).
**Hệ quả.**
- Có feed cá nhân mà không thêm service hay hạ tầng mới. Chi phí phục vụ là vài truy vấn PostgreSQL có index mỗi 10 phút cho mỗi người dùng.
- Chất lượng tăng dần theo dữ liệu xem; lúc đầu feed gần như thịnh hành + "Đang theo dõi".
- Chưa đo được hiệu quả. **R2-ab** (sau) sẽ thêm `surface` vào `PlaybackSample` và cột ClickHouse, cùng phân nhóm A/B theo hash user, để so watch time giữa "Dành cho bạn" và thịnh hành.
- Thay toàn bảng mỗi lần chạy chỉ hợp ở quy mô beta. Khi bảng lớn thì đổi sang bảng tạm + `ALTER TABLE … RENAME` trong cùng transaction, không đổi contract.
- Contract không hứa công thức. Đổi trọng số hay nguồn ứng viên chỉ cần sửa ADR này.

- **Bổ sung R2-perf (2026-10-05): chặn chi phí khi dữ liệu lớn.**
  - *Co-view (worker):* trước self-join, mỗi `viewer_key` chỉ giữ tối đa `RECO_COVIEW_MAX_PER_VIEWER` (mặc định 200) video xem đủ **gần nhất**. Chi phí self-join tăng theo bình phương số video của một người; một tài khoản bất thường (bot, người xem cả ngày) không được phép làm chậm cả job. `viewers(v)` vẫn đếm trên tập đã giới hạn, để score nhất quán. Metric `analytics_reco_viewers_capped_total`.
  - *Ứng viên (video-svc):* câu SQL ứng viên trả tối đa `RECO_CANDIDATE_LIMIT` (mặc định 2 000) dòng theo đúng thứ tự `final` DESC, `published_at` DESC, `id` DESC, rồi mới chạy luật đa dạng và cắt 200. 2 000 là đủ để luật đa dạng (tối đa 2 mỗi 10) luôn tìm được video khác kênh, trừ khi cả kho chỉ có một vài kênh, và khi đó luật vốn đã là best effort. Phần lấp đầy theo "mới nhất" nằm trong cùng giới hạn này.
  - Không đổi contract, không migration.

### ADR-029 — Observability (I3): đo ở edge-1, lưu và cảnh báo trên gpu-01
**Bối cảnh.** Chưa có dashboard hay cảnh báo nào. Mọi service đã có `/metrics` (Prometheus) và log JSON ra stdout. Kế hoạch gốc (ADR-011, INFRASTRUCTURE §3) đặt VictoriaMetrics, Loki và Grafana trên gpu-01. Nhưng gpu-01 có uptime yếu (ADR-015), còn edge-1 chỉ cho Winkey tối đa 2 vCPU / 10 GB requests.
**Quyết định.**
- **Lưu trữ và giao diện trên gpu-01**, chạy bằng docker compose `deploy/gpu-01/observability/` theo đúng quy tắc của ADR-022 bổ sung:
  - image pin digest, `network_mode: host`, không `privileged`;
  - chỉ mount `/srv/winkey-obs/{victoria,loki,grafana}` và config read-only trong repo. Thư mục do chủ dự án tạo; agent không dùng sudo.
  - Thành phần:
    - VictoriaMetrics single-node, retention 30 ngày;
    - Loki single-binary trên filesystem, retention 14 ngày;
    - Grafana.
  - Tổng dung lượng mục tiêu ≤ 20 GB, dùng chung NVMe với ClickHouse.
  - Lắng nghe: chỉ loopback và IP tailnet của gpu-01. Không có gì public.
- **Thu thập trên edge-1 (k3s, namespace `observability`), theo mô hình đẩy có bộ đệm:**
  - `vmagent` (1 bản) scrape:
    - mọi pod có annotation `prometheus.io/scrape`;
    - Traefik, CNPG, NATS (exporter), node-exporter (DaemonSet), kube-state-metrics.
  - `vmagent` `remote_write` sang VictoriaMetrics trên gpu-01 qua Tailscale, với bộ đệm đĩa tối đa 2 GiB (`-remoteWrite.tmpDataPath`): gpu-01 tắt vài giờ thì số liệu được gửi bù, không mất.
  - Grafana Alloy (DaemonSet) đọc log pod (`/var/log/pods`) và đẩy sang Loki. Khi gpu-01 tắt lâu, log có thể mất. Chấp nhận được, vì log gốc vẫn còn trên node theo rotation của k3s.
  - Tổng requests của namespace ≤ 200m CPU / 512 MiB, nằm trong ngân sách §0.1.
- **gpu-01 tự đo:** node-exporter, ClickHouse, analytics-worker và transcoder do VictoriaMetrics trên gpu-01 scrape trực tiếp (`-promscrape.config`).
- **Dashboard** (JSON provision trong repo, không sửa tay trên UI):
  1. Tổng quan dịch vụ: RPS, tỉ lệ 5xx, p95 theo service và route.
  2. Pipeline: upload → READY, hàng đợi transcode (consumer pending), job lỗi.
  3. QoE từ ClickHouse: rebuffer ratio, startup p95, lỗi player theo giờ. Đọc qua user ClickHouse read-only `grafana_ro`, chỉ `SELECT` trên `video_qoe_hourly`.
  4. Dữ liệu: PostgreSQL, stream NATS, dung lượng đĩa của edge-1 và gpu-01, backlog `ANALYTICS`.
- **Cảnh báo** (Grafana alerting, email qua SMTP Resend bằng secret riêng; người nhận lấy từ biến môi trường, không ghi vào git):
  - 5xx > 2 % trong 5 phút, hoặc p95 > 1 s trong 10 phút, theo service;
  - edge-1 còn < 15 % đĩa; gpu-01 `/srv` còn < 20 GB (ADR-022 bổ sung);
  - transcode pending > 10 trong 30 phút; stream `ANALYTICS` > 3 GiB;
  - rollup hoặc reco không thành công quá 2 giờ trong lúc gpu-01 đang chạy;
  - bộ đệm `vmagent` trên edge-1 > 1 GiB;
  - `auth_mail_dead_total` tăng;
  - rebuffer ratio theo giờ > 1 % (tiêu chí P2), mức warning.
- **Giám sát từ ngoài:** cảnh báo nằm trên gpu-01, nên không báo được khi chính gpu-01 tắt. Kiểm tra "winkey.vn còn sống" (trang chủ, `/v1/videos?limit=1`, một file trên `media.winkey.vn`) dùng thêm một dịch vụ uptime miễn phí bên ngoài, do chủ dự án đăng ký. Không cần code.
- **Tailscale:** thêm luật `tag:edge → tag:gpu:8428,3100`, cho remote write và đẩy log.
**Hệ quả.**
- Có số đo cho tiêu chí P2 và cho LT2. edge-1 chỉ tốn vài trăm MiB RAM.
- gpu-01 tắt thì dashboard và cảnh báo nội bộ tắt theo; số liệu được gửi bù, log có thể hụt. Kiểm tra từ ngoài vẫn báo site sập.
- Lên edge-2/3 thì chuyển VictoriaMetrics, Loki và Grafana về edge mà không đổi phía thu thập (chỉ đổi đích `remote_write`).

### ADR-030 — Đo hiệu quả "Dành cho bạn": surface + A/B (R2-ab)
**Bối cảnh.** R2 (ADR-028) đã chạy trên production, nhưng chưa biết feed cá nhân hoá có làm người dùng xem lâu hơn feed thịnh hành hay không. ClickHouse chưa biết lượt phát bắt đầu từ đâu, cũng chưa có nhóm đối chứng.
**Quyết định.**
- **Surface.** `PlaybackSample.surface` (tuỳ chọn) là nơi lượt phát bắt đầu: `for_you`, `latest`, `trending`, `up_next`, `search`, `subscriptions`, `channel`, `playlist` hoặc `other`.
  - Web gắn `?src=<surface>` vào mọi link sang trang xem.
  - Trang xem đọc tham số đó một lần, xoá nó khỏi URL bằng `history.replaceState` (để link chia sẻ không mang nhãn sai), rồi gửi cùng giá trị trên mọi sample của lượt phát đó.
  - Thiếu hoặc không hợp lệ thì gửi `other`. Client cũ không gửi thì lưu NULL ("unknown").
- **Phân nhóm A/B (chỉ người đã đăng nhập).**
  - `bucket` = 8 byte đầu của SHA-256(`RECO_AB_SEED` + ":" + user_id), đọc dạng uint64 big-endian, mod 100.
  - `bucket < RECO_AB_TREATMENT_PERCENT` → `reco`, còn lại → `control`.
  - Cấu hình ở video-svc: `RECO_AB_SEED` (mặc định `r2ab-1`), `RECO_AB_TREATMENT_PERCENT` (0–100, mặc định 50). Đổi seed là chia lại nhóm.
  - `RECO_AB_ENABLED=false` thì mọi người là `reco` và `reco_variant` là null. Đây là cách tắt thí nghiệm.
  - Ẩn danh: không có nhóm, `reco_variant` null.
- **Nhóm `control`** vẫn gọi `getRecommendedFeed` như thường, nhưng `s_c = s_s = 0`: danh sách là thịnh hành, rồi mới nhất. Các luật loại bỏ (đã xem, video của chính mình, điều kiện feed công khai), luật đa dạng và phân trang giữ nguyên, để chỉ khác đúng phần cá nhân hoá. Tab vẫn tên "Dành cho bạn" (người dùng không biết mình thuộc nhóm nào). Metric `video_reco_requests_total` thêm nhãn `variant`.
- **Ghi lại.**
  - video-svc tính `reco_variant` cho người gọi đã đăng nhập ở mỗi `recordPlaybackHeartbeats`, bằng **cùng hàm** dùng cho feed, rồi đưa nó cùng `surface` vào event `analytics.playback` v1. Hai field mới là tuỳ chọn và có thể null, nên vẫn là v1 (thay đổi cộng thêm).
  - **Thứ tự deploy bắt buộc:** analytics-worker (chấp nhận hai field mới, áp `db/clickhouse/0002_reco_ab.sql`) phải lên **trước** video-svc, vì worker đang `DisallowUnknownFields` và sẽ `Term` event lạ.
  - `0002_reco_ab.sql` phải vào **cùng PR** với thay đổi của worker, không được vào trước. Worker hiện tại `INSERT` không liệt kê cột, nên thêm cột trước sẽ làm hỏng mọi lần ghi; CI của #225 đã chứng minh. Trên gpu-01 thư mục `db/clickhouse` được mount từ bản checkout, nên checkout và image worker phải được cập nhật cùng lúc.
- **Lưu trữ.** `0002_reco_ab.sql` (nội dung nằm ở phụ lục brief R2-ab, vào repo cùng PR R2-ab-w) thêm hai cột Nullable vào `playback_events` và bảng `winkey.reco_ab_daily` (AggregatingMergeTree qua materialized view, theo ngày Asia/Ho_Chi_Minh, arm và surface; chỉ người đã đăng nhập có arm; giữ 1 năm). Grafana đọc bảng này bằng `grafana_ro`; cần thêm quyền `SELECT` cho đúng bảng này.
- **Cách đọc kết quả.**
  - Chỉ số chính: thời gian xem mỗi người xem hoạt động mỗi ngày, theo arm, gộp mọi surface (công thức ở đầu `0002`).
  - Chỉ số phụ: số lượt phát bắt đầu từ `for_you` trên mỗi người xem, và tỉ trọng thời gian xem đến từ `for_you`.
  - Chỉ kết luận khi đã chạy **≥ 14 ngày** và **mỗi arm có ≥ 200 người xem hoạt động**. Trước đó chỉ là số tham khảo, vì quy mô beta nhỏ nên không đủ ý nghĩa thống kê.
  - Khi thắng, đặt `RECO_AB_TREATMENT_PERCENT=100` hoặc `RECO_AB_ENABLED=false`. Không cần sửa code.
**Hệ quả.**
- Hai cột mới trong `playback_events` và một bảng tổng hợp nhỏ. Không thêm dữ liệu cá nhân: arm suy ra từ user id, không lưu user id rõ.
- 50 % người dùng đăng nhập tạm thời nhận feed kém cá nhân hoá hơn trong thời gian thí nghiệm. Chấp nhận được, vì đó chính là điều cần đo.
- `surface` cũng phục vụ phân tích khác (tỉ trọng xem từ tìm kiếm, "Xem tiếp"…) sau thí nghiệm.

### ADR-031 — V4: rút ngắn upload → READY bằng đo đạc và chồng lấn, không làm full-GPU/chia đoạn
**Bối cảnh.** ROADMAP ghi V4 là "full-GPU pipeline + transcode song song theo chunk + DASH". Số đo thật trên gpu-01 (INFRASTRUCTURE §6, V2b) đi ngược với kế hoạch đó:
- Một job NVENC đã làm **khối NVENC bão hoà**: thêm phiên song song không nhanh hơn (5.6× → 5.9× tổng).
- Khi GPU dùng chung với miner và ComfyUI, **decode bằng NVDEC chậm gấp đôi decode CPU** (3.0× so với 5.6×). Vì vậy full-GPU (`-hwaccel cuda` + `scale_cuda`) hiện chậm hơn chứ không nhanh hơn.
- Chia video thành đoạn rồi encode song song trên **một** GPU không tăng thông lượng, vì cùng một khối NVENC. Trộn encoder (NVENC + x264) trong cùng một rendition thì chất lượng không đồng đều giữa các đoạn.
- Pipeline hiện tại chạy **tuần tự**: tải về → archive → probe → encode → poster → storyboard → **upload toàn bộ** → READY. Ước tính trong INFRASTRUCTURE §6 là upload (~4.3 GB mỗi giờ video, ~6 phút ở 100 Mbps) có thể ngang thời gian encode (~10.7 phút mỗi giờ video), nhưng **chưa từng đo từng bước** trên job thật.
- DASH: hls.js phát được mọi trình duyệt không phải Safari, Safari phát HLS gốc. Chưa có client nào cần DASH.
**Quyết định.**
- **V4-a: đo từng bước (Sonnet 2, transcoder).**
  - Histogram `transcoder_stage_seconds{stage}` với `stage` ∈ download, archive, probe, encode, poster, storyboard, upload, commit; histogram `transcoder_job_seconds` (tải xong → READY); counter `transcoder_upload_bytes_total`.
  - Mỗi job ghi một dòng log JSON tổng kết thời gian từng bước, kèm `media_sec` và encoder (không có dữ liệu người dùng).
  - Antigravity 2 thêm panel "Transcode stages" vào dashboard Pipeline.
- **V4-b: chồng lấn upload với encode (Sonnet 2), làm ngay sau V4-a.**
  - FFmpeg ghi segment với `-hls_flags independent_segments+temp_file` (segment xong mới được đổi sang tên thật).
  - Trong lúc FFmpeg chạy, một goroutine quét thư mục HLS (mỗi giây, hoặc dùng fsnotify) và upload mỗi `seg_*.m4s` đã hoàn tất **đúng một lần**, dùng chung giới hạn `UPLOAD_PARALLELISM`.
  - `init.mp4`, mọi playlist (`*.m3u8`), poster và storyboard vẫn upload **sau** khi FFmpeg kết thúc thành công. Player chỉ thấy video khi có `master.m3u8` và trạng thái READY.
  - Archive (chép bản gốc sang HDD) chạy song song với probe và encode, và phải xong trước commit.
  - FFmpeg lỗi thì huỷ uploader. Prefix `v/{id}/a{attempt}/` dở dang đã được `cleanupPrefix` và `RemoveOldAttempts` dọn như hiện nay, nên không cần cơ chế mới.
  - Kỳ vọng: thời gian job gần bằng max(encode, upload) thay vì tổng.
- **V4-c (chỉ làm khi số đo V4-a cho thấy encode là nút thắt):** đẩy rendition 480p sang tiến trình x264 chạy song song với NVENC, để khối NVENC chỉ còn 1080p và 720p. Phải có số đo trước/sau trên job thật. Full-GPU chỉ xem lại khi gpu-01 không còn chia GPU với miner.
- **DASH hoãn sang P4.** Segment CMAF hiện tại đã dùng lại được cho DASH, nên khi cần chỉ thêm manifest, không phải transcode lại.
**Hệ quả.**
- Không đổi contract, không migration, không đổi đầu ra HLS (vẫn đúng ladder và segment như ADR-006). Video cũ không bị ảnh hưởng.
- Có số đo thật cho từng bước, để các quyết định tối ưu sau này dựa trên dữ liệu.
- Upload trong lúc encode tăng tải mạng nhà trong thời gian encode. Cùng giới hạn `UPLOAD_PARALLELISM` như hiện nay nên không vượt mức cũ.


### ADR-032 — Hạ tầng mở rộng: R2 làm object storage chính, node gia đình `tag:worker`, edge-1 về 2 OCPU / 12 GB
**Trạng thái: Đã chấp nhận** (2026-10-05; user chọn phương án A cho Oracle và ưu tiên máy local + R2).

**Bối cảnh.**
- **Oracle giảm Ampere A1 Always Free** xuống **2 OCPU / 12 GB** mỗi tenancy (đổi ngày 2026-06-15, áp dụng từ 2026-08-18).
  - edge-1 đang chạy 4 OCPU / 24 GB. Cost Analysis chưa có phí, nhưng user chọn **đưa edge-1 về đúng hạn mức miễn phí**.
  - edge-1 đã dùng hết 200 GB block volume miễn phí. Egress 10 TB/tháng và Object Storage 20 GB vẫn còn.
- Trên edge-1 hiện nay:
  - Garage (RF 1) giữ `winkey-raw`, `winkey-media` và `winkey-pg-backup` **trên cùng đĩa** với PostgreSQL;
  - mọi lượt upload của người dùng và mọi lượt upload HLS từ gpu-01 đều đi qua edge-1.
- **Cloudflare R2:**
  - Miễn phí 10 GB-tháng, 1 triệu Class A (ghi/list) và 10 triệu Class B (đọc) mỗi tháng. Vượt mức thì trả **0.015 USD/GB-tháng**, 4.50 USD/triệu Class A, 0.36 USD/triệu Class B. **Egress miễn phí**.
  - Không có trần chi tiêu cứng.
  - Code chỉ dùng S3 cơ bản (ADR-004), tách `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT`. Part multipart bằng nhau trừ part cuối (`partsize`), đúng yêu cầu của R2.
- ADR-017 kiểm soát quyền xem media tại nginx của edge (`auth_request` cho URL thường, `secure_link` cho video riêng tư/unlisted). Nếu phục vụ thẳng từ bucket R2 công khai hoặc từ CDN thì kiểm soát này bị bỏ qua.
- Repo public: runner GitHub-hosted miễn phí, còn self-hosted runner sẽ chạy code từ PR của fork.
- User bổ sung máy gia đình cấu hình vừa/thấp, chạy 24/7, ở nhiều mạng khác nhau, nối qua Tailscale. Máy đầu tiên: `100.82.170.119`, user `thanhluan`.

**Quyết định.**

1. **R2 là object storage chính, bỏ Garage.**
   - Bucket R2 thay cho bucket Garage, **giữ nguyên tên và key**: `winkey-raw`, `winkey-media`, `winkey-pg-backup`. Thêm `winkey-backup` cho etcd và ClickHouse.
   - Mỗi service có token R2 riêng, chỉ trên bucket của nó, quyền tối thiểu.
   - **Upload:** `S3_PUBLIC_ENDPOINT` trỏ vào endpoint S3 của R2. Trình duyệt upload thẳng lên R2, edge-1 không còn chịu băng thông upload. Cần CORS trên `winkey-raw`: `PUT` từ `https://winkey.vn` và expose header `ETag`.
   - **Transcoder (gpu-01):** đọc raw và ghi HLS thẳng lên R2 qua internet. Không còn đi qua tailnet tới edge-1.
   - **Phục vụ video:** giữ nguyên ADR-005/017, nginx trên edge vẫn là cổng (auth_request, secure_link, `proxy_cache`). Origin đổi từ Garage web sang **`media-origin`**:
     - một Deployment `rclone serve http` chỉ đọc, dùng token R2 read-only của `winkey-media`, đặt sau Traefik với Host `winkey-media.winkey.vn` như hiện nay;
     - bucket R2 **không bật public**, không bật `r2.dev`.

     Không đưa video qua CDN Cloudflare ở giai đoạn này: một Worker kiểm tra quyền trên mọi segment sẽ vượt hạn mức miễn phí 100 nghìn request/ngày của Workers. Xét lại khi egress Oracle > 60%.
   - **Lifecycle rule** làm chốt chặn cuối:
     - `winkey-raw` xoá sau 30 ngày (job hiện tại vẫn xoá sau 7 ngày kể từ READY);
     - multipart dở dang huỷ sau 7 ngày;
     - `winkey-backup` xoá sau 15 ngày.
   - **Chuyển dữ liệu:** sau khi dọn video test chỉ còn 3 video.
     1. `rclone copy` Garage → R2, giữ nguyên key.
     2. So sánh số object và checksum.
     3. Đổi env của upload-svc, video-svc, transcoder và barman trong một cửa sổ bảo trì ngắn: tạm khoá upload, đổi env, smoke test upload → READY → phát, rồi mở upload lại.
     4. Giữ Garage chỉ đọc 7 ngày, sau đó gỡ.
     5. Khôi phục thử PostgreSQL từ R2 **trước** khi xoá `winkey-pg-backup` trên Garage.
   - **Rào chắn chi phí:**
     - exporter `r2-usage` (Cloudflare GraphQL Analytics, token chỉ đọc) mỗi 15 phút xuất dung lượng, Class A, Class B và **chi phí dự báo cuối tháng**;
     - cảnh báo khi dự báo vượt **5 USD** (warning) và **10 USD** (critical), hoặc khi dùng hết 85% bất kỳ hạn mức miễn phí nào;
     - bật billing notification của Cloudflare.

     Ước tính hiện tại: dưới 10 GB, nằm trong free tier.

2. **edge-1 về 2 OCPU / 12 GB (phương án A).**
   - Thứ tự: (1) đo; (2) chuyển storage sang R2; (3) gỡ Garage; (4) hạ requests/limits; (5) resize; (6) kiểm tra.
   - **Đo** 7 ngày trên VictoriaMetrics: đỉnh RAM và CPU của host, gồm 4 site cũ, 7 app Node, PostgreSQL host và Cockpit, cùng của từng pod Winkey.
   - **Hạ requests/limits**, đặt ngân sách Winkey mới theo số đo. Mục tiêu: tổng requests ≤ 1 vCPU / 5 GB và host còn ≥ 1.5 GB RAM trống ở đỉnh. Chỉnh `shared_buffers` của CNPG, giới hạn JetStream và `maxmemory` của Valkey cho khớp.
   - **Resize** trong khung giờ đã báo trước theo ADR-014 (site cũ ngừng khoảng 5–10 phút): OCI Console → Stop → Edit shape: 2 OCPU / 12 GB → Start. Smoke test 4 site cũ và Winkey.
   - **Rollback:** resize lại 4 / 24 (có thể bị tính phí trong lúc đó).
   - **Nếu số đo cho thấy không vừa:** thêm tenancy Oracle thứ hai làm edge-2 (2 / 12 miễn phí) chứ không dồn workload người dùng sang máy gia đình.

3. **Node gia đình `tag:worker` (tên `node-NN`), ngoài k3s.** Năm luật cứng:
   - không phục vụ traffic public;
   - không chạy primary của dịch vụ stateful;
   - không tham gia k3s/etcd/NATS;
   - chỉ **kéo** việc từ queue hoặc kéo dữ liệu về;
   - mất node chỉ làm chậm hoặc thiếu một bản sao.

   Mỗi node khai báo vai trò trong inventory:
   - **vault** (đĩa ≥ 500 GB, ở nhà khác gpu-01): hằng đêm `rclone sync` R2 → đĩa local, bằng token R2 chỉ đọc. Gồm `winkey-media`, `winkey-pg-backup`, `winkey-backup`, cùng bản sao raw archive của gpu-01. Giữ 14 ngày. Mỗi tháng khôi phục thử PostgreSQL một lần. Đây là bản sao ngoài Cloudflare.
   - **cpu-transcode** (≥ 4 nhân **AVX2**, ≥ 8 GB RAM, uplink ≥ 20 Mbps): cùng binary transcoder, x264, `WORKER_CONCURRENCY=1`. Chỉ nhận job đã chờ quá `OVERFLOW_AFTER`, hoặc khi heartbeat của gpu-01 mất. Bật khi số liệu queue cho thấy cần; thiết kế chi tiết là task V6.
   - **probe** (máy nào cũng chạy được): blackbox exporter đo `winkey.vn` và `media.winkey.vn` từ một nhà mạng khác.
   - **Không dùng cho:** CI runner, DB, NATS, ingress.

4. **Mở rộng bằng inventory, không bằng thiết kế lại.**
   - **Ba lớp node**, mỗi lớp một tag Tailscale và một nhóm Ansible:

     | Lớp | Tag | Tên | Ghi chú |
     |---|---|---|---|
     | Oracle VM | `tag:edge` | `edge-N` | 1 tenancy = 1 VM 2 OCPU / 12 GB miễn phí |
     | Máy GPU | `tag:gpu` | `gpu-NN` | |
     | Máy gia đình | `tag:worker` | `node-NN` | Vai trò khai trong `host_vars`: `winkey_roles: [vault, cpu_transcode, probe]` |

   - **Thêm node** = thêm một dòng inventory → `tailscale up --ssh --advertise-tags=<tag> --hostname=<tên>` → chạy playbook theo lớp. Không sửa code, không sửa ADR.
   - **Edge:** dữ liệu media đã nằm trên R2, nên thêm hoặc bớt edge **không cần chuyển dữ liệu**.
     - edge-2/3: join làm k3s server (HA 3), từ edge-4 trở đi làm agent;
     - thêm A record cho `winkey.vn` và `media`, mỗi node có nginx gate riêng;
     - nâng `instances` của CNPG và replicas của NATS khi có ≥ 3 edge.
   - **GPU/worker:** queue NATS là pull, nên thêm máy chỉ là thêm consumer. Gắn nhãn năng lực qua env (`WORKER_CLASS=gpu|cpu`).
   - **Mọi node** chạy node-exporter + Alloy, đẩy metrics và log về gpu-01 (ADR-029). Dashboard lọc theo `instance` và tag.

5. **Tailscale.** Thêm `tag:worker` vào `tagOwners`, rồi thêm các luật sau:

   | Nguồn | Đích | Dùng cho |
   |---|---|---|
   | `tag:worker` | `tag:gpu:8428,3100` | Đẩy metrics và log |
   | `tag:worker` | `tag:edge:30422,30432` | Chỉ thêm khi bật cpu-transcode |
   | `tag:gpu` | `tag:worker:22` | Chỉ để rsync raw archive sang vault, user `winkey-vault` không có shell |
   | `autogroup:admin` | `tag:worker` (SSH) | Quản trị |

   Sau khi chuyển sang R2, gỡ luật `tag:gpu → tag:edge:30900`. vault kéo dữ liệu từ R2 qua internet, không cần luật vào edge.

**Hệ quả.**
- edge-1 nhẹ đi: không còn Garage, không còn băng thông upload, không còn chứa video. Vừa hạn mức miễn phí.
- Dung lượng lưu trữ không còn bị giới hạn bởi đĩa edge-1. Chi phí tăng tuyến tính và rất nhỏ (100 GB ≈ 1.35 USD/tháng sau 10 GB miễn phí). Có cảnh báo chi phí trước khi vượt ngưỡng user đặt.
- Backup có ba nơi: R2, vault ở nhà khác, gpu-01.
- Phụ thuộc thêm vào Cloudflare. Bù lại bằng việc vault giữ bản sao đầy đủ, và vì code chỉ dùng S3 cơ bản nên vẫn đổi được sang nhà cung cấp khác chỉ bằng cấu hình.
- Thay một phần ADR-004 (Garage → R2; luật "chỉ S3 cơ bản" giữ nguyên) và ADR-013 §0 (Garage). ADR-005/017 giữ nguyên, chỉ đổi origin.
- Task:
  - **INF-0** (Antigravity 2): kiểm kê node-01 + đo edge-1 trong 7 ngày.
  - **INF-R2a** (Antigravity 2): bucket, token, CORS, lifecycle, `media-origin`, chuyển dữ liệu, chuyển barman, khôi phục thử.
  - **INF-R2b** (Antigravity 2): exporter `r2-usage` + cảnh báo.
  - **INF-W1** (Antigravity 2): node-01 làm vault + probe.
  - **INF-E1** (Antigravity 2): hạ requests và resize edge-1.
  - **V6** (ChatGPT): chỉ khi số liệu yêu cầu.

**Phụ lục ADR-032 (2026-10-05) — lộ trình 3 edge + 3 node; không đặt Garage trên edge.**
- **Đã cân nhắc và bác bỏ: Garage làm tầng nóng trên edge, R2 làm tầng lạnh.**
  - Muốn ghi được khi 1 edge chết thì phải dùng RF 3 (quorum ghi 2/3), khi đó dung lượng dùng được chỉ bằng node nhỏ nhất (edge-1, khoảng 70 GB). Dùng RF 2 thì một edge chết là một phần lượt ghi lỗi.
  - Khoản tiết kiệm chỉ khoảng 1–2.6 USD/tháng tiền R2, đổi lại cần job chuyển tầng, phải sửa code để xoá ở hai nơi, và tốn RAM trên edge vốn chỉ có 12 GB.
- **Tầng nóng = nginx `proxy_cache` trên mỗi edge** (ADR-005/017, cùng một Ansible role):
  - edge-1: sau khi gỡ Garage, chuyển cache từ `/` (10 GB) sang LV data, khoảng 40 GB;
  - edge-2/3: khoảng 100 GB mỗi node;
  - `proxy_cache_lock on`, `inactive=30d`.

  Video bị xoá hoặc bị ẩn vẫn bị `auth_request` chặn dù file còn trong cache. Không có dữ liệu nào chỉ nằm duy nhất trên một edge.
- **Tầng sao lưu = cụm Garage ở các nhà, khi có ≥ 3 node `tag:worker` có đĩa.**
  - Mỗi nhà là một zone. RF 2, chế độ `consistent`: quorum ghi 2, quorum đọc 1. Job sao lưu là batch nên có thể retry.
  - Cụm này thay thư mục rclone của vai trò vault (vai trò mới: `garage_vault`).
  - Không nằm trên đường ghi của người dùng. S3 và RPC chỉ mở trên tailnet: thêm luật `tag:worker → tag:worker:3900,3901`.
  - Trước khi đủ 3 node, vault vẫn là `rclone sync` ra đĩa local như §3.
- **Tầng lạnh thật** (chuyển video cũ, ít xem từ R2 sang cụm Garage gia đình) chỉ xét khi `r2-usage` dự báo **> 10 USD/tháng hai tháng liền** (khoảng 700 GB). Khi đó viết một ADR riêng, có số liệu phân bố lượt xem.
- **Cập nhật 2026-10-05: tạm triển khai chưa có node-01** (user sẽ bổ sung sau). Trong thời gian chưa có máy gia đình nào, **gpu-01 làm vault tạm**:
  - timer systemd chạy dưới user `winkey` chạy hằng đêm (user cài unit bằng sudo như với transcoder; agent không dùng sudo) `rclone sync` R2 → `/mnt/hdd_storage/winkey/vault`, bằng token R2 chỉ đọc. Gồm `winkey-media`, `winkey-pg-backup`, `winkey-backup`;
  - giữ 14 ngày; mỗi tháng khôi phục thử PostgreSQL một lần.

  Như vậy vẫn có một bản sao ngoài Cloudflare. Khi node-01 tham gia thì INF-W1 chuyển vai trò vault sang node-01 (ở nhà khác) và gỡ vault tạm trên gpu-01.

### ADR-033 — Trang phim (CIN1): giao diện kiểu web phim trên dữ liệu sẵn có, không đổi contract
**Bối cảnh.** User muốn có "Trang phim": cùng các danh sách video hiện có, nhưng trình bày như một web phim (banner lớn, các hàng cuộn ngang, thẻ phóng to khi rê chuột) để hút người xem. Mô hình dữ liệu hiện chưa có thể loại, năm, phim bộ/tập hay poster dọc. Thumbnail là ảnh 16:9, rộng tối đa 1280 px (`BuildThumbnailArgs`).
**Quyết định.**
- **CIN1 chỉ làm ở web**, không đổi contract, không migration, không thêm service. Route `/phim` (cả hai locale, ví dụ `/en/phim`), mục "Phim" trên sidebar, ngay dưới "Trang chủ".
- **Nguồn của từng phần trên trang**, đều là endpoint đang có:

  | Phần | Endpoint | `surface` (ADR-030) |
  |---|---|---|
  | Banner lớn (5 video, tự chuyển) | `listVideos?sort=trending&limit=5`, rỗng thì `newest`; `getVideo` cho video đang hiện (mô tả, `playback`) | `trending` (hoặc `latest` khi lấy từ newest) |
  | Xem tiếp | vị trí xem trong `localStorage` + `batchGetVideos` | `other` |
  | Top 10 hôm nay | `listVideos?sort=trending&limit=10` | `trending` |
  | Dành cho bạn (đã đăng nhập) | `getRecommendedFeed` | `for_you` |
  | Mới cập nhật | `listVideos?sort=newest` | `latest` |
  | Từ kênh bạn theo dõi (đã đăng nhập) | `getSubscriptionFeed` | `subscriptions` |
  | Hàng biên tập | danh sách phát `PUBLIC` của kênh tuyển chọn (`/v1/users/{handle}` → `listChannelPlaylists` → items → `batchGetVideos`) | `playlist` |
  | Tương tự (trong hộp chi tiết) | `listRelatedVideos` | `up_next` |

- **Tuyển chọn bằng danh sách phát.** Kênh tuyển chọn đặt bằng biến runtime `CINEMA_CURATOR_HANDLE` của web (server component đọc rồi truyền xuống, để không phải build lại image khi đổi). Mỗi danh sách phát `PUBLIC` của kênh đó là một hàng, theo thứ tự `listChannelPlaylists` (mới sửa gần nhất lên trước). Tối đa 8 hàng. Biến trống thì không có hàng biên tập. Người vận hành chỉ cần tạo hoặc sửa danh sách phát bằng UI có sẵn, không cần code hay migration.
- **Xem tiếp chỉ lưu trên máy** (localStorage). Player ghi thêm chỉ mục `winkey.continue_watching`: tối đa 20 mục `{id, t, d, at}`, mục mới nhất đứng đầu. Bỏ mục khi đã xem ≥ 95 % hoặc khi video không còn đọc được. Không đồng bộ giữa các thiết bị. Đồng bộ phía server cần contract và bảng mới, nên để CIN2.
- **Xem trước trong banner:** sau 3 s đứng yên, banner phát video đang hiện, tắt tiếng, ở rendition thấp nhất. Dừng khi banner ra khỏi màn hình, khi tab bị ẩn, hoặc sau 30 s.
  - Không phát trên màn hình nhỏ, khi `prefers-reduced-motion` hoặc `Save-Data`.
  - Bản xem trước **không** gửi heartbeat và không gọi `recordView`, để không làm sai số QoE (QOE1) và lượt xem.
  - Thẻ trong các hàng **không** phát video khi rê chuột: chỉ phóng to và hiện thông tin. Như vậy không tốn băng thông edge và không phải gọi `getVideo` cho từng thẻ.
- **Giao diện:** nền tối điện ảnh cố định cho riêng route này (không theo theme sáng/tối), thẻ 16:9.
  - Mỗi hàng cuộn ngang: snap, có nút trái/phải trên desktop, vuốt trên điện thoại.
  - Hàng chỉ tải khi sắp vào màn hình (IntersectionObserver), mỗi hàng ≤ 20 video. Hàng rỗng hoặc lỗi thì ẩn, không làm hỏng cả trang.
  - Bấm thẻ mở hộp chi tiết, đồng bộ với `?v=<id>` để dùng được nút back và chia sẻ link. Nút "Xem ngay" dẫn tới trang xem hiện có, kèm `?src=` đúng surface. Bấm vào trang xem vẫn dùng player hiện có.
**Hệ quả.**
- Có ngay một trang "web phim" mà backend không phải làm gì. Edge có thêm vài request API mỗi lượt vào trang, phần lớn được cache 60 s (trending, ẩn danh).
- Thể loại, năm, phim bộ/tập, poster dọc và xem tiếp đồng bộ giữa thiết bị là **CIN2**: cần contract (`Video.genres`, collection kiểu series, ảnh poster), migration và việc của transcoder. Chỉ làm khi user muốn, sau khi CIN1 đã chạy.
- Lượt phát từ Trang phim mang các surface sẵn có, nên chưa tách được hiệu quả riêng của trang này. Nếu cần đo, thêm `cinema` vào enum `surface` là một thay đổi contract nhỏ, cộng thêm (giống R2-ab).
- **Phần bổ sung 2026-10-07: Trang phim là trang chủ.** User quyết định trang phim thay trang chủ hiện tại. Bản thiết kế có độ chi tiết cao nằm ở `docs/design/cinema-home/`, gồm desktop, hộp chi tiết, mobile, trạng thái thẻ và token. Bản thiết kế là chuẩn khi brief và hình khác nhau ở chi tiết trình bày; brief là chuẩn về dữ liệu và hành vi.
  - **Route.**
    - `/` (và `/en`) là trang phim.
    - Trang chủ dạng lưới theo tab cũ chuyển sang `/kham-pha` ("Khám phá"), giữ nguyên tab và `surface`.
    - `/?tab=<x>` chuyển hướng 308 sang `/kham-pha?tab=<x>`, để link cũ vẫn chạy.
    - `/phim` chuyển hướng 308 về `/`.
  - **Vỏ trang riêng (`CinemaShell`), chỉ dùng cho `/`.** Các trang khác giữ `Shell` hiện tại.
    - Desktop không có sidebar. Thanh trên trong suốt, nằm đè lên banner, và chuyển sang nền đặc `#0A0A0D` khi cuộn quá 64 px.
    - Thanh trên có các link: Trang chủ `/`, Thịnh hành `/trending`, Khám phá `/kham-pha`, Đang theo dõi `/feed/subscriptions` (khi đã đăng nhập), Danh sách của tôi `/playlist/watch-later` (khi đã đăng nhập).
    - Bên phải thanh trên: tìm kiếm, tải lên, chuông thông báo, menu tài khoản. Studio và Admin nằm trong menu tài khoản.
    - Mobile dưới 768 px dùng thanh tab dưới đáy: Trang chủ, Khám phá, Tải lên, Thông báo, Tôi.
    - Banner nhắc xác minh email vẫn hiện, ngay dưới thanh trên.
  - **Chân trang của vỏ phim** có Điều khoản, Quyền riêng tư, Quy tắc cộng đồng và Góp ý beta (ADR-034).
  - `surface` (ADR-030) của từng hàng giữ nguyên như bảng ở trên.
  - **SEO.** `/` có `<title>` "Winkey – Xem video, phim và clip", meta description và Open Graph lấy từ banner đầu. Trang render phía server phần khung và banner đầu (dữ liệu trending ẩn danh, cache 60 s), còn các hàng chỉ tải khi sắp vào màn hình.

### ADR-034 — Beta kín: mã mời, các bước bắt buộc trước khi mời người dùng
**Bối cảnh.** Chức năng P2 đã chạy trên production. User muốn chạy beta và giao kiến trúc sư tự quyết các việc tồn đọng. Các tiêu chí hiện có: P2 cần LT2 (1.000 người xem, rebuffer < 1 %) và 50 beta user. SEC0 vẫn còn mở. #249 (tài khoản test) chưa làm. LEGAL (ví dụ Nghị định 147/2024/NĐ-CP) là nghĩa vụ của một mạng xã hội **mở công khai**.
**Quyết định.**
- **Beta là beta kín, có mã mời**, tối đa khoảng 100 tài khoản mới. Chưa quảng bá công khai. Trang xem và nội dung công khai vẫn ai cũng xem được, kể cả không đăng nhập (giống hôm nay). Chỉ việc **tạo tài khoản mới** cần mã mời.
- **Mã mời (BETA1).**
  - auth-svc có `REGISTRATION_MODE` = `open` | `invite` (mặc định `open`) và `INVITE_CODES`. `INVITE_CODES` là Secret, gồm các mã cách nhau bằng dấu phẩy, mỗi mã 12–64 ký tự `[A-Za-z0-9-]`; mã không hợp lệ thì service không khởi động.
  - So khớp bằng `timingSafeEqual` trên SHA-256 của mã. Không giới hạn số lần dùng, không bảng mới, không migration. Đổi hoặc thu hồi mã bằng cách đổi Secret rồi restart; tài khoản đã tạo không bị ảnh hưởng.
  - Mỗi đợt mời một mã, ví dụ `wk-beta1-…`, để biết ai đến từ đợt nào: log ghi **chỉ số thứ tự** của mã (`invite_index`), không bao giờ ghi bản thân mã.
  - Contract: `RegisterRequest.invite_code`, lỗi `403` `INVITE_REQUIRED` / `INVITE_INVALID`, `googleStart?invite_code=`, callback chuyển về `/register?error=…`.
  - Kiểm mã **trước** mọi kiểm tra trùng email hoặc handle (không lộ tài khoản). Rate limit hiện có vẫn áp dụng.
  - Web: link mời `https://winkey.vn/register?invite=<mã>` điền sẵn mã. Nút Google mang mã theo. Thông báo lỗi bằng tiếng Việt.
- **Văn bản pháp lý bản beta.**
  - Kiến trúc sư soạn `docs/legal/` (Điều khoản sử dụng, Chính sách quyền riêng tư theo Nghị định 13/2023/NĐ-CP, Quy tắc cộng đồng), có chỗ trống `[…]` cho thông tin chủ thể vận hành mà user phải điền.
  - Web hiển thị nguyên văn ở `/dieu-khoan`, `/quyen-rieng-tu`, `/quy-tac-cong-dong`. Form đăng ký có ô bắt buộc "Tôi đồng ý…" (chỉ ở client; contract không lưu).
  - **Trước khi mở công khai** user vẫn phải nhờ tư vấn pháp lý rà lại (task LEGAL giữ nguyên, và chặn public launch chứ không chặn beta kín).
- **Góp ý beta:** link ở chân trang trỏ tới `FEEDBACK_URL`, một biến runtime của web, ví dụ Google Form hoặc `mailto:`. Biến trống thì ẩn link.
- **Bắt buộc trước khi gửi mã mời đầu tiên.** Thứ tự không đổi; việc nào song song được thì làm song song.
  1. **SEC0** (Antigravity 2):
     - Cockpit 9090 và cổng 7890 chỉ mở qua `tailscale0`, đóng khỏi public;
     - PostgreSQL host chỉ nghe `127.0.0.1` (và giao diện cho pod nếu cần, như hiện tại);
     - SSH chỉ dùng key, không cho đăng nhập root;
     - `www.winkey.vn` có DNS và cert, chuyển hướng 301 về `winkey.vn`.
  2. **#249** (Antigravity 2): khoá (suspend) mọi tài khoản test, xoá hẳn những tài khoản còn biết mật khẩu. Chỉ giữ tài khoản của user, tức các tài khoản có role `admin` mà user xác nhận là của mình. Không có ngoại lệ nào khác.
  3. **BETA1** chạy trên production với `REGISTRATION_MODE=invite`.
  4. **CIN1** (trang chủ phim) và **BETA1-web** (form mời, trang pháp lý, chân trang) đã deploy.
  5. **LT2** đạt: 1.000 người xem HLS đồng thời, rebuffer < 1 %, lỗi HTTP < 1 %, 4 site cũ không sập.
     - Máy tạo tải là **một VM OCI A1 tạm**, dùng phần free tier còn lại (2 OCPU / 12 GB, cùng region). Máy nhà không đủ băng thông tải xuống: 1.000 người xem cần khoảng 1,5 Gbit/s.
     - Chạy trong khung **02:00–03:30 giờ Việt Nam**, từ đêm 09/10/2026.
     - Xoá VM ngay sau khi chạy.
     - Tài khoản ghi (comment, like) là ≤ 20 tài khoản `lt2_*`, tạo bằng một mã mời riêng và tự xoá (`deleteMe`) ngay sau khi chạy.
     - Không upload video mới: dùng các video công khai đang có.
- **Không chặn beta kín:** LEGAL (chặn public launch), QOE3, follow-up QOE2, R2-ab, node-01. Sonnet và Sonnet 2 vẫn tạm dừng, vì ChatGPT đủ cho phần Go.
**Hệ quả.**
- Beta có cổng vào kiểm soát được mà không cần bảng hay migration. Đổi lại, mã có thể bị chia sẻ lại, nên giữ mỗi đợt nhỏ và thay mã khi cần.
- Smoke test và load test tạo tài khoản trên production phải dùng một mã mời riêng, chỉ để trên host (`read -rs`).
- Mở công khai về sau chỉ cần đặt `REGISTRATION_MODE=open`, sau khi LEGAL xong.
- **Phần bổ sung 2026-10-10 (Opus nhận lại vai trò kiến trúc sư).**
  - **Mời đợt 1 ngay, tối đa 20 người.** SEC0, #249, BETA1, CIN1, BETA1-web và văn bản pháp lý (hiệu lực 10/10/2026) đều đã chạy trên production. 20 người dùng thấp hơn xa mức tải LT2 cần chứng minh. LT2 giờ là điều kiện để mời **đợt 2** (vượt 20 người) và để kết thúc P2, không còn chặn đợt 1.
  - **Thu hẹp LT2 xuống chỉ đo người xem.**
    - Chỉ còn người xem HLS ẩn danh, cộng một luồng API **chỉ đọc**, cũng ẩn danh: `listVideos`, `getVideo`, `listRelatedVideos`, `listComments`, `searchVideos`, `listCinemaCatalog`.
    - Không tạo tài khoản, không comment, không like. Vì vậy không còn gì phải dọn sau khi chạy.
    - Lý do: tiêu chí P2 là người xem đồng thời và rebuffer. Phần ghi dữ liệu chỉ chiếm 5 % lưu lượng, nhưng lại sinh ra hầu hết rủi ro và độ phức tạp: PR #263 đã lên +2 683 dòng mà vẫn chưa an toàn để chạy.
    - Khi nào cần đo phần ghi, viết một ADR riêng.
  - **Watchdog** `deploy/lt2/` (#279) là cơ chế dừng khẩn cấp.
  - **Tiêu chí đạt:** rebuffer **gộp, không tính lúc tua** < 1 %, `http_req_failed` < 1 %, 4 site cũ luôn trả 200, không lần dừng khẩn cấp nào.
  - **Khung giờ:** 02:00–03:30 giờ Việt Nam, sớm nhất là đêm 12/10/2026.
  - **Đội ngũ:** ChatGPT Astra và ChatGPT/Codex ("Sol") tạm rời dự án. Các thư mục Go (`services/video`, `analytics`, `upload`, `transcoder`, `libs/go`) hiện không có chủ, vì Sonnet và Sonnet 2 vẫn tạm dừng. Thiết kế mới phải tránh sửa Go. Nếu bắt buộc phải sửa, user quyết định cho Sonnet làm lại.

### ADR-035 — CIN2: "Bộ phim" từ danh sách phát, catalogue phim và phát theo tập
**Bối cảnh.** Ngày 2026-10-09 user yêu cầu trang phim có bộ/tập thật. Video đơn vẫn là phim một tập. Các tập của một bộ gom thành một thẻ. Trang xem có danh sách tập và chuyển tập dễ dàng. User chọn cách: **chủ danh sách đánh dấu "Bộ phim"**; không tự coi mọi playlist là phim.

Astra đã soạn một bản thiết kế (PR #285). Bản đó cần video-svc thêm một chế độ batch chỉ trả video PUBLIC (#286), tức là phải sửa Go, trong khi hiện không ai phụ trách phần Go. ADR này thay bản đó.
**Quyết định.**
- **Dữ liệu.** Migration 000019 thêm `social.playlists.is_series` (chỉ áp dụng cho REGULAR). Trigger chặn bộ phim chứa video của kênh khác (`SERIES_FOREIGN_ITEM`), áp dụng cả khi thêm mục lẫn khi bật cờ. Có index cho catalogue.
  - Không bảng mới, không event mới, không đọc chéo schema. social-svc **đã có** bảng phản chiếu `social.videos` (READY, `visibility`, `hidden`; video bị xoá thì mất dòng). Bảng này đủ để biết video nào **phát được**: PUBLIC, không bị ẩn, cùng chủ với danh sách.
- **API** (social-svc, contract `social.v1.yaml`, tag `cinema`):
  - `Playlist.is_series`, đặt được qua `createPlaylist` / `updatePlaylist`.
  - `GET /v1/cinema/catalog?kind=all|series|video`: thẻ `SERIES` hoặc `VIDEO`, mới nhất trước, cursor keyset, tối đa 48 thẻ mỗi trang, cache công khai 60 s.
  - `GET /v1/series/{id}/episodes`: danh sách tập phát được, đánh số từ 1, không có lỗ hổng số.
  - `GET /v1/series/{id}/episodes/{video_id}`: thông tin tập cho trang xem (số tập, tập trước, tập sau, cursor của trang chứa tập).
  - Mọi số đếm chỉ tính tập phát được, không bao giờ dùng `item_count`. Video thuộc một bộ PUBLIC thì không hiện thành phim lẻ.
- **Lấy tiêu đề và ảnh:** web gọi `batchGetVideos` như hiện nay, mỗi trang một lần. Danh sách id đã được social-svc lọc chỉ còn PUBLIC, nên dùng nguyên batch hiện có, **không sửa video-svc**.
  - Có một trường hợp lệch ngắn: chủ vừa đổi video sang UNLISTED mà event chưa tới, thì thẻ vẫn hiện vài giây. Chấp nhận được, vì chính chủ đã đặt video đó vào một bộ công khai.
  - Khi phát, video-svc vẫn kiểm tra quyền lần cuối.
- **Web.**
  - Trang chủ phim có các hàng "Phim bộ", "Phim lẻ", "Mới thêm" lấy từ catalogue, nằm cạnh các hàng CIN1 hiện có (Xem tiếp, Top 10, Dành cho bạn).
  - Thẻ bộ: ảnh của tập đầu, tiêu đề danh sách, "N tập".
  - Hộp chi tiết bộ: mô tả và danh sách tập. "Xem ngay" mở tập đầu.
  - Trang xem `?playlist=<id>`:
    - desktop có cột tập bên phải, mobile có danh sách tập dưới player; có nút "Tập trước" / "Tập sau";
    - ngữ cảnh bộ giữ nguyên qua refresh, back và link chia sẻ;
    - API trả `EPISODE_NOT_FOUND` thì phát video như bình thường, không có ngữ cảnh bộ;
    - không tự chuyển sang tập kế tiếp (để CIN3 nếu cần).
  - Đổi tập là kết thúc phiên phát cũ (heartbeat `end`) rồi mới bắt đầu phiên mới. `surface` = `playlist`.
  - Trong form danh sách phát có ô chọn "Bộ phim".
- **Không làm trong CIN2:** thể loại, năm, poster dọc, xem tiếp đồng bộ server, tự phát tập kế.
**Phân công.**
- Kiến trúc sư: contract, migration, api-client (cùng PR với ADR này).
- Antigravity 3: social-svc.
- Antigravity 1: web.
- Antigravity 2: route `/v1/cinema` và `/v1/series`, rồi deploy.
- Không agent Go nào phải làm gì.
**Hệ quả.** Có bộ/tập thật mà không cần service mới hay sửa Go. Đổi lại, thứ tự tập phụ thuộc thứ tự chủ danh sách sắp xếp, và độ chính xác của catalogue phụ thuộc độ trễ của event (thường vài giây).

### ADR-036 — Công cụ cho creator và SEO: sửa video, đưa video lên Google, thẻ (tag)
**Bối cảnh.** Ngày 2026-10-10 user báo ba vấn đề:
1. Video đã đăng thì không sửa được thông tin.
2. Không thêm video vào danh sách phát được.
3. Chưa có thẻ (tag/từ khoá), và chưa có hỗ trợ SEO để video lên Google.

Phần backend đã có `updateVideo` (`PATCH /v1/videos/{id}`: tiêu đề, mô tả, chế độ hiển thị), nhưng web chưa có giao diện dùng nó. Hộp "Lưu" trên trang xem có sẵn trong code. Lỗi "không thêm được" phải tra trên production.
**Quyết định.**
- **ST1-web (Antigravity 1):** trang sửa video trong Studio, gọi `updateVideo`. Mở từ danh sách video trong Studio và từ nút "Chỉnh sửa" trên trang xem (chỉ chủ video thấy). Làm trước PL2-web.
- **SEO1-web (Antigravity 1):** chỉ sửa web, không đổi contract.
  - Trang xem render phía server với `<title>`, meta description, canonical, Open Graph `video.other` và **JSON-LD `VideoObject`**: `name`, `description`, `thumbnailUrl`, `uploadDate`, `duration` (ISO 8601), `embedUrl`, `interactionStatistic` (lượt xem). Có thêm `BreadcrumbList`.
  - Video không công khai đặt `noindex`.
  - `/sitemap.xml` và sitemap video liệt kê video PUBLIC và trang kênh, sinh phía server qua `API_INTERNAL_URL`, tối đa 50 000 URL mỗi file. `/robots.txt` trỏ tới sitemap và chặn `/studio`, `/admin`, `/upload`, `/thu-vien`, `/settings`.
  - User xác minh tên miền trên Google Search Console bằng bản ghi DNS TXT (Cloudflare), rồi nộp sitemap.
- **Thẻ (TAG1):** Google **bỏ qua** `<meta name="keywords">`. Thẻ không giúp lên Google; thứ hạng đến từ tiêu đề, mô tả, dữ liệu có cấu trúc, sitemap và lượt xem.
  - Giá trị thật của thẻ là cho tìm kiếm trong Winkey và cho video liên quan. Cả hai đều nằm ở video-svc (Go), cùng migration `media.videos.tags` và FTS.
  - Thư mục Go hiện **không có chủ**, nên TAG1 chờ user quyết định có cho Sonnet làm lại không. **Cập nhật 2026-10-10:** user giao luôn phần Go cho kiến trúc sư. TAG1 gồm:
    - migration 000020: cột `media.videos.tags` (tối đa 10 thẻ), thẻ đưa vào `search_vector` với trọng số A;
    - `Video.tags` và `UpdateVideoRequest.tags`;
    - chuẩn hoá thẻ: cắt khoảng trắng, bỏ trùng không phân biệt hoa thường và dấu;
    - video liên quan ưu tiên thẻ.
    Giao diện nhập thẻ thuộc ST1-web.
  - Trong lúc chờ, SEO1 đưa từ khoá vào mô tả, việc này có tác dụng thật.
- **Lỗi thêm vào danh sách:** Antigravity 2 tra log production của social-svc (`POST /v1/playlists/*/items`, `GET .../playlist-membership`) và gateway, rồi báo nguyên nhân trước khi giao sửa.
**Hệ quả.** Creator sửa được video và video có thể lên Google mà không cần sửa Go. Thẻ hoãn lại, nhưng ít ảnh hưởng tới SEO.
