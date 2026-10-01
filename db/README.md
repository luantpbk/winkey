# Database

PostgreSQL ≥ 16 (production target: 17, chạy bằng CloudNativePG). Migration dùng [golang-migrate](https://github.com/golang-migrate/migrate). **Chỉ architect (Opus) thêm hoặc sửa migration.** Service nào cần đổi schema thì mở issue gắn nhãn `contract-change`.

## Schema & quyền sở hữu

| Schema | Service ghi | Service được đọc | Ghi chú |
|---|---|---|---|
| `auth` | auth-svc | mọi service: **chỉ** view `auth.public_profiles` | Không bao giờ để service khác đọc `auth.users` |
| `media` | upload-svc, transcoder, video-svc | video-svc | Chung một domain media |
| `social` | social-svc | — | Comment 2 cấp, like video, subscription; projection `social.videos` từ `video.ready`/`video.deleted` (migration 000005); thông báo trong app `social.notifications` (migration 000013, ADR-023); playlist và xem sau `social.playlists`/`social.playlist_items` (migration 000014, ADR-024) |
| `analytics` | analytics-worker (role `analytics_svc`, từ gpu-01) | video-svc: `SELECT` trên `analytics.video_daily` | Thống kê theo ngày cho creator, tổng hợp từ ClickHouse (migration 000015, ADR-022 bổ sung R1-b). Ngày theo `Asia/Ho_Chi_Minh` |

- Không tạo FK chéo schema (ví dụ `media.videos.owner_id` → `auth.users.id`). Tính nhất quán được giữ bằng event (ADR-007).
- ID là **UUIDv7 do ứng dụng sinh ra**, nên cột ID không có default.
- Mỗi schema có bảng `outbox` riêng phục vụ transactional outbox (xem `contracts/events/README.md`).
- `media.videos.status` được bảo vệ bằng trigger `media.guard_video_status` (máy trạng thái). Service vẫn phải dùng `UPDATE … WHERE status = $expected` để phát hiện race.

## Chạy

```bash
# áp dụng
migrate -path db/migrations -database "$DATABASE_URL" up
# kiểm tra đầy đủ: up → down -all → up → SQL tests (db/tests/*.sql, mỗi file chạy trong 1 transaction rollback)
DATABASE_URL=postgres://winkey:winkey@localhost:5432/winkey?sslmode=disable make db-test
```

Migration chạy bằng role **owner của database, không cần superuser**. Các extension `citext`, `pg_trgm`, `unaccent` đều thuộc loại trusted.

## Role khi chạy (infra tạo, không nằm trong migration vì có mật khẩu)

| Role | Quyền |
|---|---|
| `winkey_migrator` | owner của DB, chỉ dùng cho job migrate |
| `auth_svc` | `USAGE` trên `auth`; CRUD trên các bảng `auth.*` |
| `media_svc` | `USAGE` trên `media`; CRUD trên các bảng `media.*`; `USAGE` trên `auth` + `SELECT` **chỉ** trên `auth.public_profiles` |
| `social_svc` | `USAGE` trên `social`; CRUD trên các bảng `social.*`; `USAGE` trên `auth` + `SELECT` **chỉ** trên `auth.public_profiles` |
| `analytics_svc` | `USAGE` trên `analytics`; CRUD trên các bảng `analytics.*`. Không có quyền gì khác |
| `media_svc` (bổ sung) | `USAGE` trên `analytics` + `SELECT` **chỉ** trên `analytics.video_daily` |

## ClickHouse (analytics, ADR-022)

`db/clickhouse/NNNN_*.sql` là schema ClickHouse trên gpu-01, **không** phải migration PostgreSQL: golang-migrate và `make db-test` không đụng tới, và không copy sang `deploy/k8s/data/migrations`. Cũng chỉ architect được sửa.

- Mỗi câu lệnh idempotent (`IF NOT EXISTS`). analytics-worker áp dụng các file theo thứ tự tên lúc khởi động và ghi tên file vào `winkey.schema_migrations`.
- Không sửa file đã áp dụng; muốn đổi thì thêm file mới.
- Mọi `INSERT` vào `winkey.playback_events` phải kèm `insert_deduplication_token` và `deduplicate_blocks_in_dependent_materialized_views = 1`. Lý do nằm ở chú thích đầu file 0001.
