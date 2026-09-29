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
- Tối đa **2 job NVENC song song** (giới hạn phiên của GeForce).
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

