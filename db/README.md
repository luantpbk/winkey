# Database

PostgreSQL ≥ 16 (production target: 17, chạy bằng CloudNativePG). Migration dùng [golang-migrate](https://github.com/golang-migrate/migrate). **Chỉ architect (Opus) thêm hoặc sửa migration.** Service nào cần đổi schema thì mở issue gắn nhãn `contract-change`.

## Schema & quyền sở hữu

| Schema | Service ghi | Service được đọc | Ghi chú |
|---|---|---|---|
| `auth` | auth-svc | mọi service: **chỉ** view `auth.public_profiles` | Không bao giờ để service khác đọc `auth.users` |
| `media` | upload-svc, transcoder, video-svc | video-svc | Chung một domain media |
| `social` | social-svc | — | Comment 2 cấp, like video, subscription; projection `social.videos` từ `video.ready`/`video.deleted` (migration 000005) |

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
