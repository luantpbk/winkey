# Events

Chỉ architect (Opus) sửa thư mục này. Cần đổi contract thì mở issue gắn nhãn `contract-change`.

## Quy ước

- Mọi event đều dùng [`envelope.schema.json`](envelope.schema.json). `event_id` là UUIDv7 và cũng được gửi làm header `Nats-Msg-Id`, để JetStream khử trùng lặp (duplicate window 2 phút).
- **Event bền (domain event)** được publish qua **transactional outbox**. Service ghi row vào `<schema>.outbox` trong cùng transaction với thay đổi nghiệp vụ, rồi một relay goroutine publish lên JetStream và set `published_at`. Không publish thẳng từ handler.
- **Event tạm thời (realtime)** như progress đi qua **core NATS** (không lưu). Mất message cũng không sao, vì trạng thái thật nằm trong DB.
- Consumer bắt buộc phải **idempotent**: cùng một `event_id` có thể đến nhiều lần.
- Thay đổi không tương thích (breaking) thì tăng `version` và publish song song cả hai version trong giai đoạn chuyển đổi.

## Danh mục

| Subject | Loại | Producer | Consumer (hiện tại/dự kiến) | Schema |
|---|---|---|---|---|
| `video.uploaded` | JetStream `VIDEO` | upload-svc | transcoder | [video.uploaded](video.uploaded.schema.json) |
| `video.ready` | JetStream `VIDEO` | transcoder | realtime-gw, search (P2), notify (P3) | [video.ready](video.ready.schema.json) |
| `video.failed` | JetStream `VIDEO` | transcoder | realtime-gw | [video.failed](video.failed.schema.json) |
| `video.deleted` | JetStream `VIDEO` | video-svc | media-janitor (transcoder), search | [video.deleted](video.deleted.schema.json) |
| `video.moderated` | JetStream `VIDEO` | video-svc (A2) | social-svc (projection `social.videos.hidden`), search (P2) | [video.moderated](video.moderated.schema.json) |
| `video.visibility_changed` | JetStream `VIDEO` | video-svc (C4) | social-svc (projection `social.videos.visibility`) | [video.visibility_changed](video.visibility_changed.schema.json) |
| `user.registered` | JetStream `USER` | auth-svc | (P2+) | [user.registered](user.registered.schema.json) |
| `social.comment.created` | JetStream `SOCIAL` | social-svc | realtime-gw (C2) | [social.comment.created](social.comment.created.schema.json) |
| `social.video.like_changed` | JetStream `SOCIAL` | social-svc | video-svc (cập nhật `media.videos.like_count`), realtime-gw (C2) | [social.video.like_changed](social.video.like_changed.schema.json) |
| `social.subscription.changed` | JetStream `SOCIAL` | social-svc | video-svc (feed theo dõi, R2-b) | [social.subscription.changed](social.subscription.changed.schema.json) |
| `analytics.playback` | JetStream `ANALYTICS` (telemetry, không qua outbox) | video-svc (R1) | analytics-worker trên gpu-01 → ClickHouse | [analytics.playback](analytics.playback.schema.json) |
| `rt.video.{video_id}.progress` | core NATS | transcoder | realtime-gw, upload-svc (cache) | [video.progress](video.progress.schema.json) |
| `dlq.video.uploaded` | JetStream `DLQ` | transcoder | con người (replay tool) | bản gốc của `video.uploaded` |

## Cấu hình stream (Antigravity 2 tạo bằng IaC)

| Stream | Subjects | Storage | Replicas | Max age | Duplicate window |
|---|---|---|---|---|---|
| `VIDEO` | `video.>` | file | 3 | 7d | 2m |
| `USER` | `user.>` | file | 3 | 7d | 2m |
| `SOCIAL` | `social.>` | file | 3 | 7d | 2m |
| `DLQ` | `dlq.>` | file | 3 | 30d | 2m |
| `ANALYTICS` | `analytics.>` | file | 1 | 7d, **`max_bytes` 5 GiB, `discard: old`** | 2m |

Giai đoạn 1 VPS (ADR-013) dùng `replicas: 1`, nâng lên 3 khi có cluster NATS 3 node. Retention là `limits`, không dùng `workqueue`, để nhiều consumer độc lập đọc được cùng một subject. `ANALYTICS` (ADR-022) giữ `replicas: 1` kể cả sau này: đây là telemetry, mất một phần chấp nhận được, và `max_bytes` + `discard: old` bảo đảm gpu-01 tắt lâu ngày cũng không làm đầy đĩa edge-1.

**Telemetry khác domain event.** `analytics.*` được video-svc publish thẳng từ handler (không outbox, ngoại lệ có chủ đích với ADR-008): mất vài sample không làm sai trạng thái nghiệp vụ nào, còn đi qua outbox thì mỗi heartbeat thành một lần ghi PostgreSQL. `event_id` là UUIDv5 tính từ `playback_id:seq`, nên client gửi lại cùng sample sẽ bị JetStream khử trùng lặp.

## Consumer của realtime-gw

