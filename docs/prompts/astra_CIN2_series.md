# CIN2 — Bộ phim thật và phát theo tập (Astra, 2026-10-09)

Feature: https://github.com/luantpbk/winkey/issues/283. Design: ADR-035; user đã chọn đánh dấu danh sách “Bộ phim”.
Đây là task mới được user yêu cầu, không thuộc LT2 và không chuyển quyền sở hữu thư mục.

## Trải nghiệm phải giao được

- Video đơn có một thẻ phim; bộ PUBLIC có một thẻ cho cả bộ, không một thẻ cho mỗi tập.
- Chủ danh sách tạo/sửa đánh dấu “Bộ phim”; chuyển danh sách cũ giữ video và thứ tự, không re-upload.
- Thẻ bộ: tên/mô tả danh sách, thumbnail tập đầu khả dụng, số tập công khai phát được; chi tiết có tập để chọn.
- Player giữ playlist context; danh sách tập cạnh player desktop/dưới player mobile, active state, trước/sau.
- Chuyển tập qua cursor, refresh/link trực tiếp/back/forward đều đúng; video đơn không bị đổi trải nghiệm.

## CIN2-A — Architect: contract và migration, trước implementation

Own contracts/, db/, docs/, contracts.yml. Thiết kế PR này là đầu vào; agent không được tự chế endpoint theo brief.
Chốt contract OpenAPI và regenerate/check-stale API client trong cùng PR, rồi migration tương ứng và SQL tests.

Hợp đồng cần giải quyết:

1. Playlist is_series (mặc định false cho danh sách cũ), Create/Update hỗ trợ; WATCH_LATER không được đánh dấu.
   SERIES chỉ chứa video cùng chủ. Lỗi chuyển loại phải giữ nguyên danh sách/mục; mutation transactional/owner-only.
2. Public cinema catalog: query loại all/video/series, limit/cursor; entry VIDEO hoặc SERIES phân biệt bằng type;
   video IDs/cover ID, metadata playlist và playable episode count. Phân trang xác định/tie-break/cursor gắn filter.
   Suppression video đã thuộc bộ phải xét toàn bộ membership hợp lệ ở backend, không chỉ trang hiện tại.
   Chọn nguồn mới thêm rõ ràng: thời điểm video.ready được projection tạo hoặc playlist updated_at; không gọi đó
   là published_at nếu chưa có event/backfill tương ứng. Top/trending theo bộ không được bịa từ một tập đơn.
3. Public series episode context: playlist identity, current video/member, số tập khả dụng, prev/next và trang tập.
   Deep link vào tập >50 và navigation qua trang không được buộc tải hết5000 mục. Không dùng position như ordinal.
   Giới hạn công khai của cinema khác quyền đọc PL1 thường; PRIVATE/UNLISTED không được public discovery.
4. PUBLIC-only batch hydration ở video-svc nếu cần: default giữ nguyên batchGetVideos hiện có; catalog luôn dùng
   PUBLIC-only. Chốt omitted IDs/không READY/ẩn/xóa, bounded request, metadata batch order không phải episode order.
   Lỗi dependency/timeouts có lỗi rõ ràng, không fallback thành raw episode cards hoặc metadata chưa kiểm quyền.
5. Quy định cache/invalidation và kiểm quyền khi bộ/video đổi visibility/xóa/reorder; hydration tập đầu mất phải
   tìm tập khả dụng theo thứ tự hoặc bỏ bộ rỗng, không để click vào dead end. Không N+1/quét unbounded.

Migration chỉ architect viết; thêm cờ/index/constraint vào social playlist theo dữ liệu có sẵn. Không tạo bảng video
bản sao, không truy cập schema media từ social. Thay event/projection nếu cần phải được ghi ADR/contract trước.
Deploy order: migration → social/video backend tương thích → web → AG2 verification, rollback giữ data cũ.

## CIN2-G1 — Codex: bắt đầu ngay (readiness)

