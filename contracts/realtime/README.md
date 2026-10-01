# Realtime (WebSocket) — realtime-gw

Chỉ architect (Opus) sửa thư mục này. Cần đổi contract thì mở issue gắn nhãn `contract-change`.
Service: `services/realtime` (Antigravity 3, task C2). Phần HTTP (ticket, upgrade) nằm trong
[`../openapi/realtime.v1.yaml`](../openapi/realtime.v1.yaml); message WebSocket nằm trong
[`client.schema.json`](client.schema.json) (client → server) và [`server.schema.json`](server.schema.json)
(server → client).

## Mục tiêu và giới hạn

- Đẩy thay đổi nhỏ tới trình duyệt: tiến độ transcode trong Studio, video READY/FAILED, comment mới,
  số like mới, reply vào comment của mình.
- **At-most-once, không replay.** Mất message khi mất kết nối là chấp nhận được: trạng thái thật luôn
  nằm ở REST API. Sau mỗi lần (re)connect client phải subscribe lại và **tải lại trạng thái qua REST**.
- realtime-gw **không có database**, không ghi outbox, không parse JWT (ADR-009).

## Kết nối

1. Client đã đăng nhập gọi `POST /v1/realtime/ticket` (qua gateway, có `Authorization`) và nhận
   `ticket` dùng **một lần**, sống **30 giây**. Ticket lưu trong Valkey:
   `rt:ticket:{sha256(ticket)} → {user_id, roles}`, xóa ngay khi đổi (dùng `GETDEL`).
   Lý do: trình duyệt không gửi được header `Authorization` khi mở WebSocket, và JWT không được nằm
   trong URL (sẽ bị ghi vào log truy cập).
2. Client mở `wss://winkey.vn/v1/realtime?ticket=<ticket>`. Không có `ticket` là kết nối **ẩn danh**
   (chỉ subscribe được room `video:*` của video công khai). Ticket sai, hết hạn hoặc đã dùng → trả
   `401` trước khi upgrade.
3. Gateway: route `/v1/realtime` tới realtime-gw, bật WebSocket, timeout idle ≥ 120 s. forwardAuth vẫn
   chạy như mọi `/v1/*`; realtime-gw **bỏ qua** `X-User-Id` ở request upgrade và chỉ tin ticket (header
   không có trên kết nối trình duyệt). `/v1/realtime/ticket` dùng `X-User-Id`/`X-User-Roles` như mọi
   endpoint khác.
4. Mọi frame là **text JSON UTF-8**, tối đa **4 KiB** mỗi frame từ client. Frame binary hoặc JSON sai
   schema → message `error` (`code: BAD_MESSAGE`); 5 lỗi liên tiếp → đóng `4400`.

## Room

| Room | Ai subscribe được | Event nhận được |
|---|---|---|
| `video:{video_id}` | Bất kỳ ai **đọc được video** (kể cả ẩn danh). realtime-gw kiểm tra bằng `GET /v1/videos/{video_id}` nội bộ tới video-svc, chuyển tiếp `X-User-Id`/`X-User-Roles` của kết nối: `200` → cho phép, còn lại → `error` `ROOM_FORBIDDEN`. Kết quả được cache tối đa 60 s. | `comment.created`, `like.count` |
| `upload:{video_id}` | Chỉ kết nối **đã xác thực**. Event chỉ được giao khi `owner_id` của event bằng `user_id` của kết nối, hoặc kết nối có role `moderator`/`admin`. | `video.progress`, `video.ready`, `video.failed` |
| `user:{user_id}` | **Tự động** với kết nối đã xác thực, chỉ của chính mình; client không subscribe/unsubscribe. | `video.ready`, `video.failed` (video của mình), `comment.reply`, `notification.hint` (N2) |

- Tối đa **50 room** mỗi kết nối (vượt → `error` `TOO_MANY_ROOMS`), **5 kết nối** mỗi user (kết nối
  thứ 6 bị đóng `4429`).
- Subscribe cùng room hai lần là idempotent (vẫn trả `ack`).

## Nguồn event → message

| Nguồn (NATS) | Điều kiện | Message gửi | Room |
|---|---|---|---|
| `rt.video.*.progress` (core NATS) | — | `video.progress {video_id, stage, percent}` | `upload:{video_id}` |
| `video.ready` (JetStream `VIDEO`) | — | `video.ready {video_id}` | `upload:{video_id}`, `user:{owner_id}` |
| `video.failed` (JetStream `VIDEO`) | — | `video.failed {video_id, reason, message, retryable}` | `upload:{video_id}`, `user:{owner_id}` |
| `social.comment.created` (JetStream `SOCIAL`) | — | `comment.created {comment_id, video_id, parent_id}` | `video:{video_id}` |
| `social.comment.created` | `parent_author_id` khác null và khác `author_id` | `comment.reply {comment_id, video_id, parent_id}` | `user:{parent_author_id}` |
| `social.video.like_changed` (JetStream `SOCIAL`) | — | `like.count {video_id, like_count}` | `video:{video_id}` |
| `social.comment.created` | N2: `parent_id` null và `video_owner_id` khác `author_id` | `notification.hint {kind: VIDEO_COMMENT}` | `user:{video_owner_id}` |
| `social.comment.created` | N2: `parent_author_id` khác null và khác `author_id` | `notification.hint {kind: COMMENT_REPLY}` | `user:{parent_author_id}` |
| `social.subscription.changed` (JetStream `SOCIAL`) | N2: `subscribed = true` và `subscriber_id` khác `channel_id` | `notification.hint {kind: NEW_SUBSCRIBER}` | `user:{channel_id}` |

