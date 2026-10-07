# Kickoff — Antigravity 1 · Task BETA1-web (invite field, legal pages, beta footer)

Design: ADR-034. Contract: `RegisterRequest.invite_code`, `403` `INVITE_REQUIRED` / `INVITE_INVALID`,
`googleStart?invite_code=` (api-client already regenerated). Legal text: `docs/legal/` (the README there explains the
rules). Start AFTER CIN1 is merged, because this task fills the footer links CIN1 adds.

````text
# ROLE
You are Antigravity 1, frontend engineer on Winkey (repo luantpbk/winkey). You own apps/web, e2e/, packages/api-client.
Never edit contracts/, services/, deploy/, docs/.

# REPO
Worktree: git worktree add ../winkey-ag1-beta1web -b agent/ag1/beta1-web origin/main

# TASK
1. /register:
   - Add the field "Mã mời" (en "Invite code"), prefilled from `?invite=<code>`. It is always visible, optional on the
     client, max 64 characters, and trimmed.
   - Send it as `invite_code` only when it is non-empty.
   - Map the problem codes to messages:
     - INVITE_REQUIRED → "Winkey đang thử nghiệm kín. Bạn cần mã mời để tạo tài khoản."
     - INVITE_INVALID → "Mã mời không đúng hoặc đã hết hạn."
     Show the message on the invite field, which gets focus.
   - Read `?error=INVITE_REQUIRED|INVITE_INVALID`, the Google callback redirect, and show the same messages.
   - The "Tiếp tục với Google" button adds `&invite_code=<field value>` when the field is non-empty, URL-encoded.
   - Add a required checkbox: "Tôi đồng ý với Điều khoản sử dụng và Chính sách quyền riêng tư", where both names link
     to the pages below (new tab). Submit and the Google button stay disabled until it is checked. It is client-only;
     nothing is sent.
   - Never put the invite code in logs, analytics or error reports.
2. Legal pages:
   - `/dieu-khoan`, `/quyen-rieng-tu`, `/quy-tac-cong-dong` (Vietnamese only; `/en/...` shows the Vietnamese text with
     a one-line English note).
   - Copy `docs/legal/{terms,privacy,community}.vi.md` VERBATIM into `apps/web/content/legal/`.
   - Render them at build time as static pages. You may add `react-markdown` + `remark-gfm` (pinned), with NO raw
     HTML. Tables need to scroll horizontally on mobile.
   - Readable typography: max-width 72ch, plus the site theme.
   - Add a Vitest test that fails if a copied file differs from its docs/legal source (compare file contents).
3. Footer and feedback:
   - Fill the CIN1 footer links.
   - Also add a small footer block at the bottom of the existing sidebar (other routes) with the same 4 links.
   - "Góp ý beta" opens `FEEDBACK_URL`. It is a server runtime env read in a server component, like
     CINEMA_CURATOR_HANDLE. Empty → hide the link. Only `https:` or `mailto:` are allowed; anything else → hidden.
4. i18n: every new string is in vi.json and en.json.

# DEFINITION OF DONE
- Vitest:
  - `?invite=` prefill, and invite_code is omitted when the field is empty;
  - both 403 messages, and both `?error=` messages;
  - the Google href carries invite_code;
  - the checkbox gates submit and Google;
  - FEEDBACK_URL hidden when empty or unsafe;
  - the legal copies match their sources.
- Playwright (MSW): register with invite → 201 path; register without → 403 INVITE_REQUIRED message; each legal page
  renders and the footer links work, desktop and mobile.
- web lint, typecheck, test and build pass; root lint + format:check pass; CI is green. Run the new tests 10× in a row.
  The PR is the Handoff Report with real outputs and screenshots.
````