Issue https://github.com/luantpbk/winkey/issues/284. Own services/video và Go utilities đang sở hữu.
Đọc batchGetVideos/getVideo/playback actual source và contract. Chứng minh PUBLIC READY, hidden/private/unlisted/
deleted behavior, omitted IDs, batch ordering, signed URL renewal. Dùng test thực đã có; chỉ thêm regression khi
thiếu hành vi quan trọng. Báo paths/commands/output vào #284. Không giả định caller owner cũng được public catalog.
Nếu cần PUBLIC-only query, báo architect để chốt contract; implementation Go chỉ bắt đầu sau contract merge.
Không sửa apps/web/social/contracts/migrations, không calls/load/changes production. Không performance fix vô cớ.

## CIN2-S1 — Antigravity 3: queued sau #277/#282 + contract merge

Own services/social và shared TS packages đang sở hữu. Branch agent/ag3/cin2-s1-series-catalog; PR riêng main.
Triển khai đúng contract: cờ series, owner/same-owner constraints, atomic promotion/add/remove/reorder,
public catalog/episode context/global membership suppression, cursor và batch hydration/dependency deadlines.
Không tự sửa migration/contracts hoặc dùng invented metadata. Tests thật với Postgres cho pagination/permissions/
reorder/delete/visibility, overlapping playlists, bộ rỗng và >50 tập; failure của video-svc không leak dữ liệu.
Không bắt đầu khi audit LT2 còn changes requested; được phép đọc brief và lập ghi chú trong issue hiện tại.

## CIN2-W1 — Antigravity 1: queued sau #275/#280 + contract/backend

Own apps/web, e2e, packages/api-client. Branch agent/ag1/cin2-w1-series-player; PR riêng main.
Dùng types client đã generate; tạo/sửa danh sách có lựa chọn “Bộ phim”, thông báo owner/mixed-owner đúng lỗi.
Cinema dùng catalog thật (banner/phim bộ/phim lẻ/mới thêm). Typed entry UI, không inference theo tên/N request
cho từng video, không chỉ gom trong trang feed hiện có. Giữ redirects/footer/legal đã accepted.
Chi tiết bộ + episode panel/prev-next với playlist URL, active episode, loading/error/empty/missing states.
Desktop panel right, mobile below; keyboard/tab/focus controls rõ; không để panel che player trên375px.
Key/reset player theo video ID, kết thúc tracker cũ, không2player/heartbeat; surface playlist cho bộ.
Không tự autoplay next; signed URLs chỉ runtime, không persist. Related suggestions đặt sau panel hoặc dưới,
không thay danh sách tập bằng relatedVideos. Playlist quản lý cũ vẫn dùng được, không mất thứ tự khi sửa.

Unit + API-backed E2E: 3 tập→1thẻ bộ + video đơn→1thẻ; regular favorites không thành bộ; không duplicateepisode;
mark/unmark/visibility; episode thứ51 link trực tiếp; prev-next qua page; back/refresh; deleted/hidden episode;
private/unlisted list không leak; timeout; mobile375px và desktop; tracker đổi video đúng. Report actual output,
không screenshot-only. Không bắt đầu implementation khi task LT2 hiện tại chưa được chấp nhận.

## AG2 / AG4 và các giới hạn

AG2 giữ nhiệm vụ LT2 generator/xóa VM; chưa giao rollout CIN2 khi backend/web chưa được accepted.
AG4 tiếp tục #263; không kéo sang feature mới. Sonnet/Sonnet2 paused. Một worktree/branch/PR cho mỗi task,
không push branch của người khác. Agent chỉ nhận implementation mới khi task hiện tại done.
Astra review diff + CI logs, exact green head; không agent tự merge. Mọi deploy vẫn do AG2 theo digest CI.

## Handoff bắt buộc

Actual changed files + contract/design link + actual test commands/output + remaining limitations. Phân biệt
readiness/design với implementation/live. Khi đã có PR implementation, issue #283 link các PR và thứ tự gate;
không coi design PR hoặc #284 audit như feature đã triển khai.