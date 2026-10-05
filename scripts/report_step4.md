**[Antigravity 2] Báo cáo Hoàn tất Cửa sổ Di chuyển Lưu trữ Cloudflare R2 (INF-R2a - Bước 4)**

Kính gửi Architect và Team, Antigravity 2 đã hoàn tất toàn bộ các bước trong cửa sổ di chuyển lưu trữ sang Cloudflare R2 (Bước 4) trên cả `edge-1` và `gpu-01` theo đúng yêu cầu từ review của Architect trên #47.

---

### 1. Kết quả Sao chép & Đối soát Checksum (Garage → R2)
- Toàn bộ dữ liệu được sao chép bằng Job Kubernetes `r2-data-migration` (`rclone copy`) và kiểm tra bằng `rclone check`:
  - **`winkey-raw`**: 9 / 9 objects (837.082 MiB) — **0 differences found**!
  - **`winkey-media`**: 332 / 332 objects (450.475 MiB) — **0 differences found**!
  - **`winkey-pg-backup`**: 1,425 / 1,425 objects (120.864 MiB) — **0 differences found**!
- **Cam kết an toàn dữ liệu**: Garage trên `edge-1` vẫn được giữ nguyên trạng thái 100% dữ liệu (read-only), không xoá bất kỳ object nào trong vòng 7 ngày tới.

---

### 2. Header Parity (Trước vs Sau khi chuyển sang `media-origin`)
Đã kiểm tra so sánh chi tiết giữa Garage (trước) và `media-origin` (`rclone serve http:8080` + Traefik middleware `media-headers` + Host Nginx proxy_cache) qua domain `https://media.winkey.vn`:

| Định dạng file | Header trước (Garage) | Header sau (`media-origin` / R2) | Kết quả đối soát |
|---|---|---|---|
| **`.m3u8`** (`master.m3u8`) | `Content-Type: application/vnd.apple.mpegurl`<br>`Cache-Control: public, max-age=31536000, immutable` | `content-type: application/vnd.apple.mpegurl`<br>`cache-control: public, max-age=31536000, immutable` | **MATCH (100%)** |
| **`.m4s`** (`seg_00000.m4s`) | `Content-Type: video/mp4`<br>`Cache-Control: public, max-age=31536000, immutable` | `content-type: video/mp4`<br>`cache-control: public, max-age=31536000, immutable` | **MATCH (100%)** |
| **`init.mp4`** (`init_0.mp4`) | `Content-Type: video/mp4`<br>`Cache-Control: public, max-age=31536000, immutable` | `content-type: video/mp4`<br>`cache-control: public, max-age=31536000, immutable` | **MATCH (100%)** |
| **`.jpg`** (`poster.jpg`) | `Content-Type: image/jpeg`<br>`Cache-Control: public, max-age=31536000, immutable` | `content-type: image/jpeg`<br>`cache-control: public, max-age=31536000, immutable` | **MATCH (100%)** |
| **`.vtt`** (`storyboard.vtt`) | `Content-Type: text/vtt`<br>`Cache-Control: public, max-age=31536000, immutable` | `content-type: text/vtt`<br>`cache-control: public, max-age=31536000, immutable` | **MATCH (100%)** |

Tất cả các định dạng khi cache HIT trên Nginx đều trả đúng `x-cache-status: HIT`, `access-control-allow-origin: *`, `x-content-type-options: nosniff`.

---

### 3. Barman WAL Archiving với Cloudflare R2
- Cập nhật `postgres-cluster.yaml` chuyển Barman sang endpoint `https://2588dff2e56bf889918bc5c7af53ad86.r2.cloudflarestorage.com` và secret `r2-pg-backup`.
- Đã test switch WAL (`SELECT pg_switch_wal()`):
  - WAL `000000010000000500000052`: Lưu trữ thành công vào R2 trong 1.59s.
  - WAL `000000010000000500000053`: Lưu trữ thành công vào R2 trong 1.62s.
- `pg_stat_archiver`: `archived_count` tăng đều, không phát sinh lỗi checksum (`failed_count = 0` trên tiến trình lưu trữ mới). Không cần áp dụng fallback checksum environment variables.

---

### 4. Kết quả End-to-End Smoke Test (Lifecycle Video)
Kịch bản kiểm thử tự động toàn diện bằng script `smoke_test_r2.py` đã thực thi thành công:
1. **Presigned Upload**: `POST /v1/uploads` và `POST /v1/uploads/{id}/parts` trả URL trỏ thẳng tới Cloudflare R2 endpoint.
2. **Direct S3 PUT**: Upload part video trực tiếp lên R2 thành công (`HTTP 200`, ETag ghi nhận).
3. **Complete Multipart**: `POST /v1/uploads/{id}/complete` nhận `HTTP 202 Accepted` và bắn event sang NATS JetStream.
4. **Transcoder trên `gpu-01`**: Nhận job, tải raw video từ R2 (`winkey-raw`), encode HLS 720p/480p + storyboard + poster bằng x264 trong 2.8s, tải lên `winkey-media` trên R2, update DB chuyển trạng thái sang `READY`.
5. **Public Video Playback**: `GET https://media.winkey.vn/v/{id}/a1/hls/master.m3u8` trả về `HTTP 200 OK`.
6. **Unlisted Video**: Đổi visibility sang `UNLISTED`, phát video thành công.
7. **Private Video & Signed URL**:
   - Đổi visibility sang `PRIVATE`.
   - URL thường tự động bị gate chặn và trả về `HTTP 403 Forbidden` sau khi hết hạn 30s cache auth của Nginx.
   - Chủ sở hữu lấy URL có chữ ký qua API (`/s/{exp}/{sig}/...`), phát video trả về `HTTP 200 OK`.
8. **Delete & Janitor Purge**:
   - `DELETE /v1/videos/{id}` trả về `HTTP 204 No Content`.
   - Gate chặn hoàn toàn URL thường (`HTTP 403`).
   - Transcoder/Janitor nhận event `video.deleted` và tự động dọn dẹp sạch prefix trên R2 (`winkey-raw/{id}/` và `winkey-media/v/{id}/`), đối soát lại bằng `rclone lsf` cho kết quả rỗng.

---

### 5. Cấu hình Tài nguyên & Trạng thái Hệ thống
- **Nâng tài nguyên Alloy**: Đã cập nhật `deploy/k8s/observability/alloy-daemonset.yaml` lên `requests: 256Mi` / `limits: 384Mi` và rollout thành công trên daemonset `alloy`.
- **Mở lại luồng Upload**: `upload-svc` đã được scale về `replicas: 1`, kiểm tra log và endpoint sẵn sàng hoạt động bình thường.
- Số lượng video trên DB `media.videos`: Giữ nguyên chính xác **2 video KEEP** được chỉ định (`01a0f6df-f3ab-77f9-a673-03efade93dff` và `01a0f6e2-58da-72f0-b3a9-e65c31693b88`).

---

### 6. Đề xuất Bước tiếp theo
Toàn bộ Bước 4 đã xanh (green). Antigravity 2 sẵn sàng tiếp tục các bước tiếp theo trong Phase INF-R2a:
- **Bước 5**: Cấu hình snapshot etcd hàng ngày và ClickHouse backup sang `winkey-backup`.
- **Bước 6**: Thực hiện diễn tập khôi phục PostgreSQL từ R2 (`PostgreSQL restore drill`) sang instance phụ/scratch.
- **Bước 7**: Chuyển `proxy_cache` Nginx của `edge-1` sang phân vùng `/var/lib/garage/data` LV sau thời gian kiểm chứng.
- **Bước 8**: Cấu hình Interim Vault trên `gpu-01`.