- `comment.created`/`comment.reply` **không** mang nội dung comment: client lấy qua
  `GET /v1/comments/{comment_id}`, để quy tắc hiển thị (HIDDEN, tombstone, profile) chỉ nằm ở social-svc.
- `notification.hint` (N2, ADR-023 phần bổ sung) chỉ là **gợi ý làm mới**: không mang id hay nội dung thông báo.
  Client gọi lại `getUnreadNotificationCount` (và danh sách nếu đang mở). Gợi ý có thể thừa (subscribe lại bị
  khử trùng lặp, comment bị ẩn ngay sau đó); client không bao giờ hiển thị gì chỉ dựa vào gợi ý.
  `VIDEO_PUBLISHED` **không** có gợi ý (fan-out tới mọi subscriber quá tốn); client vẫn poll như cũ.
- Event có `version` không biết → bỏ qua và log warn (contracts/events/README.md).
- **Nhiều replica:** mỗi pod realtime-gw cần *mọi* event, nên dùng consumer JetStream **ephemeral,
  ordered**, `deliver_policy: new`, **không** dùng durable dùng chung (durable chia message giữa các
  pod). Core NATS thì subscribe `rt.video.*.progress` trực tiếp (không queue group).
- realtime-gw chỉ gửi message tới kết nối có subscribe room tương ứng; không fan-out qua Valkey.

## Giao thức

Client → server ([`client.schema.json`](client.schema.json)):

| `type` | Trường | Ý nghĩa |
|---|---|---|
| `subscribe` | `id`, `room` | Vào room. Trả `ack` hoặc `error` cùng `id`. |
| `unsubscribe` | `id`, `room` | Rời room. Luôn trả `ack` (idempotent). |
| `ping` | `id` | Kiểm tra kết nối từ phía client. Trả `pong`. |

Server → client ([`server.schema.json`](server.schema.json)):

| `type` | Trường | Ý nghĩa |
|---|---|---|
| `welcome` | `connection_id`, `user_id` (null nếu ẩn danh), `heartbeat_interval_ms` | Gửi ngay sau khi upgrade. |
| `ack` | `id` | Lệnh thành công. |
| `error` | `id` (null nếu không gắn với lệnh), `code`, `message` | Lệnh thất bại; kết nối vẫn mở. |
| `pong` | `id` | Trả lời `ping`. |
| `event` | `room`, `event`, `data`, `ts` | Một event (xem bảng trên). `ts` là thời điểm realtime-gw gửi (RFC 3339 UTC). |

`error.code`: `BAD_MESSAGE`, `ROOM_INVALID` (sai định dạng room), `ROOM_FORBIDDEN`, `AUTH_REQUIRED`
(room cần đăng nhập), `TOO_MANY_ROOMS`, `RATE_LIMITED`.

## Heartbeat, giới hạn, đóng kết nối

- Server gửi WebSocket **ping frame** mỗi `heartbeat_interval_ms` (25 000). Không nhận pong trong 60 s → đóng `4408`.
- Client gửi tối đa **20 message/giây**; vượt → `error` `RATE_LIMITED`, vượt liên tục 5 s → đóng `4429`.
- Mã đóng: `1001` server tắt/deploy, `4400` quá nhiều message sai, `4401` ticket bị thu hồi (dành cho
  sau này), `4408` hết heartbeat, `4429` quá giới hạn kết nối hoặc tốc độ.
- Client reconnect với backoff lũy thừa có jitter (1 s → tối đa 30 s), **xin ticket mới** mỗi lần
  (ticket chỉ dùng một lần), rồi subscribe lại room và tải lại trạng thái qua REST.
- Khi nhận SIGTERM: ngừng nhận kết nối mới, đóng mọi kết nối với `1001` trong vòng 10 s.

## Vận hành

- `/healthz`; `/readyz` kiểm tra NATS (JetStream) và Valkey.
- Metric: số kết nối (ẩn danh/đã xác thực), số room, message gửi theo `event`, message bị drop do
  buffer đầy (mỗi kết nối tối đa 256 message chờ gửi; đầy → drop message cũ nhất và tăng metric).
- Log JSON; không log ticket, không log nội dung message của client.

## Kiểm tra

```bash
make contracts-lint   # gồm realtime-lint: validate examples/client/*.json và examples/server/*.json
```
