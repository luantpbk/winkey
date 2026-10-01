# Hai architect (Opus A + Opus B): quy ước phối hợp

Áp dụng khi có 2 phiên Opus cùng làm architect cho Winkey. Mục tiêu:
- không giẫm chân nhau;
- không đọc trùng cùng một thứ;
- tiêu ít token nhất.

## Phân vai
| | Opus A: **Reviewer / Merger** | Opus B: **Designer** |
|---|---|---|
| Làm gì | Review PR của agent theo brief; đọc CI; merge; cập nhật #47; viết "Chuyển giúp" cho agent; check-in mỗi giờ | ADR, contract (`contracts/`), migration (`db/`), brief (`docs/prompts/`), ROADMAP; trả lời câu hỏi thiết kế |
| Merge | **Người duy nhất merge** mọi PR, kể cả PR thiết kế của B, sau khi đọc diff | Không merge. Mở PR thiết kế, ghi "Designer → Reviewer: ready" |
| Branch | nhánh của phiên A | nhánh riêng của phiên B. Không bao giờ dùng chung branch hay worktree với A |
| Check-in | `/loop 60m` (hoặc `send_later`). Dừng sau 3 lần liên tiếp không có gì mới | Không loop. Chỉ chạy khi người dùng gọi hoặc khi A ghi "→ Designer" trên #47 |

Một trong hai hết quota thì phiên còn lại làm cả hai vai theo `docs/prompts/architect_handoff.md`. Ghi việc này lên #47.

## Kênh liên lạc: chỉ dùng issue #47
- Mỗi lần ghi một comment ngắn, dòng đầu là `[A]` hoặc `[B]`.
- Việc chuyển cho người kia ghi theo dạng `→ Designer: …` / `→ Reviewer: …`.
- Đầu phiên, chỉ đọc **comment mới nhất của #47 kể từ lần ghi cuối của mình**. Không đọc lại cả issue.
- Nhận một việc thì ghi `[B] nhận: UQ1-b`, để người kia không làm trùng.

## Ranh giới file (tránh conflict)
- **B** sửa `contracts/`, `db/`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/prompts/*` (trừ hai file architect).
- **A** sửa `docs/prompts/architect_handoff.md` (trạng thái) và issue #47.
- Contract đổi thì làm thêm hai việc trong cùng PR thiết kế: sinh lại `packages/api-client` (`pnpm --filter @winkey/api-client run generate`), và với migration thì chép vào `deploy/k8s/data/migrations` kèm kustomization.

## Tiết kiệm token (cả hai phiên)
1. **Đọc theo diff, không đọc cả repo.**
   - Xem `git diff --stat origin/main...<branch>` trước, rồi chỉ mở các file có liên quan đến brief.
   - Không mở file sinh tự động (`packages/api-client/src/types/*`) hay lockfile.
2. **Log CI thì lọc, không dump.**
   - Dùng `gh run view <id> --log | grep -E "FAIL|--- FAIL|panic|containerimage.digest|SKIP"`, hoặc `gh run view <id> --log-failed`.
   - Chỉ lấy đúng job cần.
3. **Không polling.**
   - A dựa vào sự kiện PR hoặc check-in mỗi giờ; B không có loop.
   - Lần check-in không có gì mới thì không ghi #47.
4. **Review gọn.** Mỗi PR có một comment: các phát hiện 🔴/🟠/🟡, mỗi phát hiện kèm patch. Không nhắc lại phần đã đạt.
5. **Prompt cho agent trỏ tới brief**, không chép lại nội dung brief vào prompt.
6. **Đầu phiên đọc tối thiểu:**
   - `architect_handoff.md`;
   - file này;
   - comment mới của #47;
   - `gh pr list`.

   `AGENTS.md`, `DECISIONS.md` và `ROADMAP.md` chỉ đọc phần liên quan đến việc đang làm.
7. **Việc cơ học dùng effort thấp hoặc model nhỏ**, ví dụ đối chiếu digest, sinh lại file, sửa format. Review bảo mật, contract và migration thì dùng effort cao.

## Việc thiết kế đang chờ (B nhận khi rảnh)
- **UQ1-b:** sổ ghi upload chỉ append. Video bị xoá cứng (`DELETE FROM media.videos`), nên "xoá rồi upload lại" vẫn lách được hạn mức ngày của ADR-027. Việc này cần migration, phần bổ sung cho ADR-027 và brief cho Sonnet 2.
- **A6-web:** brief cho Antigravity 1 về các trang `/reset-password`, `/verify-email`, banner nhắc xác minh, và trang "quên mật khẩu".
- **R2-c-web:** brief cột "Xem tiếp" cho Antigravity 1.
- **R2 recommendation v1:** chỉ làm khi người dùng cho Sonnet làm lại.
