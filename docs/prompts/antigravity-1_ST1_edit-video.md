# Kickoff — Antigravity 1 · Task ST1-web (edit a video after upload)

Design: ADR-036. Backend exists: `updateVideo` (`PATCH /v1/videos/{id}`; title 1–100, description ≤ 5 000, visibility;
owner only). No contract change. **Do this before PL2-web.**

````text
# ROLE
You are Antigravity 1 on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client.

# REPO
git worktree add ../winkey-ag1-st1 -b agent/ag1/st1-edit-video origin/main

# TASK
1. Studio:
   - Add a page `/studio/videos/{id}/edit` with a form: title (required, a counter out of 100), description
     (textarea with a counter out of 5 000; line breaks are kept) and visibility (Công khai / Không công khai /
     Riêng tư, each with a one-line explanation).
   - Show a read-only preview: thumbnail, duration, status.
   - **Tags** (TAG1, `Video.tags` / `UpdateVideoRequest.tags`): a chip input with at most 10 tags, each ≤ 30
     characters; Enter or comma adds a chip; × removes it. Send the whole list (`[]` clears it). Show the
     server's normalized list after saving: trimmed, duplicates differing only in case or accents removed.
     Helper text: "Thẻ giúp người xem tìm video trong Winkey."
   - Embed the existing subtitles section (`video-subtitles-section.tsx`) on the same page.
   - "Lưu thay đổi" sends PATCH with only the changed fields. The button is disabled while nothing has changed.
   - Show a toast on success; show field errors for a 400; a 403 / 404 shows "Bạn không có quyền sửa video này."
   - Warn before leaving with unsaved changes (beforeunload + in-app navigation).
2. Entry points:
   - each row of the Studio video list gets "Sửa" and "Thêm vào danh sách" (reuse SavePlaylistDialog);
   - on the watch page, the video OWNER sees "Chỉnh sửa", which links to the edit page.
3. After a visibility change, the watch page reflects it on the next load. No caching of the old value.
4. i18n in vi.json and en.json.

# DEFINITION OF DONE
- Vitest:
  - only changed fields are sent;
  - the button is disabled when nothing changed;
  - 400 field errors and 403 handling;
  - the unsaved-changes guard;
  - the owner-only "Chỉnh sửa" button;
  - "Sửa" / "Thêm vào danh sách" in the Studio list.
- Playwright (MSW): edit the title and visibility → the watch page shows the new title.
- Screenshots (vi), web lint, typecheck, test and build, CI green, new tests 10× in a row. The PR is the Handoff
  Report.
````
