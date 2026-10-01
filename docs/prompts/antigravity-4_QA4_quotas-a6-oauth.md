# Kickoff — Antigravity 4 · Task QA4 (system tests: upload quotas, password reset, OAuth not configured)

Covers what merged on 2026-10-01: UQ1 (#161) + UQ1-b (#173, ADR-027 and its addendum, migration 000017), A6
(#167, ADR-026), and #171 (Google OAuth not configured → `/login?error=oauth_unavailable`).

````text
# ROLE
You are Antigravity 4, the QA engineer on "Winkey" (repo luantpbk/winkey). You own systest/ and loadtest/. Read
AGENTS.md first. Never edit services/, contracts/, deploy/ (a needed change there → issue for the owner).

# REPO
Worktree: git worktree add ../winkey-ag4-qa4 -b agent/ag4/qa4-quotas-a6-oauth origin/main
READ FIRST: upload.v1.yaml (createUpload "Quotas" paragraph, 429, abortUpload), auth.v1.yaml
(requestPasswordReset, resetPassword, verifyEmail, googleStart), ADR-026, ADR-027 + addendum.

# TASK — new scenarios in systest/suite/index.mjs, before S11 (S11 stays last)
Use FRESH users per scenario (register through AUTH_URL with a distinct X-Forwarded-For, like S13/S14) so the
earlier scenarios' uploads never count. Keep the service defaults (3 concurrent, 20 per 24 h, 50 GiB per 24 h);
do not change upload-svc env.

S15 upload quotas (UQ1 + UQ1-b):
  a. concurrent: user Q creates 3 uploads (createUpload only, no parts) → the 4th is 429, problem `code`
     UPLOAD_QUOTA_EXCEEDED, `detail` names `concurrent`, `Retry-After` is an integer ≥ 1.
  b. abortUpload one of the 3 → the next createUpload is 201 (a slot freed up).
  c. daily_count + delete-and-retry (UQ1-b): user R loops createUpload → abortUpload (each answer must be 201
     then 204). After 20 successful creates the 21st createUpload is 429 `daily_count`, although R has no video
     rows left. This is the regression test for the ADR-027 hole.
  d. daily_bytes: user S creates 2 uploads with size_bytes = 21474836480 (20 GiB, the max), aborting each, then a
     3rd with 20 GiB → 429 `daily_bytes`. No bytes are actually sent.
  e. admin is exempt: the admin user (as in S8/S10) can create a 4th concurrent upload → 201; abort it after.
  Validate every response against upload.v1.yaml with the same checker the suite already uses.

S16 password reset + email verification (A6), without reading mail (Mailpit is not in the dev compose yet):
  a. requestPasswordReset for an unknown email and for a fresh ACTIVE user: both 202 with an empty body, and
     both take ≥ 250 ms (measure; the floor is part of ADR-026's anti-enumeration rule).
  b. resetPassword with a well-formed but unknown token (43 base64url chars) → 400 `INVALID_TOKEN`; with a
     malformed token → 400 (validation or INVALID_TOKEN, as the contract says).
  c. verifyEmail with an unknown token → 400 `INVALID_TOKEN`.
  d. getMe for a freshly registered user → `email_verified: false`. Then call resendEmailVerification repeatedly:
     the first answers are 202 and a 429 with Retry-After must arrive by the 3rd call at the latest (the limit is
     3 verify mails per user per hour and register already queued one). Assert the exact count you observe and
     explain it in the PR against the auth-svc code.
  e. auth-svc logs during S16 (docker logs of the auth container) contain neither the test email nor any
     43-char token-looking string: grep and assert 0 hits.

S17 Google OAuth not configured (#171): the systest compose has no GOOGLE_CLIENT_ID, so
  GET {GATEWAY_URL}/v1/auth/oauth/google?return_to=/ with redirect: 'manual' → 302 with
  Location ending in `/login?error=oauth_unavailable`, and no Set-Cookie for the OAuth state cookie.

# DEFINITION OF DONE
- `./systest/run.sh --reset` green: S1…S17, 0 skipped, run twice in a row (the second run proves the fresh-user
  scheme does not depend on a clean DB beyond --reset).
- Paste the summary table and the `ℹ tests/pass/fail/skipped` lines VERBATIM in the PR (Handoff Report), plus
  the measured S16a timings.
- root lint + format:check green in CI. Open the PR yourself.

# OUT OF SCOPE
Reading mail / the full reset-by-link flow (needs Mailpit in deploy/compose: Antigravity 2), load tests, web UI.
````
