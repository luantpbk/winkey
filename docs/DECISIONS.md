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

**Bổ sung 2026-10-17 (thời gian ân hạn khi refresh, kiến trúc sư).**

*Bối cảnh.* Sim (#377) cho thấy người dùng bị đăng xuất ngang trong một phiên trình duyệt bình thường. Client chỉ gửi một refresh mỗi lúc (single-flight, Web Locks), nhưng nếu trang chuyển hoặc reload khi `POST /v1/auth/refresh` chưa xong thì trình duyệt bỏ response. auth-svc đã xoay token, nhưng cookie chứa token con không bao giờ được lưu. Lần tải trang sau gửi lại token cũ, auth-svc coi là dùng lại, thu hồi cả family, và người dùng bị `401` ở mọi nơi.

*Quyết định.* Token cha `T` có `rotated_at` khác null được coi là **thử lại hợp lệ** (không phải dùng lại) khi thoả cả ba điều kiện:
1. `now() - T.rotated_at <= REFRESH_REUSE_GRACE` (mặc định **30 s**, tối đa 60 s, biến môi trường của auth-svc);
2. **không** token con nào của `T` (`parent_id = T.id`) đã được dùng (`rotated_at IS NULL` cho mọi con). Token con đã bị thu hồi mà chưa dùng, ví dụ do một lần thử lại trước đó, không chặn lần thử lại tiếp theo trong cửa sổ;
3. `T` chưa hết hạn và chưa bị thu hồi (đã kiểm sẵn).

Khi đó, trong cùng giao dịch đang giữ khoá dòng của `T` (`FOR UPDATE`): đặt `revoked_at = now()` cho các token con chưa dùng, rồi cấp một token con mới cho `T` (cùng family, `parent_id = T.id`) và trả về như một lần refresh thường. Log ở mức `info` với `refresh retry within grace`, kèm `family_id` và `token_id` (không log token), và tăng metric `auth_refresh_total{result="grace_retry"}`.

Ngoài cửa sổ ân hạn, hoặc khi đã có một token con được dùng (hai người cùng giữ token, dấu hiệu bị lộ), thì giữ nguyên hành vi cũ: thu hồi cả family và ghi khoá `sid` vào Valkey.

*Đồng thời.* Một lần dùng token con hợp lệ cũng `SELECT … FOR UPDATE` dòng con. Thao tác revoke ở trên cũng lấy khoá dòng đó, nên hai việc luôn chạy tuần tự:
- con được xoay trước: điều kiện 2 sai, coi là dùng lại;
- con bị revoke trước: lần dùng con trả `401`, đúng vì đó là token chưa ai nhận.

Không cần migration, vì `parent_id` đã có.

*Hệ quả.* Kẻ trộm cầm token cha trong ≤ 30 s mà token con chưa ai dùng sẽ được cấp phiên. Rủi ro này tương đương việc trộm được token con, và là đánh đổi phổ biến (thời gian ân hạn khi xoay refresh token). Người dùng không còn bị đăng xuất vì chuyển trang đúng lúc refresh.

**Thực hiện:** Antigravity 3 (`services/auth`), gồm test đồng thời trên Postgres thật:
- thử lại trong cửa sổ ân hạn thì được;
- thử lại sau cửa sổ thì bị coi là dùng lại;
- con đã dùng rồi cha bị dùng lại thì bị coi là dùng lại;
- hai lần thử lại cùng lúc thì chỉ đúng một token con còn sống.

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


**Bổ sung 2026-10-13 (giờ chạy LT2).**
- User quyết định chạy LT2 ban ngày hôm nay, vì đang beta với dưới 20 người dùng thật.
- `loadtest/lt2-run.sh` nhận `LT2_DAYTIME_APPROVED_DATE=YYYY-MM-DD`. Giá trị này chỉ mở cổng thời gian đúng ngày đó theo giờ Việt Nam.
- Ngày khác, giá trị sai định dạng hoặc thiếu biến: cổng 02:00–03:30 vẫn đóng.
- Watchdog vẫn bắt buộc.
- Mỗi lần chạy ban ngày cần user duyệt lại, kèm go-ahead của kiến trúc sư.

**Bổ sung 2026-10-13 (kết quả LT2, user quyết định).** Lần 3 (#355, main `1d414e4`, chạy ban ngày):
- Từ 50 tới khoảng 850 người xem đồng thời: 0 % lỗi HLS, rebuffer 0,33 %.
- Khoảng 930 người xem: CPU edge-1 lên 99 %. Segment trả HTTP 500, lỗi đạt 9,2 % trong 60 giây, watchdog dừng test. RAM vẫn còn trống hơn 7 GB.

Quyết định:
- User **chấp nhận năng lực khoảng 850 người xem đồng thời** làm điều kiện LT2, và **mở mời đợt 2**. Mức này đủ dư cho beta vài trăm người.
- Đạt 1.000 trở thành việc tối ưu riêng (#358, Antigravity 2): tìm chỗ CPU bị tốn (TLS, chuỗi proxy, cache segment), tìm vì sao quá tải lại trả 500 thay vì chậm đi, rồi chạy lại LT2.

Sửa harness trong ngày:
- #356: site cũ phải lỗi 2 lần liên tiếp thì watchdog mới dừng.
- #357: 429 theo IP của `/v1/search` từ một máy tạo tải không còn bị tính là lỗi.
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

### ADR-037 — SEO theo thẻ: trang `/tag/<slug>` cho Google (SEO2)
**Bối cảnh.** Ngày 2026-10-11 user yêu cầu: khi người dùng tìm trên Google bằng từ khoá trùng với thẻ của video, video phải có cơ hội hiện lên. Theo ADR-036, thẻ chỉ phục vụ tìm kiếm và video liên quan trong Winkey: trang xem không hiển thị thẻ, JSON-LD và sitemap cũng không có. Google bỏ qua meta keywords. Cách duy nhất để xếp hạng theo một từ khoá là có **một trang thật, lập chỉ mục được, nói về đúng từ khoá đó**, và được liên kết nội bộ.

Cùng ngày phát hiện thêm: `sitemap.xml` được Next prerender lúc build image (`revalidate = 3600`). Trong CI không có API, nên image chứa sitemap rỗng. Antigravity 2 đã chữa tạm trên production bằng một ConfigMap viết tay (#306, bị từ chối vì sitemap sẽ đứng yên mãi).

**Quyết định.**
- **Slug do PostgreSQL tính, ở một chỗ duy nhất** (migration 000021):
  - Cột sinh `media.videos.tag_slugs = public.winkey_tag_slugs(tags)`, thẳng hàng với `tags`.
  - Slug = `winkey_fold` (chữ thường, bỏ dấu, đ → d), mỗi chuỗi ký tự ngoài `a-z0-9` thành `-`, cắt `-` hai đầu. Ví dụ `Phim ngắn`, `phim  NGẮN` và `phim-ngan` cùng là `phim-ngan`.
  - Thẻ không có chữ Latin hay chữ số thì slug là `''`, không có trang.
  - Có partial GIN index cùng điều kiện với feed công khai.
  - Go và web **không** tự cài lại thuật toán bỏ dấu, nên không thể lệch nhau.
- **API video-svc** (contract `video.v1.yaml`, nhóm `tag-pages`):
  - `listVideos?tag=`: nhận slug hoặc chữ; ghép được với `owner_id`, không ghép với `trending`; cursor gắn với tag.
  - `GET /v1/tags`: xếp hạng top-N theo `video_count`, `limit` ≤ 1000, `min_videos`, không có cursor. Dùng cho sitemap.
  - `GET /v1/tags/{tag}`: trả slug chuẩn, tên phổ biến nhất, số video, ngày đăng mới nhất; `404` nếu không có video công khai.
  - `Video.tag_slugs` để web dựng link.
  - Gateway: `/v1/tags` vào video-svc.
- **Web (Antigravity 1):**
  - **SEO1-fix (làm trước):** `sitemap.xml` render lúc có request (`dynamic = 'force-dynamic'`), dữ liệu API cache trong bộ nhớ 15 phút. API lỗi thì trả 503, hoặc bản cũ nếu còn. Không bao giờ trả sitemap thiếu video.
  - **SEO2-web:**
    - Trang `/tag/[slug]`, render phía server: `<title>` và `<h1>` chứa đúng tên thẻ, đoạn giới thiệu, lưới video với tiêu đề là link chữ, canonical `/tag/<slug>`.
    - Nếu đường dẫn không phải slug chuẩn thì redirect 308 về slug chuẩn.
    - JSON-LD `CollectionPage` + `ItemList` + `BreadcrumbList`.
    - `index` khi thẻ có ≥ 2 video công khai, `noindex,follow` khi chỉ có 1 (tránh trang mỏng); không có video thì 404.
    - Trang xem: thẻ hiện thành link chữ `#Tên` tới `/tag/<slug>`; JSON-LD `VideoObject.keywords`.
    - Sitemap thêm các thẻ có ≥ 2 video.
- **Không làm:** meta keywords; trang cho thẻ chỉ có 1 video được index; thêm `<video:tag>` vào sitemap (giá trị thấp).

**Hệ quả.**
- Mỗi thẻ được dùng nhiều trở thành một trang đích có thể xếp hạng cho từ khoá đó, và liên kết nội bộ hai chiều giữa trang thẻ và trang xem.
- Thứ hạng vẫn phụ thuộc chất lượng tiêu đề, mô tả và lượt xem; trang thẻ chỉ cho Google một trang phù hợp để xếp hạng, không bảo đảm vị trí.
- `listTags` gom thẻ của mọi video công khai mỗi lần gọi; ở quy mô beta thì ổn. Khi quá khoảng 50 000 video công khai, chuyển sang bảng tổng hợp (materialized view làm mới định kỳ).

### ADR-038 — Kiểm thử bằng người dùng giả lập trước người dùng thật (SIM1)
**Bối cảnh.** Ngày 2026-10-11 user yêu cầu: test sớm, không phải chờ khung đêm, và giả lập người dùng thay vì mời người thật. Chỉ khi hệ thống hoàn thiện mới test với người dùng thật.

Hiện trạng:
- Kiểm thử đầy đủ duy nhất là LT2 trên production (chỉ 02:00–03:30, chỉ người xem, 1 lần/đêm).
- `systest/` dựng toàn bộ stack bằng Docker và chạy 12 kịch bản API, nhưng không chạy tự động, không có web, không có hành trình qua giao diện thật.
- Unit test của web chạy với MSW (API giả), nên không bắt được lỗi giữa các service. Ví dụ lỗi "Lưu" do refresh token 401 chỉ lộ ra trên production.

**Quyết định.** Ba lớp, chạy bất cứ lúc nào, không cần người thật:
1. **Stack giả lập (staging tạm thời) trong CI.**
   - `systest` thêm `web-svc` thật, dựng trên runner GitHub `ubuntu-latest`.
   - Chạy theo lịch mỗi đêm, khi bấm tay (`workflow_dispatch`), và trên PR có nhãn `systest` hoặc đụng `services/**`, `apps/web/**`, `db/migrations/**`.
   - Stack bị huỷ sau mỗi lần chạy: không dọn dữ liệu, không ảnh hưởng production.
2. **Người dùng giả lập (persona) trên stack đó:**
   - **Seed** dữ liệu thực tế: khoảng 20 tài khoản, 40 video ngắn (ffmpeg `testsrc`, tiêu đề và thẻ tiếng Việt có dấu), danh sách phát, 2 bộ phim nhiều tập.
   - **Hành trình qua trình duyệt thật** (Playwright, không MSW), mỗi persona một kịch bản:
     - *Người xem ẩn danh:* trang chủ → trang thẻ → xem → tập tiếp theo → tìm kiếm không dấu.
     - *Người xem đăng nhập:* đăng ký bằng mã mời → "Lưu" vào danh sách → **làm mới phiên** (access token hết hạn giả lập) → "Lưu" tiếp → bình luận, thích.
     - *Creator:* tải video → chờ READY → sửa tiêu đề và thẻ → tạo "Bộ phim" → thêm tập → công khai → thấy ở trang chủ và trang thẻ.
     - *Kiểm duyệt viên:* báo cáo → ẩn → khôi phục.
     Kèm kiểm tra SEO trên HTML thật: canonical, JSON-LD, sitemap hợp lệ.
   - **Tải đồng thời** trên stack giả lập: k6 `api-mix` và `hls-viewers` với nhiều tài khoản giả, có ghi (bình luận, thích). Không có khung giờ vì không phải production.
   - Kết quả là **ngân sách hiệu năng tương đối**: p95 API, tỉ lệ lỗi, thời gian transcode, so với lần chạy trước. Một lần chạy chậm hơn quá 20 % thì báo đỏ. Số tuyệt đối trên runner không đại diện cho edge-1.
3. **Giám sát tổng hợp trên production (synthetic monitoring)**, chỉ đọc, mỗi 10 phút, bất kể giờ:
   - trang chủ, một trang xem, `master.m3u8` và một segment, `/tag/<slug>`, `sitemap.xml` (xmllint), `/v1/tags`, `/healthz`;
   - một tài khoản thăm dò `synthetic_probe` (mã mời riêng, mật khẩu trong GitHub Secret) để **đăng nhập rồi làm mới phiên**, phát hiện lỗi kiểu "Lưu";
   - không bao giờ ghi lên production, không phát đủ lâu để tính lượt xem;
   - User-Agent `WinkeySynthetic/1.0`;
   - hỏng hai lần liên tiếp thì mở hoặc cập nhật một issue `[synthetic] …`.
- **LT2 trên production** vẫn còn, nhưng chỉ là **cổng năng lực cuối cùng** (băng thông NIC, cache nginx của edge-1 chỉ đo được ở production). Nó không còn chặn việc lặp phát triển.
- **Người dùng thật** (beta, ADR-034) chỉ mời thêm khi cả hai điều kiện đúng:
  - suite persona xanh trên **3 lần chạy độc lập** (workflow `sim`: 3 stack song song trong một lần chạy, khoảng 30 phút). **Cập nhật 2026-10-11 (user):** không chờ 3 đêm;
  - LT2 PASS.
  Đây là quyết định của user. Mã mời đợt 1 đã gửi thì vẫn giữ.

**Hệ quả.**
- Lỗi giữa các service (auth ↔ web ↔ social ↔ video) lộ ra trong CI thay vì do người dùng báo.
- Mỗi tính năng mới phải kèm hoặc cập nhật một hành trình persona.
- Mỗi lần chạy `sim` tốn khoảng 30 phút × 3 runner miễn phí. Nightly vẫn giữ để bắt lỗi hồi quy.
- **Bootstrap 2026-10-11:** workflow `.github/workflows/sim.yml` (kiến trúc sư viết để chạy ngay) dùng 12 kịch bản systest có sẵn, seed, rồi k6 100 người xem + đọc API 3 phút trên stack tạm. Antigravity 4 bổ sung persona, Antigravity 2 tiếp quản workflow.
- Giám sát production cho biết sự cố trong vòng 20 phút.

### ADR-039 — Nén theo nội dung (capped CRF) và AV1 cho video nhiều lượt xem (ENC1)
**Bối cảnh.** Ngày 2026-10-12 user hỏi cách nén nhỏ hơn mà không giảm chất lượng, giống YouTube. Hiện trạng (ADR-006): chỉ H.264, bitrate cố định theo ladder (1080p 5000k / 720p 2800k / 480p 1400k), x264 `veryfast`, NVENC `p5 hq`. Một video gần như tĩnh tốn gần bằng một video nhiều chuyển động. GPU của gpu-01 là **RTX 5060 Ti 16 GB** (Blackwell), có NVENC AV1.

**Quyết định.**
1. **Giai đoạn 1: capped CRF (đã code, task ENC1).**
   - `RATE_CONTROL=capped_crf`: x264 `-crf:v:N $X264_CRF` (mặc định 21), NVENC `-cq:v:N $NVENC_CQ -b:v:N 0 -rc-lookahead 20 -temporal-aq 1` (mặc định 23).
   - Trần `-maxrate:v:N` = bitrate ABR cũ của rung (`TargetK`), `-bufsize` giữ nguyên. Nội dung đơn giản dùng ít bit hơn nhiều; nội dung phức tạp chạm trần nên tốn xấp xỉ như ABR.
   - Không đổi contract, migration, layout HLS hay player. Master playlist vẫn có `BANDWIDTH` (ffmpeg lấy từ `-maxrate`), nên hls.js ABR vẫn chạy.
   - `RATE_CONTROL=abr` giữ đúng hành vi cũ và là **mặc định trong code cho tới khi `NVENC_CQ` được hiệu chỉnh trên gpu-01**. Sau đó gpu-01 đặt `capped_crf`, không cần build lại.
2. **Đo bằng VMAF trước khi bật.** `services/transcoder/cmd/quality-bench` chạy đúng tham số ffmpeg production trên video nguồn thật, rồi in dung lượng, kbps, VMAF trung bình và VMAF p5 cho từng rendition. Tiêu chí bật capped_crf:
   - 1080p không giảm quá 1 điểm VMAF so với ABR.
   - Rendition thấp hơn không giảm quá 3 điểm. Khoảng 6 điểm VMAF mới thành một mức khác biệt nhìn thấy được (JND).
   - Tổng dung lượng trên bộ video mẫu giảm ít nhất 20 %.
3. **Giai đoạn 2: AV1 cho video nhiều lượt xem (task ENC2, chưa làm).**
   - Thêm bản AV1 (`av1_nvenc` trên RTX 5060 Ti) bên cạnh H.264, chỉ cho video vượt ngưỡng lượt xem (giống YouTube), encode lại nền vào giờ thấp điểm.
   - Cần: FFmpeg 8.x trên gpu-01 (bản 7.1 BtbN đang ghim chưa có `av1_nvenc`, xem ADR-006); master playlist nhiều codec (`CODECS="av01..."`); tên rendition mới (ví dụ `1080p-av1`), nên phải đổi contract `^[0-9]{3,4}p$` và có migration (`media.video_renditions.codec`).
   - Thiết kế riêng sau khi giai đoạn 1 chạy ổn trên production.

**Số đo 2026-10-12 (x264 `veryfast`, 4 clip tổng hợp 1080p dài 10 s, VMAF tính ở 1080p).** Mạng của môi trường làm việc chặn tải video mẫu, nên đây là clip ffmpeg tạo ra, chỉ để định hướng. Hiệu chỉnh thật phải chạy trên video nguồn thật ở gpu-01.

| Clip | Rendition | ABR kbps / VMAF | capped_crf:21 kbps / VMAF | Dung lượng |
|---|---|---|---|---:|
| gần như tĩnh | 1080p | 484 / 97.75 | 143 / 97.33 | −70 % |
| gần như tĩnh | 720p | 1202 / 90.43 | 165 / 89.38 | −86 % |
| gần như tĩnh | 480p | 964 / 81.83 | 146 / 79.81 | −85 % |
| đồ hoạ chuyển động | 1080p | 5011 / 94.26 | 5291 / 94.62 | +6 % |
| đồ hoạ chuyển động | 720p | 2802 / 87.20 | 1843 / 85.64 | −34 % |
| đồ hoạ chuyển động | 480p | 1400 / 79.27 | 683 / 76.08 | −51 % |
| chi tiết cao (mandelbrot) | 1080p | 5210 / 78.39 | 5265 / 78.43 | +1 % |
| chi tiết cao (mandelbrot) | 720p | 2883 / 70.00 | 2904 / 70.06 | +1 % |
| chi tiết cao (mandelbrot) | 480p | 1431 / 58.37 | 1346 / 57.97 | −6 % |

- Clip nhiễu ngẫu nhiên từng điểm ảnh ("film grain" tổng hợp) cho VMAF khoảng 12 ở mọi chế độ, nên bị loại khỏi bảng. Cả hai chế độ đều chạm trần như nhau (+3–4 %).
- Ở nội dung phức tạp, capped_crf vượt ABR 1–6 % trên clip 10 s. Phần vượt này đến từ bộ đệm VBV ban đầu (`bufsize` = 1,5 × `maxrate`), nên với video dài vài phút trở lên thì gần như bằng 0.
- Ở rendition thấp, VMAF giảm 1–3 điểm, dưới 1 JND. 1080p giữ nguyên chất lượng.

**Hệ quả.**
- Video ít chuyển động (vlog, nói chuyện, slide, hoạt hình phẳng) nhỏ đi 30–85 %. Video phức tạp giữ nguyên kích thước và chất lượng. Lưu trữ R2, băng thông edge và thời gian bắt đầu phát đều giảm theo.
- Video cũ không bị encode lại. Chỉ video tải lên sau khi bật mới dùng capped_crf.
- Thêm 3 biến môi trường (`RATE_CONTROL`, `X264_CRF`, `NVENC_CQ`). Rollback chỉ cần đặt `RATE_CONTROL=abr` rồi khởi động lại transcoder.

**Cập nhật 2026-10-12: kết quả đo trên gpu-01 và quyết định (issue #339).**
- Antigravity 2 chạy `scripts/enc1-bench.sh`: RTX 5060 Ti, FFmpeg n7.1.5, 10 nguồn từ archive. Trong đó s01–s03 là cùng một file, nên thực chất có 8 nguồn, và không có nguồn 1080p.
- Không mức nào đạt ngưỡng ≥ 20 %. Kết quả:
  - CQ 21: −3,0 %
  - CQ 23: −5,0 %
  - CQ 25: −8,8 %
  - **CQ 27: −16,3 %**, VMAF giảm trung bình 0,30 ở bản cao nhất (tệ nhất 0,79) và 0,12 ở bản thấp hơn.
- Nguồn đơn giản nhỏ đi 34–54 %. Nguồn phức tạp chạm trần nên gần như bằng ABR. Riêng ở CQ 21–25, NVENC capped vượt ABR 2–12 %, vì NVENC ABR encode dưới mục tiêu còn capped dùng tới trần.
- **Quyết định của user: bật `RATE_CONTROL=capped_crf`, `NVENC_CQ=27` trên gpu-01.** Đây là ngoại lệ có chủ đích với ngưỡng 20 %: CQ 27 là mức duy nhất không nguồn nào nặng hơn ABR, và chất lượng giảm không nhìn thấy được.
- Mặc định trong code vẫn là `abr`. `deploy/gpu-01/transcoder.env.example` ghi `capped_crf`/27.
- Đo lại bằng `enc1-bench.sh` khi archive có ≥ 20 nguồn thật khác nhau, có cả 1080p.
- Song song làm ENC2 (AV1, ADR-041) để giảm thêm.

### ADR-040 — Nhận diện thương hiệu trên Google và trang thể loại giải trí (SEO3)
**Bối cảnh.** Ngày 2026-10-12 user nhận xét: khi tìm kiếm, winkey.vn hiện ra rất sơ sài, không có logo, favicon, tiêu đề hay mô tả tử tế. User muốn Winkey xuất hiện với các từ khoá giải trí: phim, video, nhạc, game… Kiểm tra code `apps/web` (main `1a97a21`):
- Không có favicon hay icon nào: không có `favicon.ico`, `icon.png`, `apple-icon`, `manifest`. Google hiện biểu tượng mặc định.
- Logo trên trang chỉ là icon `PlaySquare` của lucide. Không có file logo, không có JSON-LD `Organization.logo`.
- `app/layout.tsx` có `title: 'Winkey — Video Streaming Platform'` (tiếng Anh). Không có `metadataBase`, không có title template, không có `openGraph.siteName`/`locale`.
- Mô tả trang chủ ghép từ **tiêu đề video đầu tiên**, nên thay đổi liên tục và không chứa từ khoá giải trí. Trang chủ không có H1 chữ.
- Không có trang thể loại (phim, nhạc, game…). Từ khoá chỉ đến từ trang video và `/tag/<slug>` (ADR-037).

**Quyết định.**
1. **Bộ nhận diện (brand assets).**
   - Logo SVG gốc màu thương hiệu, dựng từ dấu "play" hiện có. User có thể thay bằng logo chính thức sau.
   - Xuất từ logo: `app/favicon.ico` (16/32/48), `app/icon.png` 512×512, `app/apple-icon.png` 180×180, `public/logo.png` 512×512 (cho `Organization.logo`), `app/opengraph-image.png` 1200×630 mặc định, `manifest.webmanifest`.
   - Mọi file đều crawl được (không bị chặn trong `robots`).
2. **Metadata mặc định (layout gốc).**
   - `metadataBase: https://winkey.vn`.
   - `title.default` = "Winkey – Xem phim, video, nhạc và game giải trí", `title.template` = "%s | Winkey".
   - Mô tả cố định khoảng 150 ký tự, tiếng Việt, có từ khoá chính.
   - `applicationName`, `openGraph` (`siteName` Winkey, `locale` `vi_VN`, ảnh mặc định), `twitter`, `alternates.canonical`, `icons`, `manifest`.
3. **Trang chủ.**
   - Mô tả cố định, không lấy từ video.
   - Một H1 nhìn thấy được, kèm đoạn giới thiệu ngắn có từ khoá (phim, phim bộ, video, nhạc, game, giải trí).
   - JSON-LD `WebSite` (`name`, `alternateName`, `SearchAction` đã có) và **`Organization`** (`name`, `url`, `logo`, `sameAs` khi có mạng xã hội) để Google hiện tên trang và logo.
4. **Trang thể loại `/the-loai/<slug>`** (cố định trong code web, không cần contract hay migration):
   - Danh sách khởi đầu: `phim`, `phim-bo`, `am-nhac`, `game`, `hai-huoc`, `giai-tri`, `the-thao`, `hoat-hinh`. Mỗi thể loại có tên tiếng Việt, mô tả khoảng 150 ký tự, đoạn giới thiệu 2–3 câu, và danh sách tag nguồn (ví dụ `am-nhac` ← `am-nhac`, `nhac`, `music`, `nhac-tre`, `bolero`).
   - Video lấy qua `GET /v1/videos?tag=` (ADR-037), mỗi tag nguồn một hàng, gộp và bỏ trùng.
   - SEO giống trang tag: canonical, `index` khi tổng ≥ 2 video, ngược lại `noindex,follow`; JSON-LD `CollectionPage` + `ItemList` + `BreadcrumbList`; có trong sitemap.
   - Có liên kết từ sidebar và **footer mới** (footer gồm giới thiệu ngắn, các thể loại, điều khoản, quyền riêng tư).
5. **Đo và nộp lại.** Rich Results Test sạch lỗi cho trang chủ, một trang thể loại và một trang xem. Nộp lại sitemap trong Search Console và "Request indexing" cho trang chủ.

**Hệ quả.**
- Google có đủ tín hiệu để hiện tên trang "Winkey", favicon, tiêu đề và mô tả ổn định.
- Có các trang đích cho từ khoá giải trí, tách khỏi tag do người dùng gõ.
- Favicon và tên trang chỉ cập nhật sau khi Google crawl lại, thường vài ngày đến vài tuần. Không có cách ép ngay.
- Thứ hạng còn phụ thuộc lượng và chất lượng nội dung, cùng liên kết từ bên ngoài. Kỹ thuật chỉ là điều kiện cần.
- Danh sách thể loại và tag nguồn nằm trong code web. Khi cần quản trị động, sẽ có ADR mới với contract và migration.

### ADR-041 — AV1 bên cạnh H.264 cho video nhiều lượt xem (ENC2, thiết kế)
**Bối cảnh.** ENC1 (ADR-039) chỉ giảm được khoảng 16 % trên nội dung thật, vì nội dung phức tạp chạm trần bitrate. Muốn nhỏ hơn đáng kể ở cùng chất lượng thì phải đổi codec. GPU gpu-01 là RTX 5060 Ti (Blackwell), có NVENC AV1. User chọn làm song song với việc bật CQ 27 (2026-10-12).

**Quyết định (thiết kế, làm theo pha).**
1. **Mỗi video có hai bộ HLS độc lập.**
   - `hls/` H.264, như hiện tại, luôn có, để mọi trình duyệt phát được.
   - `hls-av1/` AV1 fMP4, cùng ladder và cùng tên rendition (`1080p`, `720p`, `480p`), chỉ có ở video được nâng cấp.
   - Hai master playlist riêng: không trộn codec trong một ABR ladder, để tránh đổi codec giữa chừng trên MSE.
2. **Contract (thay đổi bổ sung, có issue `contract-change`):**
   - `Playback.hls_av1_url` (tuỳ chọn, ký giống `hls_url`).
   - `Rendition.codec` (`h264` | `av1`, mặc định `h264`, tuỳ chọn để client cũ vẫn hợp lệ).
3. **Migration:** `media.video_renditions` thêm `codec text NOT NULL DEFAULT 'h264' CHECK (codec IN ('h264','av1'))`, khoá chính đổi thành `(video_id, codec, name)`. Dữ liệu cũ giữ nguyên.
4. **Transcoder.**
   - Đường encode AV1 `av1_nvenc`, chất lượng hằng có trần như ENC1, ladder giống H.264. Bitrate trần AV1 khoảng 60 % H.264, sẽ hiệu chỉnh bằng `quality-bench` có thêm `-encoder av1_nvenc`.
   - Lệnh `av1-upgrade` chạy nền giờ thấp điểm, chọn video theo lượt xem 7 ngày (ngưỡng cấu hình được), encode AV1 từ archive raw, ghi rendition `codec='av1'` trong cùng giao dịch, xong thì xoá cache playback.
   - Video mới vẫn chỉ encode H.264, để không tăng gấp đôi thời gian GPU trên máy dùng chung.
   - Cần **FFmpeg 8.x** cài cạnh 7.1 (ví dụ `/opt/ffmpeg-8/`, user cài bằng sudo), biến riêng `AV1_FFMPEG_PATH`. 7.1 không bị đụng tới.
5. **video-svc:** trả `hls_av1_url` khi video có rendition AV1 đầy đủ.
6. **Web player (Antigravity 1):** dùng `hls_av1_url` khi có, và chỉ khi `MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"')` đúng. Ngược lại phát `hls_url`. Không đổi giữa chừng.
7. **Đo trước khi bật.** Tiêu chí như ADR-039 so với H.264 capped hiện tại:
   - giảm ≥ 25 % dung lượng;
   - VMAF bản cao nhất giảm ≤ 1.

**Pha.**
1. Contract, migration, đường encode AV1 và bench (kiến trúc sư).
2. `av1-upgrade` và video-svc (kiến trúc sư).
3. Player (Antigravity 1).
4. Cài FFmpeg 8 trên gpu-01 (user), hẹn giờ chạy (Antigravity 2).

**Hệ quả.** Video nhiều lượt xem nhỏ hơn đáng kể, đúng nơi tốn băng thông nhất. Đổi lại tốn thêm dung lượng lưu (khoảng +60 % cho video đã nâng cấp) và thêm thời gian GPU giờ thấp điểm. Thiết bị không hỗ trợ AV1 vẫn phát H.264 như cũ.

**Bổ sung 2026-10-12 (FFmpeg cho AV1).** Antigravity 2 kiểm tra trên gpu-01 (#47):
- FFmpeg 7.1 trong `/opt` không có `av1_nvenc`.
- Bản BtbN master mới nhất có `av1_nvenc` nhưng cần NVENC API 13.1, tức driver ≥ 610. gpu-01 đang chạy driver 595.99 (API 13.0).
- Bản release BtbN `n8.0.1-66` (autobuild 2026-02-28, sha256 `26d2ecd0…ca5b0`) chạy được cả `av1_nvenc` lẫn `h264_nvenc` trên driver 595, và có sẵn libvmaf.

Quyết định:
- **Không nâng driver.** Máy dùng chung với miner và ComfyUI.
- Ghim đúng bản FFmpeg 8.0 này. Bench dùng nó trong `~/tools` (`scripts/enc2-bench.sh`, không cần sudo).
- Production sẽ cài cùng bản đó vào `/opt/ffmpeg-8` (user cài bằng sudo, pha 4) và trỏ `AV1_FFMPEG_PATH` tới đó.
- Mỗi lần đổi bản FFmpeg đều phải kiểm lại phiên bản NVENC API so với driver.

**Bổ sung 2026-10-14 (hiệu chỉnh AV1, #352).** Đo trên gpu-01 bằng `enc2-bench.sh`, mốc so sánh là `capped_crf:27`:
- Trần 60 % (lần 1): mọi mức CQ đều đụng trần. Video phức tạp giảm 2–4 VMAF, không mức nào đạt.
- Trần 85 % và 100 % (lần 2): `av1:34` nhỏ hơn 22 %, VMAF gần như không đổi. Trần không còn quyết định kết quả.
- Lần 3, trần 85 %:
  - `av1:35`: nhỏ hơn 27,5 %, VMAF bản cao nhất giảm 0,31 trung bình, 0,90 tệ nhất (đạt);
  - `av1:36`: nhỏ hơn 32,5 %, giảm 0,62 / 1,87;
  - `av1:37`: nhỏ hơn 37,2 %, giảm 0,98 / 2,95.

**Chọn `av1:35`, trần 85 %** (`DefaultAV1CQ=35`, `DefaultAV1MaxratePct=85`). Đây là mức duy nhất mà cả video tệ nhất vẫn dưới ngưỡng 1 VMAF. Bench đề xuất `av1:37` vì tiết kiệm nhất, nhưng với `av1:37` có video giảm gần 3 VMAF, mắt thường thấy được.

Hai mẫu s11 và s12 có VMAF bất thường ở mọi setting, kể cả H.264. Đó là lỗi đo, sẽ sửa trong công cụ.

**Bổ sung 2026-10-16 (pha 2, kiến trúc sư).** `av1-upgrade` và `hls_av1_url`:
- **Migration 000024:** `media.videos.hls_av1_master_key` (null khi chưa có bộ AV1, CHECK phải nằm dưới `v/{id}/av1/`). Bộ AV1 là các dòng `codec='av1'` của `media.video_renditions` cộng khoá này. video-svc chỉ trả rendition AV1 khi có khoá, nên một bộ dở dang không bao giờ lộ ra.
- **Layout:** `v/{id}/av1/{uuidv7}/` thay cho `hls-av1/` trong thiết kế. Thư mục nằm ngoài `a{n}/` (giống `audio/`), nên lần encode lại H.264 không xoá nó và không cần encode lại AV1 (cùng file gốc, cùng ladder).
- **Chọn video:** `READY`, chưa có bộ AV1, tổng `starts` 7 ngày gần nhất trong `analytics.video_daily` ≥ `AV1_MIN_STARTS_7D` (mặc định 50), nhiều lượt nhất trước, tối đa `AV1_UPGRADE_LIMIT` (20) mỗi lần chạy, tuần tự từng video. Nguồn là file raw (`raw_bucket/raw_key`); ladder phải trùng tên với bộ H.264, nếu không thì bỏ qua video đó.
- **Ghi:** upload hết rồi mới ghi DB trong một giao dịch giữ khoá dòng video: kiểm tra vẫn `READY`, thay các dòng `codec='av1'` (`bitrate_kbps` = trần AV1), áp nhóm âm thanh MUX1 vào master AV1, đặt `hls_av1_master_key`. Thua race thì xoá bộ vừa upload.
- **Âm thanh (MUX1):** mọi thay đổi track âm thanh (transcoder `CompleteAudio`, video-svc PATCH/DELETE) ghi lại cả hai master trong cùng giao dịch.
- **Cache playback:** không cần xoá riêng. Cache của video-svc hết hạn sau `CACHE_TTL`, và key master mới không trùng key cũ.

### ADR-042 — Track âm thanh và phụ đề tách riêng (MUX1, thiết kế)

**Bối cảnh.** User muốn upload riêng phần video gốc, các track thuyết minh/lồng tiếng và phụ đề, để người xem đổi ngôn ngữ âm thanh và bật/tắt phụ đề ngay trong player. Phụ đề WebVTT theo từng ngôn ngữ đã có từ V5b (ADR-018). Track âm thanh riêng thì chưa có: hiện mỗi rendition HLS ghép sẵn một track âm thanh.

**Quyết định (thiết kế).**
- Định dạng gói xuất: [`docs/specs/media-package-v1.md`](specs/media-package-v1.md). Gồm `manifest.json`, một file video, các file audio là **bản mix hoàn chỉnh** (WAV/FLAC hoặc AAC ≥ 192 kb/s, 48 kHz, stereo, bắt đầu từ khung hình đầu, lệch thời lượng ±100 ms) và phụ đề WebVTT.
- HLS: video mới dùng các variant **chỉ có hình** cộng `#EXT-X-MEDIA:TYPE=AUDIO` (AAC 128 kb/s) cho từng track. Thêm một track sau khi đã đăng chỉ encode riêng phần âm thanh, không encode lại video. Video cũ giữ nguyên.
- Player **không trộn** âm thanh: chọn track nào thì phát cả track đó.
- Giới hạn: 8 track âm thanh và 20 phụ đề mỗi video. `lang` theo BCP 47, cùng pattern với API phụ đề. Thêm `kind`: âm thanh là `original/dub/voiceover/commentary`, phụ đề là `subtitles/captions` (bỏ `forced`: mỗi ngôn ngữ một phụ đề, xem addendum).

**Pha.**
1. `contract-change` (`Playback.audio_tracks`, `kind` của phụ đề, API upload track âm thanh) và migration `media.video_audio_tracks` (kiến trúc sư).
2. Transcoder: layout HLS mới và job chỉ encode âm thanh (kiến trúc sư).
3. Studio: upload gói và quản lý track; player có menu âm thanh và phụ đề (Antigravity 1).

**Hệ quả.** Dung lượng lưu trữ tăng khoảng 1 MB mỗi phút cho mỗi track âm thanh. Đổi ngôn ngữ trong player tức thì, vì HLS chuyển audio rendition mà không tải lại video.

**Addendum 2026-10-14 (pha 2, kiến trúc sư).** Khi làm pha 2, layout HLS được đơn giản hoá so với thiết kế ban đầu:
- **Variant giữ âm thanh gốc muxed như cũ**, không đổi sang variant chỉ có hình. Khi video có ít nhất một track `READY`, master có nhóm `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"`. Âm thanh gốc đứng đầu, **không có URI** (âm thanh nằm trong variant, RFC 8216 §4.3.4.1). Sau đó là từng track `READY`, mỗi track có URI tới playlist riêng. Mọi `#EXT-X-STREAM-INF` mang `AUDIO="aud"`. Không còn track nào thì master trở về dạng thường. Nhờ vậy video cũ và video mới dùng chung một cách, transcoder không phải encode lại video, và không cần biết video gốc có âm thanh hay không.
- `Playback.audio_tracks` khớp đúng nhóm này. Âm thanh gốc có `id` = id của video, `lang` = `und` (API upload chưa có ngôn ngữ của âm thanh gốc), nhãn `Âm thanh gốc`, `kind` = `original`. Nếu có track `kind=original` được upload riêng thì track đó thay cho âm thanh gốc. Mặc định là track có `is_default`, nếu không có thì là âm thanh gốc.
- Track encode vào `v/{video_id}/audio/{track_id}/` (AAC-LC 128 kb/s, 48 kHz, stereo, fMP4, đoạn 4 s, giống phần âm thanh của variant). Thư mục này nằm ngoài `a{n}/`, nên lần encode lại video không xoá nó.
- **Một chỗ ghi master: `libs/go/hlsmaster`.** Ba nơi gọi nó: transcoder khi track `READY`, transcoder khi encode lại video có track `READY` (`store.Complete`), và video-svc khi đổi tên, đổi mặc định hoặc xoá track. Cả ba đều chạy trong transaction giữ khoá dòng `media.videos` (`FOR UPDATE`), nên không ghi đè lẫn nhau. Master mới luôn có key mới, cạnh master cũ (`…/hls/master-{uuid}.m3u8`), vì master được cache immutable.
- Track lệch thời lượng quá ±100 ms so với video thì `FAILED` với `AUDIO_DURATION_MISMATCH`. Track upload khi video chưa `READY` sẽ chờ (job trả về và thử lại sau 2 phút, tối đa khoảng 6 giờ). Một lần upload track được tính vào quota upload như một video (chiếm một slot đồng thời và có một dòng trong ledger).
- **Thứ tự triển khai:** migration 000023 phải được áp dụng ở production **trước** khi deploy transcoder, video-svc và upload-svc mới, vì `store.Complete` của transcoder đọc `media.video_audio_tracks`.

**Addendum 2026-10-17 (sửa layout, kiến trúc sư). Thay gạch đầu tiên của addendum 2026-10-14.**

*Bối cảnh.* Video đầu tiên có track thuyết minh thật trên production hiện menu tai nghe, nhưng player báo không phát được.

Kiến trúc sư tái hiện lỗi trên Chromium với hls.js 1.7.3 (bản web đang dùng): hls.js **không chuyển được giữa âm thanh muxed trong variant và một audio rendition riêng**.
- Track phụ là mặc định: lỗi fatal `bufferAppendError: Attempting to append to the audio SourceBuffer, but it does not exist`.
- Âm thanh gốc là mặc định: phát được, nhưng đổi sang thuyết minh thì lỗi fatal.
- Thêm URI cho âm thanh gốc mà variant vẫn muxed: vẫn lỗi.
- Variant chỉ có hình, còn mọi âm thanh (kể cả gốc) là rendition riêng có URI: phát được, đổi qua lại đều được.

*Quyết định.* Quay về đúng thiết kế ban đầu của ADR-042:
- **Variant chỉ có hình.** Âm thanh gốc là rendition riêng `audio/` cạnh master (AAC-LC 128 kb/s, 48 kHz, stereo; nguồn không có tiếng thì dùng `anullsrc` như trước). Master luôn có nhóm `GROUP-ID="aud"`: âm thanh gốc đứng đầu với `URI="audio/index.m3u8"`, sau đó là các track `READY`.
- Không có track nào thì nhóm vẫn còn, chỉ gồm âm thanh gốc (`DEFAULT=YES`). `Playback.audio_tracks` vẫn rỗng khi không có track `READY` (giữ nguyên contract).
- FFmpeg ghi thêm một rung chỉ có âm thanh vào ladder. `hlsmaster.With` bỏ rung này đi để player không chọn phát chỉ âm thanh.
- `libs/go/hlsmaster` vẫn là chỗ duy nhất ghi master. Master cũ (muxed, không có `audio/index.m3u8`) vẫn được ghi theo cách cũ, nhưng những video đó phải được encode lại trước khi có track.
- **Video đã có:** lệnh `reencode` (`services/transcoder/cmd/reencode`) chạy pipeline của worker để encode lại các video `READY` còn master cũ. Lệnh bỏ bộ AV1 cũ; `av1-upgrade` dựng lại bộ AV1 theo layout mới. Bộ AV1 cũng có rendition `audio/` riêng.

*Hệ quả.* Mỗi video thêm một rendition âm thanh khoảng 1 MB/phút. Variant không còn chứa âm thanh nên tổng dung lượng gần như không đổi.

**Thứ tự triển khai:**
1. Deploy transcoder (worker, `av1-upgrade`, `reencode`) và video-svc cùng bản.
2. Chạy `reencode`.
3. Chạy `av1-upgrade`.

Web cần sửa nhỏ: chỉ hiện menu âm thanh khi có ít nhất 2 lựa chọn (Antigravity 1), vì giờ mọi master đều có một rendition âm thanh.

**Addendum 2026-10-17 (DEF1, phụ đề và âm thanh mặc định, kiến trúc sư).**

*Bối cảnh.* Người dùng muốn creator tích chọn được phụ đề mặc định và track âm thanh mặc định. Không tích gì thì video phát nguyên gốc: không phụ đề, âm thanh gốc.

*Quyết định.*
- **Phụ đề:** cột mới `media.video_subtitles.is_default` (migration 000025), mặc định `false`, tối đa một track mặc định mỗi video (partial unique index `video_subtitles_one_default`).
  - `SubtitleTrack.is_default` luôn được trả về (trong schema là optional, vì `default` trong schema làm field TS thành bắt buộc).
  - `PUT …/subtitles/{lang}` nhận `is_default` tuỳ chọn: `true` đặt mặc định và bỏ cờ ở các track khác; `false` bỏ cờ; không gửi thì track thay thế giữ cờ cũ, track mới là `false`.
  - `PATCH …/subtitles/{lang}` mới (`label` và/hoặc `is_default`) đổi tên hoặc đổi cờ mà không phải tải file lại.
  - Mọi thay đổi cờ chạy trong transaction giữ khoá dòng video, nên hai request đồng thời không thể để lại hai track mặc định.
  - Player bật phụ đề mặc định khi người xem chưa lưu lựa chọn nào. Lựa chọn đã lưu của người xem (kể cả "tắt") luôn thắng.
- **Âm thanh:** `PATCH …/audio-tracks/{id}` nhận cả `is_default: false`, tức bỏ cờ của track đó. Master được ghi lại, và âm thanh gốc thành `DEFAULT=YES` (quy tắc sẵn có của `hlsmaster.Group`).
- Không có cột hay cờ nào cho "gốc": không track nào mặc định nghĩa là gốc.

### ADR-043 — Video lên kết quả video của Google (SEO4)

*Bối cảnh (2026-10-19).* Người dùng thấy Google chỉ hiện trang chủ, với tiêu đề và mô tả cũ (bản crawl trước SEO3), chưa có video nào trong kết quả video. Kiến trúc sư rà code trên main:
- **`player_loc` trong video sitemap trùng `<loc>`** (đều là `/watch/{id}`). Đặc tả video sitemap của Google yêu cầu `player_loc` khác `loc`, nên Google bỏ qua mọi mục `<video:video>`.
- JSON-LD `VideoObject` có `embedUrl` là trang xem (không phải player) và **không có `contentUrl`**. Google cần ít nhất một trong hai trỏ tới file video hoặc một player nhúng được.
- `og:video` cũng trỏ về trang xem.
- Không có trang player nhúng nào (`/embed/{id}`).
- Còn lại đã đúng từ SEO1–SEO3: `VideoObject`, canonical, `noindex` cho video không công khai, `robots.txt`, sitemap động, thumbnail công khai trên `media.winkey.vn` (không bị chặn; `/robots.txt` ở đó trả 404, tức là cho phép tất cả).

*Quyết định.* Chỉ sửa web (Antigravity 1), không đổi contract hay Go:
1. **Trang `/embed/{id}`.** Player tối giản cho video `PUBLIC` (không header, footer hay comment). Cho phép nhúng iframe: `Content-Security-Policy: frame-ancestors *` chỉ trên đường dẫn này. Canonical về `/watch/{id}`. Video không công khai hoặc không tồn tại trả 404. Không bị chặn trong `robots.ts`.
2. **JSON-LD trên trang xem:** `embedUrl` là `/embed/{id}`, `contentUrl` là `playback.hls_url` (chỉ video công khai, vì URL không ký). Thêm `publisher` là `Organization` Winkey kèm logo.
3. **Video sitemap:** `player_loc` là `/embed/{id}`.
4. **Open Graph và Twitter:** `og:video` (cùng `og:video:secure_url`, `og:video:type=text/html`, width, height) là `/embed/{id}`; Twitter card `player`.
5. **HTML render phía server của trang xem** có sẵn thẻ `<video>` với `poster` là thumbnail, cùng `<h1>` tiêu đề và mô tả dạng text, để Google thấy video là nội dung chính ngay cả trước khi chạy JS.
6. **Đo:** Rich Results Test (mục Video) sạch lỗi cho 2 trang xem; sitemap hợp lệ, có `player_loc` khác `loc`.

*Hệ quả.* Đây là những điều kiện kỹ thuật để video được Google lập chỉ mục. Video có lên kết quả hay không, và khi nào, vẫn do Google quyết định. Thường mất vài ngày tới vài tuần sau khi nộp lại sitemap. Người dùng xem tiến độ ở báo cáo "Video indexing" (Lập chỉ mục video) trong Search Console.

### ADR-044 — Kiểm thử và nâng cấp UI/UX trên mọi kích thước màn hình (UX1)

*Bối cảnh (2026-10-20).* Người dùng thấy giao diện chưa tối ưu trên mọi màn hình (mobile, tablet, PC, TV) và có tính năng bấm vào không có gì xảy ra. Kiến trúc sư rà nhanh code web trên main `c864d95`:
- **Nút chết (đã thấy trong code):**
  - nút "Thích" trong hộp chi tiết phim (`components/cinema/cinema-detail-dialog.tsx`) không có xử lý;
  - các chip thể loại ở `/kham-pha` không có xử lý (chip đầu luôn được chọn);
  - mục "Lịch sử" ở sidebar trỏ tới `#history`, và chưa có API lịch sử xem.
- **Màn hình lớn và TV:** web chỉ dùng breakpoint Tailwind tới `xl`, chưa có cỡ cho 1920 px trở lên. Chưa có điều hướng bằng phím mũi tên hay remote (TV không có chuột).
- **Kiểm thử:** e2e chỉ chạy một viewport desktop 1440×900. Không có kiểm tra tràn ngang, cỡ vùng chạm, accessibility hay nút chết.

*Quyết định.* Chương trình UX1 gồm 3 pha. Pha sau chỉ bắt đầu khi pha trước đạt tiêu chí.

**Pha 0: Kiểm toán tự động (Antigravity 4, trong `systest/`).**
- Bộ `systest/ui-audit/` dùng Playwright và `@axe-core/playwright`, chạy trên **stack systest local có seed** (không chạy trên production, vì bấm thử có thể tạo dữ liệu).
- Có 8 viewport:

  | Viewport | Kích thước | Ghi chú |
  |---|---|---|
  | `mobile-s` | 360×800 | touch |
  | `mobile` | 390×844 | touch |
  | `tablet-p` | 768×1024 | touch |
  | `tablet-l` | 1024×768 | touch |
  | `laptop` | 1366×768 | |
  | `desktop` | 1920×1080 | |
  | `tv-720` | 1280×720 | chỉ dùng bàn phím |
  | `tv-1080` | 1920×1080, DPR 2 | chỉ dùng bàn phím |

- Mỗi trang chính được kiểm tra với từng persona (khách, thành viên, creator, moderator hoặc admin), gồm:
  1. **Nút chết.** Bấm từng phần tử tương tác, trừ một danh sách loại trừ các thao tác phá dữ liệu. Phần tử bị tính là chết khi sau khi bấm không có gì thay đổi: không chuyển URL, không đổi DOM hay `aria-*`, không gọi mạng, không mở dialog, không tải file.
  2. **Tràn ngang** (`scrollWidth > clientWidth`).
  3. **Vùng chạm nhỏ hơn 44×44 px** trên các viewport touch.
  4. **axe:** lỗi `serious` và `critical`.
  5. **Chữ bị cắt hoặc chồng nhau** (ảnh chụp kèm hộp đánh dấu).
  6. **TV:** phải đi được tới mọi phần tử chính bằng phím mũi tên hoặc Tab, Enter, Esc, và luôn thấy focus.
  7. **Hiệu năng:** CLS và LCP.
- Kết quả gồm báo cáo Markdown kèm ảnh, và mỗi lỗi một issue gắn nhãn `ux1`, ghi mức độ (P0 không dùng được, P1 xấu hoặc khó dùng, P2 đánh bóng).

**Pha 1: Sửa lỗi chức năng và nền tảng responsive (Antigravity 1, trong `apps/web`).**
- Sửa mọi nút chết P0.
- Lập bộ token thiết kế: khoảng cách, cỡ chữ theo viewport, breakpoint thêm `3xl` (1920) và `4xl` (2560), cỡ vùng chạm.
- Sửa layout từng trang trên 8 viewport.
- **Chế độ TV:** điều hướng không gian bằng phím mũi tên (D-pad), focus ring rõ, chữ và điều khiển player to hơn khi màn hình ≥ 1920, không có thao tác chỉ dùng hover.
- Thêm các project viewport mobile, tablet và TV vào e2e.

**Pha 2: Đánh bóng giao diện (Antigravity 1)** theo các issue P1 và P2. Antigravity 4 chạy lại kiểm toán sau mỗi PR lớn.

**Phần backend.** Tính năng nào cần API mà chưa có thì kiến trúc sư làm (contract và Go). Việc đã biết là **lịch sử xem (HIST1)**: `GET /v1/me/history`. Trong lúc chờ, web ẩn mục "Lịch sử" chứ không để một nút chết.

**Hạ tầng (Antigravity 2):** deploy web sau mỗi pha; thêm job CI chạy `ui-audit` hằng đêm trên stack systest và đăng tóm tắt lên #47.

*Tiêu chí hoàn thành UX1* (đo bằng `ui-audit` trên 8 viewport):
- 0 nút chết;
- 0 trang tràn ngang;
- 0 lỗi axe `serious` hoặc `critical`;
- mọi vùng chạm ≥ 44 px trên touch;
- TV đi được hết các luồng chính bằng bàn phím;
- CLS < 0,1 trên mọi trang;
- người dùng tự kiểm tra trên điện thoại, máy tính bảng và TV thật.

### ADR-045 — Danh sách tập khi xem phim bộ và giao diện xem trên điện thoại (CIN3, UX2)

*Bối cảnh (2026-10-21).* Người dùng thử trên điện thoại (ảnh chụp trang xem Thiên Cơ Biến tập 3):
1. **Thanh điều khiển của player tràn ra ngoài.** Nút cài đặt và toàn màn hình bị cắt, nút phụ đề to bất thường. Nguyên nhân: sau UX1 (#423, vùng chạm 44 px), mọi nút có `min-w-11` nhưng thanh điều khiển vẫn xếp một hàng không co.
2. **Hàng nút Thích, Chia sẻ, Xem sau, Lưu, Báo cáo không đều và bị che.** Nút cao thấp khác nhau, chữ "Chia sẻ" và "Xem sau" xuống hai dòng, nút Báo cáo bị cắt mép phải.
3. **Xem một tập phim bộ chỉ thấy "Xem tiếp", không thấy danh sách tập.** Web đã có cột danh sách tập (`watch-series-column`), nhưng chỉ hiện khi link có `?playlist=<id>` (vào từ trang Phim). Vào từ tìm kiếm, Lịch sử, Google hay link chia sẻ thì không có tham số này nên không có ngữ cảnh phim bộ.

*Quyết định.*
- **CIN3, API (contract của kiến trúc sư, Antigravity 3 làm trong social-svc):** `GET /v1/series?video_id=` (`listSeriesForVideo`) trả về tối đa 5 series `PUBLIC` có video là tập **phát được**, `updated_at` mới nhất trước; không có thì trả về danh sách rỗng, không 404. Gateway: `/v1/series` đã sang social-svc.
- **CIN3, web (Antigravity 1):**
  - Trang xem không có `?playlist=` thì gọi `listSeriesForVideo`. Có series thì dùng series đầu tiên: gọi `getSeriesEpisode`, hiện danh sách tập (cột phải trên desktop, khối dưới player trên mobile, có Tập trước/Tập sau), và thêm `?playlist=` vào URL bằng `replaceState`, không tạo bước lịch sử mới.
  - Danh sách tập: tập đang xem được làm nổi và tự cuộn tới; có số tập, thumbnail, tiêu đề, thời lượng; tải thêm theo cursor.
  - Hết tập thì tự phát tập sau, có đếm ngược 5 giây và nút huỷ.
- **UX2, giao diện xem trên mobile (Antigravity 1):**
  - *Thanh điều khiển player dưới 640 px:* chỉ giữ Phát/Dừng, thời gian dạng gọn, Cài đặt và Toàn màn hình. Âm lượng chỉ còn nút tắt/bật tiếng (bỏ thanh trượt). Phụ đề, âm thanh và chất lượng chuyển vào menu Cài đặt.
    - Nút hiển thị 36 px, vùng chạm vẫn 44 px (dùng padding hoặc `::before`).
    - Không nút nào bị cắt ở 360 px.
    - Nút phụ đề không dùng nền đỏ đặc; đang bật thì đổi màu icon hoặc thêm gạch dưới.
  - *Hàng hành động dưới tiêu đề:* các chip có cùng chiều cao, icon và chữ trên một dòng (`whitespace-nowrap`), cuộn ngang được (`overflow-x-auto`, ẩn thanh cuộn, có gradient mờ ở mép phải). Không chip nào bị che.
  - *Hàng kênh:* nút Đăng ký kích thước bình thường, không phình to.
  - Thêm ảnh chụp e2e ở 360, 390 và 768 px cho trang xem; kiểm toán UX1 không được báo tràn hay cắt ở trang xem.

### ADR-046 — Đăng ký mở, tài khoản thường chỉ xem; quyền sáng tạo do Admin duyệt (ROLE1)

*Bối cảnh (2026-10-22).* User quyết định:
- mở đăng ký, không cần mã mời nữa;
- tài khoản thường chỉ được xem;
- muốn upload và quản lý video thì phải gửi yêu cầu nâng cấp và chờ Admin duyệt;
- tài khoản của user là Admin;
- giao diện ẩn/hiện chức năng theo quyền: thường thì chỉ xem, sáng tạo có thêm upload và Studio, admin có thêm trang Admin.

Hiện trạng code:
- Đã có role `viewer`, `creator`, `moderator`, `admin`.
- Đã có `adminSetUserRoles`, đình chỉ tài khoản, audit log, tab Admin "Người dùng" và "Nhật ký".
- upload-svc đã đòi `creator`.
- Nhưng tài khoản mới mặc định có `{viewer,creator}`. Video-svc chỉ kiểm tra chủ sở hữu, không kiểm tra `creator`. Web hiện nút Tải lên và Studio cho mọi người.

*Quyết định.*
- **Đăng ký mở (Antigravity 2, Antigravity 1).**
  - Production đặt `REGISTRATION_MODE=open`. Code BETA1 giữ nguyên để có thể đóng lại khi cần.
  - Form đăng ký chỉ hiện ô mã mời khi link có `?invite=`. Bỏ chữ "beta kín" khỏi giao diện.
  - Theo ADR-034, LEGAL chặn việc mở công khai. User đã quyết định mở đăng ký ngày 2026-10-22; LEGAL vẫn mở và cần làm sớm.
- **Role mặc định là `viewer`.**
  - Contract `register` và Google sign-up đặt `roles = [viewer]`. Migration 000027 đổi default của cột thành `{viewer}`.
  - Biến cấu hình `SIGNUP_ROLES` của auth-svc chỉ nhận `viewer` (mặc định, production) hoặc `viewer,creator`; giá trị khác thì service không khởi động. Giá trị được ghi log lúc khởi động. Stack dev/test (compose, systest, mô phỏng CI) đặt `viewer,creator`, vì seed và loadtest đăng ký tài khoản qua API rồi upload. Manifest production không bao giờ đặt biến này.
  - **Tài khoản đã có giữ nguyên role.** Admin thu hồi `creator` ở tab Người dùng nếu cần.
  - Không chạy migration dữ liệu: không đoán được ai "đáng" giữ `creator`, và migration đó không đảo ngược được.
- **Yêu cầu nâng cấp (contract của kiến trúc sư, Antigravity 3 làm trong auth-svc).**
  - Bảng `auth.creator_requests`. Mỗi user có tối đa một yêu cầu `PENDING`.
  - Endpoint:
    - `GET/POST /v1/auth/me/creator-request`;
    - `GET /v1/admin/creator-requests?status=` (chỉ admin; có `pending_count` cho badge);
    - `POST /v1/admin/creator-requests/{id}/decision` với `APPROVE | REJECT` và `note` (bắt buộc khi từ chối).
  - Duyệt thì trong cùng transaction: thêm `creator` vào roles và ghi audit `USER_ROLES_CHANGED` kèm `creator_request_id`.
    - **Không thu hồi phiên đăng nhập**, vì thêm quyền thì chậm tối đa 15 phút cũng an toàn. Web gọi `refresh` ngay khi thấy yêu cầu được duyệt.
    - Thu hồi quyền vẫn đi qua `adminSetUserRoles`, giữ hành vi thu hồi phiên như cũ.
  - Bị từ chối thì 24 giờ sau mới gửi lại được (`REQUEST_COOLDOWN`). Rate limit 5 yêu cầu/ngày.
  - Log không ghi nội dung `message`.
  - Chưa gửi email báo kết quả (bản sau). Người dùng thấy trạng thái trên trang nâng cấp.
- **Máy chủ thực thi quyền, không chỉ giao diện.**
  - upload-svc đã đòi `creator`.
  - video-svc (kiến trúc sư làm) đòi `creator` cho sửa video, phụ đề, track âm thanh, danh sách Studio và thống kê. Thiếu quyền thì trả `403 CREATOR_ROLE_REQUIRED`, kiểm từ header trước khi đọc dữ liệu.
  - **Xoá video của mình** vẫn được làm khi không có `creator`.
  - Phần xem (like, bình luận, playlist, xem sau, lịch sử, đăng ký kênh) vẫn dành cho mọi tài khoản.
- **Tài khoản Admin của user (Antigravity 2).**
  - Chạy SQL một lần trên edge-1: đặt `roles = {viewer,creator,admin}` cho tài khoản có email của user, nếu chưa có.
  - Email nhập bằng `read -r`, không ghi vào git, issue hay log. Báo cáo chỉ ghi id tài khoản và role trước/sau.
  - User đăng xuất rồi đăng nhập lại để nhận token mới.
- **Giao diện theo quyền (Antigravity 1).**

  | Chức năng | Khách | Thường (`viewer`) | Sáng tạo (`creator`) | Kiểm duyệt (`moderator`) | Admin |
  |---|---|---|---|---|---|
  | Xem, tìm kiếm, phim | ✓ | ✓ | ✓ | ✓ | ✓ |
  | Thích, bình luận, playlist, xem sau, lịch sử, đăng ký kênh | – | ✓ | ✓ | ✓ | ✓ |
  | "Trở thành nhà sáng tạo" (gửi yêu cầu, xem trạng thái) | – | ✓ | – | ✓ nếu chưa có `creator` | – |
  | Tải lên, Studio, sửa video, phụ đề, track âm thanh, thống kê | – | – | ✓ | – | ✓ (admin có cả `creator`) |
  | Admin: Hàng kiểm duyệt, Người dùng | – | – | – | ✓ | ✓ |
  | Admin: Yêu cầu sáng tạo, Nhật ký, đổi role | – | – | – | – | ✓ |

  - Thiếu quyền thì **ẩn** nút và link: thanh trên, sidebar, tab dưới mobile, menu tài khoản, nút Chỉnh sửa/Phụ đề trên trang xem.
  - Vào thẳng `/upload` hay `/studio/*` khi thiếu quyền: khách được chuyển tới đăng nhập; tài khoản thường thấy trang "Trở thành nhà sáng tạo", không phải trang lỗi.
  - Khi đang tải phiên đăng nhập: dùng chỗ giữ chỗ như #442, không để giao diện nhảy (CLS).

*Hệ quả.*
- Thứ tự làm:
  1. Merge PR thiết kế này (contract và migration).
  2. Song song: AG3 (auth-svc), kiến trúc sư (video-svc), AG1 (web, dùng mock theo contract).
  3. AG2 áp migration 000027, deploy auth-svc, video-svc và web, đặt `REGISTRATION_MODE=open`, cấp quyền Admin.
  4. AG4 thêm kịch bản systest cho cả luồng: đăng ký → không thấy Tải lên → gửi yêu cầu → admin duyệt → thấy Tải lên và upload được.
- **Deploy auth-svc trước rồi mới mở đăng ký.** Bản auth-svc cũ vẫn cấp `creator` cho tài khoản mới.

### ADR-047 — Admin tìm, ẩn và xoá bất kỳ video nào (ADMV1)

*Bối cảnh (2026-10-23).* User muốn admin ẩn hoặc xoá được bất kỳ video nào trên hệ thống. Hiện trạng:
- Server đã cho phép: `moderateVideo` (moderator hoặc admin, ẩn kèm lý do / hiện lại) và `deleteVideo` (chủ video, moderator hoặc admin).
- Nhưng admin không có cách tìm video: chỉ thấy video bị báo cáo trong Hàng kiểm duyệt, hoặc video của chính mình trong Studio. Web cũng không có nút ẩn/xoá trên trang xem.

*Quyết định.*
- **API (kiến trúc sư, video-svc):** `GET /v1/studio/admin/videos` (`adminListVideos`).
  - Chỉ moderator và admin; kiểm tra từ `X-User-Roles` trước khi đọc dữ liệu.
  - Trả mọi video của mọi người, mọi trạng thái, chế độ hiển thị và trạng thái kiểm duyệt, mới nhất trước.
  - Bộ lọc: `q` (chuỗi con của tiêu đề, không phân biệt hoa thường và dấu), `status`, `visibility`, `moderation_state`, `owner_id`. Cursor gắn với bộ lọc.
  - Mỗi dòng có `owner` (tài khoản không còn hoạt động thì dùng hồ sơ thay thế `deleted_user`) và `owner_active`.
  - Đặt dưới `/v1/studio/`, vì gateway đã chuyển `/v1/studio/*` sang video-svc, còn `/v1/admin/*` sang auth-svc.
- **Ẩn và xoá dùng lại endpoint có sẵn,** không đổi quyền. Moderator vẫn được ẩn và xoá như contract hiện tại. Xoá là vĩnh viễn: media janitor xoá toàn bộ file trên R2.
- **Web (Antigravity 1):**
  - Tab Admin "Video" cho moderator và admin, có ô tìm kiếm, các bộ lọc và tải thêm theo cursor.
  - Mỗi dòng hiện ảnh nhỏ, tiêu đề (link tới trang xem), chủ video, trạng thái, chế độ hiển thị, trạng thái kiểm duyệt và ngày tạo.
  - Hành động: **Ẩn** (bắt buộc nhập lý do), **Hiện lại**, **Xoá** (hộp xác nhận phải gõ lại "XOÁ").
  - Trang xem: menu "⋯ Quản trị" cho moderator và admin, có Ẩn/Hiện lại và Xoá; xoá xong thì quay về trang chủ.

*Hệ quả.* Admin xử lý được video vi phạm mà không cần chờ người dùng báo cáo. Xoá không hoàn tác được nên giao diện bắt xác nhận hai bước. Ẩn là cách xử lý mặc định nên được đề xuất trước.

### ADR-048 — Dọn rác R2 và chính sách AV1 theo top N (STOR1, AV1POL)

*Bối cảnh (2026-10-23).*
- R2 báo khoảng 9,2 GB. Kiểm kê bằng `storage-gc` (#456) trên gpu-01:
  - H.264 đang dùng: 3,10 GiB;
  - **bộ AV1 đang dùng: 2,21 GiB**;
  - **file gốc: 2,71 GiB** (22 video, chỉ có một bản trên R2, vault chưa sao lưu);
  - rác: 0,42 GiB (file gốc của video đã xoá, file gốc âm thanh đã xử lý);
  - backup: 0,13 GiB.
- Đã sửa trong #456 lỗi janitor bỏ sót file gốc của track âm thanh khi xoá video. R2 có thêm quy tắc tự huỷ multipart upload dở dang sau 1 ngày.
- Từ #445, player chỉ dùng AV1 khi máy giải mã AV1 bằng phần cứng (`mediaCapabilities` báo `powerEfficient` và `smooth`), hiện là số ít người xem. Mỗi video có hai bộ HLS thì hai nhóm người xem không dùng chung cache edge, trong khi cache-miss đang là nguyên nhân giật chính.
- User muốn giữ AV1 vì sẽ phổ biến hơn, nhưng mở rộng theo nhu cầu thật.

*Quyết định.*
- **Dọn rác:** kiến trúc sư duyệt `storage-gc -apply media-orphan-video,raw-orphan-video,raw-audio-processed`. Nhóm `media-old-attempt` và `media-old-av1` cũng được xoá khi có.
- **AV1 theo top N (AV1POL, user đồng ý 2026-10-23).** `av1-upgrade` có thêm hai biến:
  - `AV1_TOP_N`: `all` (mặc định, giữ hành vi cũ) hoặc một số N;
  - `AV1_KEEP_TOP`: mặc định max(2N, N+5).
  - Mỗi đêm `av1-upgrade` xếp hạng video READY theo lượt xem 7 ngày, rồi:
    1. xoá file của các bộ AV1 đã bị gỡ ở lần chạy trước;
    2. gỡ bộ AV1 của video xếp ngoài hạng `KEEP_TOP` (chỉ trong database, file để lần chạy sau mới xoá, để người đang xem dở xem hết);
    3. chỉ nâng cấp video trong top N.
  - Production bắt đầu với `AV1_TOP_N=5`. Tăng lên 10, 100 hay `all` chỉ cần đổi biến môi trường; lần chạy sau tự làm AV1 từ file gốc.
- **Đo tỷ lệ AV1:** player sẽ báo codec đang phát (H.264 hay AV1) trong dữ liệu lượt xem (contract và video-svc do kiến trúc sư làm, player do Antigravity 1). Khi tỷ lệ máy phát AV1 vượt khoảng 30–40% thì tăng N.
- **File gốc:** Antigravity 2 thêm `winkey-raw` vào lịch sao lưu vault (HDD gpu-01). Có xoá file gốc cũ khỏi R2 hay không, user quyết định sau.

*Hệ quả.*
- R2 giảm khoảng 2–2,5 GiB: 0,42 GiB rác cộng phần lớn 2,21 GiB AV1 của các video ngoài top 5.
- Cache edge tập trung vào một bộ cho các video ít người xem. Video hot vẫn có AV1 cho máy hỗ trợ.
- AV1 có thể mở rộng lại bất cứ lúc nào, vì file gốc vẫn còn.

*Bổ sung 2026-10-26 (AV1-tel, đo tỷ lệ AV1).*
- `PlaybackSample` và event `analytics.playback` có thêm hai field tuỳ chọn:
  - `codec` (`h264` | `av1`): codec của master đang phát, tức URL player thực sự nạp (`hls_av1_url` hay `hls_url`), không phải codec player muốn dùng;
  - `av1_capable` (boolean): kết quả `isAv1Supported()` của máy, kể cả khi video không có bộ AV1.
- video-svc chỉ đưa hai field vào event khi client gửi (bỏ hẳn key, không gửi `null`). Nhờ vậy video-svc deploy trước hay sau worker đều an toàn; chỉ **player** phải đợi analytics-worker mới chạy trên gpu-01, vì worker cũ `DisallowUnknownFields` và sẽ `Term` event lạ.
- ClickHouse `db/clickhouse/0003_codec.sql` thêm hai cột Nullable vào `playback_events`, vào cùng PR với worker. File này có sẵn hai câu truy vấn:
  - tỷ lệ máy AV1 trên các lượt phát 7 ngày;
  - tỷ lệ thời gian xem bằng AV1.
- Ngưỡng tăng `AV1_TOP_N` vẫn như trên: `av1_capable_share` vượt khoảng 30–40%.

*Bổ sung 2026-10-27 (file gốc âm thanh).* Job âm thanh (MUX1) xoá file gốc âm thanh ngay khi track READY: sau đó chỉ bản HLS được dùng, kể cả khi video được encode lại. File gốc của track FAILED vẫn giữ. File gốc video vẫn giữ, vì `av1-upgrade` cần nó. Nếu lần xoá thất bại, `storage-gc` vẫn báo file đó trong nhóm `raw-audio-processed`.

### ADR-049 — Mạng xã hội giải trí: hồ sơ, bảng tin, bảo mật tài khoản, nhắn tin E2EE, gọi thoại/video, xem chung (SOC)

*Bối cảnh (2026-10-27).*
- User muốn Winkey thêm một mạng xã hội giải trí đầy đủ, chuyên nghiệp, hiệu suất cao và bảo mật. User đã chọn (2026-10-27):
  - S1: hồ sơ và bảng tin;
  - S2: bảo mật tài khoản;
  - S3: nhắn tin, có **mã hoá đầu-cuối (E2EE)**;
  - S5: watch party (xem chung);
  - thêm gọi thoại và gọi video.
- Video và ảnh của mạng xã hội phải **nén mạnh hơn** để tiết kiệm dung lượng. Phim và video của creator **giữ nguyên chất lượng hiện tại**.
- Đã có sẵn:
  - bình luận có trả lời, thích, theo dõi kênh (`social.subscriptions`), thông báo (N1/N2), playlist;
  - báo cáo và kiểm duyệt (S4/M1), realtime WebSocket với ticket (`realtime-svc`);
  - phân quyền viewer/creator/moderator/admin (ADR-046), refresh token theo family với phát hiện dùng lại (ADR-019).
- Hạ tầng: một edge OCI (k3s, 4 core / 12 GB arm64), gpu-01 (NVENC, ClickHouse, vault), R2 khoảng 8,6 GiB. Không có ngân sách cho dịch vụ trả phí lớn.
- "Bảo mật tuyệt đối" không tồn tại. Mục tiêu là bảo mật theo chuẩn ngành, có kiểm chứng: test, rate limit, audit log, ít dữ liệu nhất có thể.

*Quyết định.*

**1. Chia đợt.** Mỗi đợt dùng được ngay khi xong. Đợt sau dựa vào đợt trước.

| Đợt | Nội dung | Phụ thuộc |
|---|---|---|
| SOC-1 | **S2 bảo mật tài khoản** + **hồ sơ** (ảnh bìa, giới thiệu, liên kết, tài khoản riêng tư, yêu cầu theo dõi, chặn/tắt tiếng) + **pipeline ảnh xã hội** | — |
| SOC-2 | **Bài đăng và bảng tin**: chữ, ảnh (tối đa 10), video ngắn, gắn video/phim Winkey; reaction; chia sẻ lại; @nhắc tên, #hashtag; bình luận bài đăng; bảng tin "Đang theo dõi" và "Khám phá" | SOC-1 |
| SOC-3 | **Nhắn tin E2EE** 1-1 và nhóm (tối đa 50), tệp đính kèm mã hoá, lời mời nhắn tin từ người lạ | SOC-1 (thiết bị + 2FA) |
| SOC-4 | **Gọi thoại / video** 1-1 (WebRTC P2P qua TURN), rồi gọi nhóm (tối đa 8 người có video) qua SFU | SOC-3 (khoá E2EE, danh bạ chặn) |
| SOC-5 | **Watch party**: xem chung đồng bộ, chat phòng, gọi thoại trong phòng | SOC-4 (SFU), realtime |

Mỗi đợt có ADR bổ sung riêng, gồm contract, migration và brief. Phần dưới đây là các nguyên tắc chung mà các ADR bổ sung phải tuân theo.

**2. Phân chia dịch vụ (giữ ranh giới hiện tại).**
- `auth-svc` (Antigravity 3):
  - 2FA TOTP, passkey (WebAuthn), danh sách thiết bị và phiên;
  - xác thực lại (step-up) cho thao tác nhạy cảm, cảnh báo đăng nhập lạ;
  - trường hồ sơ mở rộng trong `auth.public_profiles`;
  - cờ `is_private`.
- `social-svc` (Antigravity 3): yêu cầu theo dõi, chặn/tắt tiếng, bài đăng, reaction, hashtag, mention, chia sẻ lại, bảng tin, bình luận bài đăng (dùng lại mô hình bình luận hiện có, `target_type`).
- `chat-svc` **mới** (Node, Antigravity 3):
  - chỉ chuyển tiếp và lưu ciphertext;
  - giữ khoá công khai của thiết bị (prekey bundle);
  - quản lý hội thoại, thành viên và lời mời.
  Tách khỏi social-svc vì dữ liệu, mức độ nhạy cảm và tải khác hẳn. Database riêng schema `chat`, role riêng.
- `realtime-svc` (Antigravity 3): thêm room `chat:{conversation}`, `call:{id}`, `party:{id}`; chuyển tín hiệu WebRTC (signaling); đồng hồ máy chủ cho watch party.
- `upload-svc` + `transcoder` (kiến trúc sư): pipeline media xã hội (mục 4).
- Hạ tầng mới (Antigravity 2):
  - `coturn` (TURN/STUN) trên edge;
  - **LiveKit** SFU (mã nguồn mở, Go, có E2EE qua insertable streams) cho gọi nhóm và watch party, bắt đầu ở SOC-4.
  Cả hai build đa kiến trúc hoặc dùng image chính thức có arm64.
- Web (Antigravity 1): toàn bộ UI. System test (Antigravity 4): persona mới cho từng đợt.
- Danh tính: vẫn chỉ tin `X-User-Id` / `X-User-Roles` từ gateway. WebSocket vẫn dùng ticket. Không parse JWT ngoài auth-svc.
- Sự kiện xã hội vẫn đi qua outbox (ADR-008). **Tin nhắn E2EE không đi qua outbox hay JetStream dạng đọc được**: chat-svc ghi ciphertext vào database, rồi chỉ báo "có tin mới" (không có nội dung) qua realtime.

**3. Bảo mật tài khoản (SOC-1, bắt buộc trước khi có nhắn tin).**
- **2FA TOTP** (RFC 6238, chu kỳ 30 s, cho lệch ±1 bước):
  - secret mã hoá khi lưu bằng khoá ứng dụng (AES-256-GCM, khoá lấy từ env, có `key_id` để xoay khoá);
  - 10 mã khôi phục dùng một lần (chỉ lưu hash Argon2id);
  - chống dùng lại cùng mã trong cùng chu kỳ.
- **Passkey (WebAuthn)**: đăng nhập không mật khẩu và làm yếu tố thứ hai. Mỗi tài khoản tối đa 10 passkey. Đúng `rp_id` = `winkey.vn`.
- **Bắt buộc 2FA** cho moderator và admin: chưa bật 2FA thì không dùng được quyền đó.
- **Danh sách phiên/thiết bị:**
  - mỗi refresh family hiển thị loại thiết bị (từ User-Agent), quốc gia (từ IP lúc đăng nhập) và lần dùng cuối;
  - **không lưu IP rõ**, chỉ lưu quốc gia và hash IP có salt (dùng để phát hiện "thiết bị mới");
  - người dùng thu hồi được từng phiên hoặc tất cả.
- **Cảnh báo đăng nhập lạ**: email khi đăng nhập từ thiết bị hoặc quốc gia mới; liên kết "Không phải tôi" thu hồi phiên đó.
- **Xác thực lại (step-up, 10 phút)** trước các thao tác:
  - đổi email/mật khẩu, tắt 2FA, xoá passkey;
  - xoá tài khoản, xuất khoá E2EE.
- **Chống lạm dụng:**
  - giới hạn tần suất theo tài khoản và IP cho đăng nhập, đăng ký, đăng bài, gửi tin, gửi lời mời theo dõi/nhắn tin;
  - Cloudflare Turnstile (miễn phí) khi đăng ký và sau nhiều lần đăng nhập sai;
  - mật khẩu bị lộ kiểm tra bằng k-anonymity (Pwned Passwords range API, chỉ gửi 5 ký tự đầu của SHA-1), nếu API lỗi thì bỏ qua.
- **Audit log bảo mật**: bật/tắt 2FA, thêm/xoá passkey, đăng nhập mới, thu hồi phiên, đổi email/mật khẩu. Người dùng xem được log của mình; giữ 1 năm.
- **Web:**
  - CSP chặt (nonce, không `unsafe-inline` cho script);
  - `Trusted Types` khi khả thi; HSTS preload;
  - cookie `__Host-`;
  - nội dung người dùng chỉ render dạng text hoặc qua sanitizer (không HTML tự do).

**4. Media xã hội nén mạnh (phim không đổi).**
- Mỗi media có `purpose`: `film` (video hiện tại, giữ nguyên ladder, AV1 top N, giữ file gốc) | `social_image` | `social_video` | `avatar` | `banner`.
- **Ảnh** (`social_image`, `avatar`, `banner`) xử lý trên gpu-01 bằng FFmpeg/libwebp:
  - xoá toàn bộ EXIF/metadata (GPS);
  - xoay theo orientation;
  - cạnh dài tối đa 1600 px (bài đăng), 2048×768 (ảnh bìa), 400 px (avatar) và một bản thumbnail 320 px;
  - **WebP chất lượng khoảng 72**; chặn ảnh động trừ GIF ngắn (chuyển sang video).
  - Mục tiêu khoảng 150–300 KB mỗi ảnh bài đăng.
  - **Xoá file gốc ngay khi xử lý xong.**
- **Video xã hội** (`social_video`):
  - tối đa 3 phút (cấu hình được);
  - chỉ 2 rendition H.264 **720p và 360p**, CRF cao hơn phim (capped CRF, mục tiêu khoảng 1,2 Mbps ở 720p), AAC 96 kbps;
  - không làm bộ AV1, không storyboard;
  - **xoá file gốc khi READY.**
  - Mục tiêu khoảng 10 MB mỗi phút.
- **Nén trước ở trình duyệt**: resize ảnh trước khi upload để tiết kiệm băng thông. Server vẫn luôn xử lý lại, không tin file client.
- **Tệp trong tin nhắn E2EE**:
  - server **không thể nén** vì chỉ thấy ciphertext, nên trình duyệt nén trước rồi mới mã hoá (ảnh WebP khoảng 1600 px, video giới hạn kích thước);
  - mã hoá AES-256-GCM khoá ngẫu nhiên mỗi tệp, khoá gửi trong tin nhắn E2EE;
  - tệp đính kèm **hết hạn sau 30 ngày** (cấu hình được) để giới hạn dung lượng.
- Bucket: dùng `winkey-media` cho media xã hội công khai (đường dẫn `s/{owner}/{media}/`). Bucket riêng `winkey-chat` cho ciphertext tin nhắn, có lifecycle rule xoá sau 30 ngày.
- `storage-gc` thêm category cho các prefix mới.

**5. Nhắn tin E2EE (SOC-3).**
- **Không tự viết thuật toán mật mã.** Dùng thư viện đã được kiểm toán độc lập:
  - ứng viên chính: **vodozemac** (Rust, triển khai Olm = Double Ratchet cho 1-1 và Megolm = sender key cho nhóm, được Least Authority kiểm toán năm 2022) biên dịch sang WebAssembly;
  - phương án dự phòng: **libsignal**.
  - Trước khi viết contract SOC-3, làm **spike** (kiến trúc sư + Antigravity 1) để chọn thư viện, đo kích thước WASM và kiểm tra hỗ trợ trình duyệt.
- **Mô hình thiết bị:**
  - mỗi thiết bị (trình duyệt) có khoá định danh riêng, sinh và giữ ở trình duyệt (IndexedDB, khoá không xuất được qua WebCrypto khi có thể);
  - server chỉ giữ khoá công khai và one-time prekey.
  - Tin nhắn mã hoá cho **từng thiết bị** của người nhận và các thiết bị khác của người gửi.
- **Xác minh:**
  - mã an toàn (safety number / QR) để hai người tự so;
  - cảnh báo trong hội thoại khi khoá thiết bị của bên kia thay đổi hoặc có thiết bị mới.
- **Lịch sử trên thiết bị mới**: sao lưu khoá **tuỳ chọn**, mã hoá bằng cụm mật khẩu khôi phục do người dùng đặt (Argon2id phía client). Server chỉ giữ blob đã mã hoá. Quên cụm mật khẩu thì mất lịch sử; đó là đặc tính, không phải lỗi.
- **Server thấy gì:**
  - thấy siêu dữ liệu: ai nhắn với ai, lúc nào, kích thước;
  - không thấy nội dung tin nhắn, tệp, tên nhóm (tên nhóm cũng mã hoá).
  - Thông báo đẩy và chuông thông báo không chứa nội dung.
- **Chống lạm dụng khi không đọc được nội dung:**
  - người lạ phải gửi "lời mời nhắn tin", người nhận chấp nhận mới nhận tin;
  - chặn và tắt tiếng; giới hạn tần suất;
  - **báo cáo** = người nhận tự gửi kèm bản giải mã của các tin bị báo cáo (moderator chỉ thấy những gì người báo cáo gửi).
  - Admin **không thể** đọc tin nhắn. Điều này được ghi rõ trong chính sách quyền riêng tư.
- Tin nhắn trong hàng đợi (người nhận offline) giữ ciphertext tối đa 30 ngày.

**6. Gọi thoại / video (SOC-4).**
- **1-1:**
  - WebRTC P2P, signaling qua realtime-svc;
  - DTLS-SRTP mã hoá sẵn; vân tay DTLS được ký trong kênh E2EE của SOC-3 để chống người ở giữa (MITM) qua signaling.
  - TURN `coturn` trên edge với thông tin đăng nhập tạm (REST API, HMAC, sống 10 phút), chỉ relay, chặn relay tới dải IP nội bộ.
- **Nhóm (tối đa 8 người có video, 20 người chỉ thoại):** LiveKit SFU trên edge, bật E2EE (insertable streams; khoá phân phối qua Megolm của nhóm chat). Trình duyệt không hỗ trợ insertable streams thì không vào được cuộc gọi nhóm E2EE (báo rõ).
- Không ghi âm/ghi hình phía server.
- Băng thông relay của edge có giới hạn. Có metric và giới hạn số cuộc gọi đồng thời (cấu hình được).

**7. Watch party (SOC-5).**
- Phòng `party:{id}` trong realtime-svc. Chủ phòng (hoặc người được giao quyền) điều khiển phát, dừng, tua.
- Server giữ trạng thái chuẩn `{video_id, playing, position_ms, server_ts}`. Client chỉnh lệch hơn 500 ms bằng tốc độ phát, lệch hơn 3 s thì tua.
- Chỉ phát được video người xem có quyền xem (PUBLIC/UNLISTED, hoặc PRIVATE của chính chủ phòng với thành viên được mời). Mỗi thành viên vẫn tự lấy URL đã ký của mình.
- Chat trong phòng: **không E2EE** (phòng có thể đông, cần kiểm duyệt). Có rate limit và báo cáo. Tin nhắn mất khi phòng đóng.
- Gọi thoại trong phòng dùng LiveKit (mục 6).
- Tối đa 20 người mỗi phòng lúc đầu.

**8. Bảng tin (SOC-2).**
- Fan-out khi đọc từ PostgreSQL:
  - bài của những người đang theo dõi, keyset theo `(created_at, id)`;
  - cache trang đầu trong Valkey 30 s.
  Ở quy mô hiện tại không cần fan-out khi ghi.
- "Khám phá" xếp hạng bài công khai bằng điểm tương tác có suy giảm theo thời gian, tính lại định kỳ (giống trending ADR-020).
- Bài của tài khoản riêng tư chỉ người theo dõi đã được duyệt thấy. Người bị chặn không thấy bài, hồ sơ, không nhắn tin, không gọi được. Quan hệ chặn có hiệu lực ở mọi dịch vụ.

**9. Hiệu suất.**
- Mọi danh sách phân trang bằng cursor; mọi truy vấn bảng tin có index phù hợp và test EXPLAIN trong CI cho các truy vấn chính.
- Mục tiêu p95 trên edge hiện tại:
  - bảng tin dưới 150 ms;
  - gửi tin nhắn (server nhận ciphertext) dưới 100 ms;
  - thiết lập cuộc gọi 1-1 dưới 3 s.
- Antigravity 4 thêm kịch bản tải cho từng đợt.

**10. Pháp lý (user chịu trách nhiệm, cần tư vấn luật).**
Mạng xã hội tại Việt Nam có nghĩa vụ nặng hơn trang video, cần xác nhận trước khi mở công khai các tính năng SOC:
- giấy phép mạng xã hội;
- xác thực tài khoản (số điện thoại) theo Nghị định 147/2024/NĐ-CP;
- thời hạn gỡ nội dung vi phạm;
- lưu trữ và cung cấp thông tin.

Nhắn tin E2EE và gọi E2EE có thể ảnh hưởng tới nghĩa vụ cung cấp thông tin. Kiến trúc sư không đưa ra tư vấn pháp lý. Task `LEGAL` mở rộng thêm phạm vi SOC. Có thể triển khai và kiểm thử trên beta kín trong lúc chờ.

*Hệ quả.*
- Thêm `chat-svc`, `coturn`, LiveKit; edge cần theo dõi CPU, RAM và băng thông. Gọi nhóm và watch party có video sẽ là phần tốn tài nguyên nhất.
- R2 tăng chậm nhờ:
  - nén mạnh, xoá file gốc của media xã hội;
  - tệp chat hết hạn sau 30 ngày.
  Phim giữ nguyên.
- Lịch sử tin nhắn có thể mất nếu người dùng không bật sao lưu khoá. Moderator không đọc được tin nhắn. Hai điều này là đánh đổi có chủ ý để có E2EE.
- Khối lượng lớn nhất thuộc Antigravity 3 (auth, social, chat, realtime). Thứ tự trong mỗi đợt: contract và migration (kiến trúc sư) → backend → web → system test → deploy.
