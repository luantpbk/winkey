# Antigravity 3 — SOC-1a: account security in auth-svc (ADR-049 §3 + SOC-1a addendum)

Read `AGENTS.md`, **ADR-049** (§3 and the SOC-1a addendum), then `contracts/openapi/auth.v1.yaml`:
- the "Account security" part of the API description;
- `login` (now `TokenResponse | MfaChallenge`), `googleCallback` (the `wk_mfa` paragraph), `register` and `login` (`turnstile_token`);
- every operation with tag `security`;
- the new schemas from `TurnstileToken` to `SecurityEventPage`, and `User.mfa_enabled` / `User.staff_roles_pending_mfa`.

Tables: migration `000028_account_security` (merged; do not write migrations):
- `auth.users.totp_*`, `auth.recovery_codes`, `auth.passkeys`;
- `auth.sessions`, `auth.security_events`;
- mail template `NEW_SIGN_IN`, email-token purpose `SESSION_REPORT`.

Work only in `services/auth`. You may split the work into **two PRs**, in this order:
1. **sessions + step-up + TOTP + recovery codes + staff rule + captcha + breach check**;
2. **passkeys + new-sign-in mail + security log page endpoints**.

Branches: `agent/ag3/soc1a-...` from `origin/main`. Each PR description is the Handoff Report.

## Libraries (no hand-written crypto)
- TOTP: `otplib` (or an equivalent maintained RFC 6238 library). Use SHA-1, 6 digits, 30 s, window ±1.
- WebAuthn: `@simplewebauthn/server` (current major).
- AES-256-GCM and HMAC: Node `crypto`.
- Recovery codes: `crypto.randomInt` over `[a-z2-9]`; hash them with argon2id, like passwords.

## Config (README env table + `.env.example`, dummy values)

| Variable | Meaning |
|---|---|
| `TOTP_ENCRYPTION_KEYS` | `id1:base64(32 bytes),id2:…`; the first key encrypts, any key decrypts. The service fails to start if it is missing or malformed (except `NODE_ENV=test`). |
| `SESSION_IP_SALT` | ≥ 32 bytes; HMAC key for `sessions.ip_hash`. |
| `WEBAUTHN_RP_ID` | e.g. `winkey.vn`; local `localhost`. |
| `WEBAUTHN_ORIGINS` | Comma list, e.g. `https://winkey.vn,https://www.winkey.vn`. |
| `WEBAUTHN_USER_HANDLE_KEY` | ≥ 32 bytes; user handle = HMAC-SHA256(key, user id). |
| `STAFF_MFA_REQUIRED` | `true` (default) or `false`; see the staff rule below. |
| `TURNSTILE_SECRET` | Empty disables captcha. |
| `PASSWORD_BREACH_CHECK` | `true` or `false` (default `false` in dev and test). |
| `TRUSTED_COUNTRY_HEADER` | Default `CF-IPCountry`. Read it only when the request comes from a trusted proxy (reuse the client-IP rules). |

## Task

1. **Sessions.**
   - Every new refresh family (password, Google, MFA completion, passkey) inserts an `auth.sessions` row in the same transaction:
     - `device_label`: a short Vietnamese label from the User-Agent, e.g. "Chrome trên Windows" or "Safari trên iPhone". Use `ua-parser-js` or similar, max 80 chars;
     - `country`;
     - `ip_hash`;
     - `amr`.
   - Stop writing `refresh_tokens.ip`.
   - `refresh` updates `last_used_at`. Throttle this to at most once per minute per session, to avoid write amplification.
   - Every place that revokes families (logout, reuse detection, password change, suspension, deletion) also sets `sessions.revoked_at` and `revoke_reason`.
   - Endpoints: `listMySessions`, `revokeMySession`, `revokeOtherSessions`.
   - A janitor purges sessions revoked or expired more than 90 days ago, and security events older than 1 year.
2. **Step-up.**
   - `stepUp` and `sendStepUpEmailCode`. The email code is 6 digits; store its hash in Valkey, keyed by session, for 10 minutes; at most 5 attempts.
   - Add a reusable `requireStepUp` guard: `sessions.step_up_at` within 10 minutes for the caller's `sid`, else `403 STEP_UP_REQUIRED`.
   - Apply the guard to:
     - `startTotpSetup`, `disableTotp`, `regenerateRecoveryCodes`;
     - `passkeyRegistrationOptions`, `addPasskey`, `deletePasskey`.
   - Do **not** change `changePassword` or `deleteMe` in this task: they already ask for the password.
3. **TOTP + recovery codes.**
   - `startTotpSetup`: the pending secret is encrypted in Valkey.
   - `confirmTotpSetup`: up to 5 tries; generate recovery codes only when the account has none.
   - `disableTotp` and `regenerateRecoveryCodes` follow their descriptions.
   - Replay protection: reject a code whose step ≤ `totp_last_step`. Update `totp_last_step` in the same statement that verifies (`UPDATE … WHERE totp_last_step IS NULL OR totp_last_step < $step`), so two parallel requests cannot both pass.