Mỗi pod realtime-gw cần mọi event nên dùng consumer JetStream **ephemeral, ordered**, `deliver_policy: new`, không dùng durable dùng chung. Chi tiết: [`../realtime/README.md`](../realtime/README.md).

## Consumer của social-svc

social-svc giữ projection `social.videos` (video nào nhận được comment/like) từ stream `VIDEO`:

- Durable `social-videos`, pull, `filter_subjects: [video.ready, video.deleted, video.moderated, video.visibility_changed]`, `ack_policy: explicit`, `ack_wait: 30s`, `max_deliver: 5`. (A2 thêm `video.moderated`: sửa `filter_subjects` của durable đang có bằng `consumers.update`, không tạo durable mới.)
- `video.ready` → `INSERT … ON CONFLICT (id) DO NOTHING` (re-encode gửi lại event). `video.deleted` → `DELETE` (cascade comment + like). Cả hai idempotent.
- `video.moderated` → `UPDATE social.videos SET hidden = (state = 'HIDDEN') WHERE id = video_id` (idempotent). Video chưa có trong projection thì bỏ qua và ack. Vì consumer xử lý tuần tự theo thứ tự stream, trạng thái cuối luôn khớp với video-svc.
- `video.visibility_changed` (C4) → `UPDATE social.videos SET visibility = $visibility WHERE id = video_id` (idempotent; video chưa có trong projection thì bỏ qua và ack). `video.ready` mang `visibility` từ C4: upsert ghi cả `visibility` (event cũ không có trường này → giữ giá trị hiện có, mặc định `PUBLIC`).
- Thông báo N1 (ADR-023): trong **cùng transaction** với cập nhật projection, nếu event làm video chuyển từ "chưa có / không `PUBLIC`" sang `PUBLIC` và `hidden = false` thì chèn `VIDEO_PUBLISHED` cho mọi subscriber của `owner_id` (`ON CONFLICT DO NOTHING`). Thông báo `social.comment.created` / `social.subscription.changed` **không** đi qua event: social-svc tạo chúng ngay trong transaction ghi comment / subscription.

## Consumer của video-svc cho feed theo dõi (R2-b)

- Durable `video-subscriptions` trên stream `SOCIAL`, pull, `filter_subject: social.subscription.changed`, `deliver_policy: all` (lần đầu phát lại cả 7 ngày của stream, sau khi migration 000012 đã backfill từ `social.subscriptions`), `ack_policy: explicit`, `ack_wait: 30s`, **`max_ack_pending: 1`, `max_deliver: -1`** (thứ tự nghiêm ngặt: event sau chỉ được giao khi event trước đã ack; lỗi tạm thời không bao giờ làm mất thay đổi, hàng đợi chờ DB; `Term` chỉ dành cho event sai định dạng).
- `subscribed = true` → `INSERT … ON CONFLICT DO NOTHING`; `false` → `DELETE`. Xử lý tuần tự theo thứ tự stream nên trạng thái cuối khớp social-svc. Event sai schema → `Term()`.

## Consumer `analytics-worker` (R1, ADR-022)

- Chạy trên gpu-01 (ngoài k3s, như transcoder, ADR-015), nối NATS qua NodePort Tailscale 30422.
- Durable `analytics-clickhouse` trên stream `ANALYTICS`, pull, `filter_subject: analytics.playback`, `deliver_policy: all`, `ack_policy: explicit`, `ack_wait: 60s`, `max_deliver: -1`, `max_ack_pending: 20000`.
- Lấy theo lô (tối đa 5 000 message hoặc 2 s), ghi **một** `INSERT` vào ClickHouse, **chỉ ack cả lô sau khi INSERT thành công**. INSERT lỗi thì không ack (NAK có delay), cả lô được giao lại. Trùng lặp được bảng `ReplacingMergeTree` khử theo `event_id`.
- Event sai schema hoặc version lạ: `Term()` + metric, không chặn lô.
- gpu-01 tắt: message nằm chờ trong stream (tối đa 7 ngày / 5 GiB). Khi bật lại, worker đọc bù từ chỗ đã ack.

## Consumer `transcoder`

- Durable, pull, `filter_subject: video.uploaded`, `ack_policy: explicit`, **`ack_wait: 2m`, `max_deliver: 3`**, không đặt `backoff`: nếu đặt `backoff` thì `ack_wait` bị ghi đè, xung đột với heartbeat.
- Trong lúc xử lý, worker gọi `msg.InProgress()` mỗi 30s.
- Lỗi retry được: `NakWithDelay(1m × lần_giao)`.
- Lỗi không retry được (input hỏng): cập nhật DB sang `FAILED`, ghi `video.failed` vào outbox, rồi `Term()`.
- Lần giao cuối (`NumDelivered == max_deliver`) vẫn lỗi: xử lý như lỗi không retry được, và copy message gốc sang `dlq.video.uploaded`.

## Kiểm tra

```bash
make contracts-lint   # redocly lint + biên dịch mọi JSON Schema + validate examples/
```
