# Kickoff — Antigravity 1 · Task A6-web (forgot/reset password, email verification pages)

Backend is merged (#167, ADR-026): `requestPasswordReset`, `resetPassword`, `resendEmailVerification`,
`verifyEmail` in contracts/openapi/auth.v1.yaml, and `User.email_verified` on `getMe`. Also merged (#171): when
Google OAuth is not configured, `GET /v1/auth/oauth/google` redirects to `/login?error=oauth_unavailable`.

````text
# ROLE
You are Antigravity 1, the frontend engineer on "Winkey" (repo luantpbk/winkey). You own apps/web, e2e/,
packages/api-client. Read AGENTS.md first. Never edit contracts/, services/, deploy/.

# REPO
Worktree: git worktree add ../winkey-ag1-a6web -b agent/ag1/a6-web-password-pages origin/main
READ FIRST: the four operations above (every description: 202 always for forgot, one INVALID_TOKEN code, 409
EMAIL_ALREADY_VERIFIED, rate limits) and the PasswordResetRequest / ResetPasswordRequest / VerifyEmailRequest
schemas. The mail links are `{PUBLIC_ORIGIN}/{locale}/reset-password?token=…` and `/{locale}/verify-email?token=…`,
so those two routes must exist exactly.

# TASK
1. `/[locale]/forgot-password` (link "Quên mật khẩu?" under the password field on /login).
   - Email field, calls `requestPasswordReset` with `locale` = the page locale.
   - On 202, ALWAYS show the same message ("Nếu email này có tài khoản, chúng tôi đã gửi liên kết…"), never
     "account not found". 400 → field error, 429 → "Thử lại sau" (use Retry-After if present).
2. `/[locale]/reset-password?token=…`.
   - Read the token from the URL, then remove it from the address bar right away
     (`history.replaceState`) so it does not stay in history or leak via Referer. Add
     `<meta name="referrer" content="no-referrer">` on this page and on verify-email.
   - New password + confirm (same client rules as register: min 8, max 128), calls `resetPassword`.
   - 204 → message "Đã đổi mật khẩu, mọi thiết bị đã đăng xuất" and a button to /login. Clear any in-memory session
     (the server revoked every refresh family).
   - 400 INVALID_TOKEN → "Liên kết không hợp lệ hoặc đã hết hạn" with a link to /forgot-password. Missing token in
     the URL → the same message without calling the API.
3. `/[locale]/verify-email?token=…`.
   - Same token hygiene as 2. Calls `verifyEmail` once on load (guard against React StrictMode double effects:
     a second call would return 400 because the token is single use).
   - 204 → "Email đã được xác minh". If the user is signed in, refresh `getMe` so the banner disappears.
   - 400 INVALID_TOKEN → "Liên kết không hợp lệ hoặc đã dùng. Đăng nhập và kiểm tra trang Cài đặt."
4. Verification banner: for a signed-in user with `email_verified = false`, a dismissible banner (dismissal kept
   per session only) "Xác minh email để bảo vệ tài khoản" with a "Gửi lại email" button → `resendEmailVerification`.
   202 → "Đã gửi", 409 → hide the banner and refresh `getMe`, 429 → "Thử lại sau". Same status and button on the
   settings page.
5. /login: when the URL has `error=oauth_unavailable`, show "Đăng nhập Google tạm thời chưa khả dụng" above the form
   (and keep `error=ACCOUNT_SUSPENDED` handling if it exists).
6. Never log or send the token anywhere except the request body (no analytics, no console, no error reporter).
7. MSW handlers for the four operations (202, 204, 400 INVALID_TOKEN, 409, 429) and i18n vi/en for every string.

# DEFINITION OF DONE
- Vitest:
  - forgot shows the same message for a known and an unknown email;
  - reset: token removed from the URL before the request; 204 clears the session; 400 shows the invalid message;
    missing token makes no request;
  - verify: called exactly once under StrictMode; 204 refreshes getMe when signed in; 400 message;
  - banner: shown only when `email_verified=false`; resend 202/409/429;
  - login shows the oauth_unavailable message;
  - no request body or URL logged in the console (spy on console.*).
- Playwright (MSW): forgot → open the reset link → new password → login page; and verify-email link → success.
- web lint/typecheck/test/build, root lint + format:check, CI green. Open the PR yourself with the Handoff Report
  (real outputs).

# OUT OF SCOPE
Changing the email address, blocking unverified users, any backend change, the "Xem tiếp" column (R2-c-web).
````
