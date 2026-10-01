# Kickoff — Antigravity 3 · Task A6 (quên mật khẩu + xác minh email trong auth-svc)

Design: ADR-026. Contract: `requestPasswordReset`, `resetPassword`, `resendEmailVerification`, `verifyEmail` (and the new
`register` description) in contracts/openapi/auth.v1.yaml. Migration 000016 (`auth.email_tokens`, `auth.mail_queue`),
tested in db/tests/014_email_tokens.sql. Web pages (`/reset-password`, `/verify-email`, the reminder banner):
Antigravity 1, later. Production SMTP secret: Antigravity 2 once the user picks a provider.

````text
# ROLE
You are Antigravity 3, the Node engineer on "Winkey" (repo luantpbk/winkey). You own services/auth, services/social,
services/realtime and the shared TS packages. Never edit contracts/, db/, deploy/, .github/. Read AGENTS.md first.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag3-a6 -b agent/ag3/a6-password-reset origin/main
READ FIRST: ADR-026 and ADR-019 (docs/DECISIONS.md), db/migrations/000016_email_tokens.up.sql, the 4 operations and
schemas PasswordResetRequest / ResetPasswordRequest / VerifyEmailRequest in auth.v1.yaml, then services/auth/src
(routes/register.ts, routes/me.ts changePassword, revocation/, rate-limit/).

# TASK
1. Tokens:
   - 32 random bytes from `crypto.randomBytes`, base64url without padding (43 chars).
   - Store only SHA-256 in `auth.email_tokens` (UUIDv7 id, purpose, email = the user's current email).
   - TTL: reset 1 h, verify 48 h.
   - Lookup by hash. One error for every bad case: `400 INVALID_TOKEN`. Never log the token or the email.
2. Endpoints exactly per contract:
   - `requestPasswordReset`: always `202`, with similar timing whether or not the account exists (do the DB lookup
     and token work in both cases, or add a constant floor). Mail only for an ACTIVE user, max 3 reset tokens per
     user per hour (count rows in `email_tokens`).
   - `resetPassword`, one transaction:
     - set an argon2id hash (same parameters as register);
     - mark every unused RESET token of the user as used;
     - set `email_verified_at` if NULL;
     - revoke every refresh family plus the ADR-019 revocation mark (reuse the A4 code, don't copy it);
     - queue `PASSWORD_CHANGED`.
   - `resendEmailVerification`: `409 EMAIL_ALREADY_VERIFIED` when verified; 3 per hour → `429` with `Retry-After`.
   - `verifyEmail`: set `email_verified_at`, mark the token used.
   - `register` also queues `VERIFY_EMAIL` in its transaction. Locale from `Accept-Language` (`en*` → en, else vi);
     `requestPasswordReset` uses `locale` from the body.
   - The per-IP limits reuse the login limiter.
   - `getMe.email_verified` reflects `email_verified_at`.
3. Mail sender loop in auth-svc (one per pod is fine thanks to `FOR UPDATE SKIP LOCKED`):
   - Pick ≤ 20 pending rows with `next_attempt_at <= now()`.
   - Render the template (vi/en, plain text + simple HTML; link = `{PUBLIC_ORIGIN}/{locale}/reset-password?token=…`
     or `/verify-email?token=…`) and send.
   - On success: `sent_at = now(), params = NULL`.
   - On error: `attempts+1`, `next_attempt_at = now() + 2^attempts min` (cap 1 h), `last_error` truncated with no
     address. After 8 attempts: `dead_at = now(), params = NULL`.
   - Delete rows older than 7 days.
   - `deleteMe` must delete the user's pending `mail_queue` rows and live tokens in its transaction.
   - Metrics: `auth_mail_sent_total{template}`, `auth_mail_failed_total{template}`, `auth_mail_dead_total`,
     `auth_mail_queue_pending` (gauge).
4. Config:
   - `MAIL_TRANSPORT=smtp|log` (default `log`);
   - `SMTP_URL` (required when smtp, e.g. `smtps://user:pass@host:465`; never logged);
   - `MAIL_FROM` (default `Winkey <no-reply@winkey.vn>`).
   - Use nodemailer; say why in the PR if you pick something else.
   - Update the README env table and `.env.example` (dummy values only).
   - Open an issue for Antigravity 2: Mailpit in the dev compose and `MAIL_*`/`SMTP_URL` in deploy (secret).

# DEFINITION OF DONE
- Unit tests:
  - token encode/hash;
  - every INVALID_TOKEN case: unknown, expired, used, wrong purpose, email changed, user suspended;
  - the 3/hour caps;
  - backoff and dead after 8;
  - params cleared;
  - templates in both locales contain the link.
- Integration (testcontainers PG + Valkey + Mailpit, 0 skipped):
  1. register → the Mailpit inbox has the verify mail → verifyEmail → getMe.email_verified = true.
  2. Forgot password for an unknown email: 202 and no mail.
  3. Forgot → reset: the old refresh cookie fails, the old access token is rejected by `verify` within the ADR-019
     window, login works with the new password, and the PASSWORD_CHANGED mail arrives.
  4. Re-using the token gives 400.
  5. deleteMe drops pending mail.
  6. Every response is validated against the contract (same checker as the other auth tests).
- lint, typecheck, test, build; root lint + format:check; CI green. Handoff Report with real output (no tokens or
  real addresses in it).

# OUT OF SCOPE
Web pages, changing email address, blocking unverified users, phone verification (LEGAL decides later), deploy.
````
