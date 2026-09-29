# Prompt khởi động cho các agent

Mỗi agent làm việc trong phạm vi được định nghĩa ở [`AGENTS.md`](../../AGENTS.md). Gửi prompt theo thứ tự dưới đây; 4 agent chạy **song song** được, vì contract và schema DB đã chốt.

| # | Agent | Prompt | Task | Chặn ai |
|---|---|---|---|---|
| 1 | Antigravity 2 | [antigravity-2_I0-F1-F3_platform.md](antigravity-2_I0-F1-F3_platform.md) | I0 → F1 → F3 | F3 giúp mọi người chạy local (không bắt buộc: các agent khác test bằng testcontainers/MSW) |
| 2 | Sonnet 5.5 (trên gpu-01) | [sonnet-5.5_LIB-V1-V3_media-pipeline.md](sonnet-5.5_LIB-V1-V3_media-pipeline.md) | LIB → V1 → V2+V3 | **Critical path** của MVP |
| 3 | Antigravity 3 | [antigravity-3_A1_auth.md](antigravity-3_A1_auth.md) | PKG2 → A1 | EDGE (forwardAuth), Q1 |
| 4 | Antigravity 1 | [antigravity-1_PKG-U1_web.md](antigravity-1_PKG-U1_web.md) | PKG → U1 | PL1, Q1 |

## Quy trình vòng lặp

1. Agent mở PR, dùng mô tả dạng Handoff Report.
2. Bạn báo cho Opus (session này): *"review PR #N"*. Opus review theo contract/ADR, comment trên PR, và merge khi đạt.
3. Câu hỏi hoặc yêu cầu đổi contract: agent mở issue `contract-change`, Opus cập nhật `contracts/` hoặc `db/`, rồi báo lại agent.
4. Kết thúc P0/P1: Opus cập nhật trạng thái trong [`docs/ROADMAP.md`](../ROADMAP.md) và viết prompt cho các task tiếp theo (S1, PL1, I1, STO, DATA, EDGE…).