4. **MFA sign-in.**
   - `login` returns `MfaChallenge` when the account has TOTP or a passkey.
     - `methods` lists what the account has; add `recovery_code` when unused codes remain.
     - Check the password and the suspension first, exactly as today.
   - The `mfa_token` is opaque, 256-bit, stored in Valkey with `{user_id, first_factor: pwd|google, attempts}` for 5 minutes, single use.
   - `googleCallback` sets `wk_mfa` and redirects as the contract says.
   - `completeMfaLogin` follows its description, including the `MFA_FAILED` event on a wrong code. Count failures toward the existing login rate limiter.
5. **Staff rule.**
   - When `STAFF_MFA_REQUIRED=true` and the account has no second factor, remove `moderator` and `admin` from the roles in every access token you issue (login, refresh, MFA, passkey).
   - `getMe` / `User` return the effective `roles`, plus `staff_roles_pending_mfa`.
   - **Do not change `auth.users.roles`.**
   - `/v1/auth/verify` (the gateway) keeps trusting the token. No change there.
6. **Passkeys.**
   - Endpoints: `passkeyRegistrationOptions`, `addPasskey`, `listMyPasskeys`, `renamePasskey`, `deletePasskey`, `passkeyAssertionOptions` (3 purposes), `passkeyLogin`.
   - Challenges live in Valkey for 2 minutes, keyed by `flow_id`, bound to the purpose (and to the user for `mfa`/`step_up`), single use.
   - Store `sign_count`, `backup_eligible`, `backup_state` and `transports`. Update `last_used_at` on use.
   - If the counter is non-zero and does not increase, reject and log a warning: passkey id only.
7. **New-sign-in mail.**
   - After a successful sign-in, if no session of the user from the last 90 days has the same `ip_hash` and `device_label`:
     - queue `NEW_SIGN_IN` with a `SESSION_REPORT` token (7 days) and the params `{device, country, time, link}`;
     - write `SIGN_IN_NEW_DEVICE`;
     - otherwise write `SIGN_IN`.
   - Do not send it for the very first session of a new account.
   - `reportSession` follows its description.
   - Add the Vietnamese and English templates to the mailer.
8. **Captcha** on `register` and `login`, per the API description. Verify against `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 3 s timeout. Tie the failed-attempt counter to the existing login limiter keys.
9. **Breach check** on `register`, `changePassword` and `resetPassword`:
   - call `https://api.pwnedpasswords.com/range/<first 5 hex of SHA-1>` with the `Add-Padding: true` header;
   - 1.5 s timeout; fail open;
   - cache each prefix in Valkey for 24 h.
10. **Security log.**
    - Write one `auth.security_events` row in the same transaction as each change. The kinds are in the contract.
    - Also log `PASSWORD_CHANGED` (`changePassword`) and `PASSWORD_RESET` (`resetPassword`).
    - `listMySecurityEvents`: cursor `(created_at, id)`.
11. **Logs:** never log codes, secrets, recovery codes, `mfa_token`, WebAuthn payloads, IPs or emails. Ids only.

## Tests (integration, real Postgres + Valkey, contract-checked)
- **Login:**
  - with TOTP → `MfaChallenge`, then `completeMfaLogin` with a right code → tokens;
  - a wrong code → `401 MFA_CODE_INVALID` and an event;
  - the same code twice → second rejected;
  - 6th attempt → `MFA_TOKEN_INVALID`;
  - an expired token → rejected (use the fake clock).
- **Google callback with MFA:** `wk_mfa` cookie set, `wk_rt` not set, the redirect URL contains no token.
- **Recovery codes:** a code works once; the remaining count drops; regenerate invalidates the old codes; the format matches the contract.
- **Step-up:** every guarded endpoint → `403 STEP_UP_REQUIRED` without step-up; OK within 10 minutes; rejected after 10 minutes.
- **Disabling the last factor:** codes deleted, other sessions revoked (their refresh → `401`), the caller's session survives.
- **Staff rule:** an admin without 2FA → token roles lack `admin`, `staff_roles_pending_mfa = [admin]`. After enabling TOTP and calling `refresh` → `admin` back. With `STAFF_MFA_REQUIRED=false` → unchanged.
- **Passkeys:** use `@simplewebauthn/server` test helpers or a software authenticator.
  - register, list, rename, delete;
  - `passkeyLogin` → session `amr = [passkey]`, staff roles kept;
  - wrong origin → `401`;
  - challenge reuse → `401`;
  - 11th passkey → `409 PASSKEY_LIMIT`;
  - the same credential twice → `409 PASSKEY_EXISTS`.
- **Sessions:** list marks `current`; revoke one → its refresh `401`; revoke-others; revoked families show the right `revoke_reason`; old rows purged by the janitor.
- **New-device mail:**
  - a first sign-in from a new IP or UA → mail queued, event `SIGN_IN_NEW_DEVICE`;
  - the same device again → no mail;
  - `reportSession` revokes the session;
  - a reused token → `400 TOKEN_INVALID`.
- **Captcha:** stub Cloudflare. `register` without a token → `CAPTCHA_REQUIRED`; after 3 failed logins → required.
- **Breach check:** stub the range API. A breached password → `400 PASSWORD_BREACHED`; an API timeout → accepted.
- **Security events:** no secrets in `details`; cursor paging.
