# Antigravity 1 — SOC-1a: second factor, passkeys and sessions in the web app (ADR-049)

Read `AGENTS.md`, **ADR-049** (§3 and the SOC-1a addendum), and the `security` operations in `contracts/openapi/auth.v1.yaml`. The api-client types are already regenerated. Work only in `apps/web` (and `e2e/` if you add flows). Start after the auth-svc PR #1 of SOC-1a is merged; you can build against MSW mocks before that.

Branch: `agent/ag1/soc1a-security-ui` from `origin/main`. One PR (or two: MFA sign-in first, then settings). Handoff Report as the description.

## Task
1. **Sign-in with a second factor.**
   - `login` can return `MfaChallenge`. The architect added a temporary guard in `auth-context.tsx` that returns an error; replace it with the real flow.
   - Page `/login/2fa`:
     - a 6-digit input with `autocomplete="one-time-code"` and `inputmode="numeric"`;
     - a "Dùng mã khôi phục" link, which switches to a recovery-code input;
     - a "Dùng passkey" button when `methods` includes `passkey`. It calls `passkeyAssertionOptions` with `purpose=mfa`, then `navigator.credentials.get` using `PublicKeyCredential.parseRequestOptionsFromJSON` (fall back to `@simplewebauthn/browser` when unsupported), then `completeMfaLogin`.
   - Keep the `mfa_token` in memory only, never in storage. For Google sign-in it is in the `wk_mfa` cookie, so the page calls `completeMfaLogin` without it.
   - Handle `MFA_CODE_INVALID` inline, and `MFA_TOKEN_INVALID` by going back to `/login` with a message.
   - Keep `return_to` and the `wk_oauth` marker logic.
2. **"Đăng nhập bằng passkey"** button on `/login`: `passkeyAssertionOptions` (`purpose=login`), then `passkeyLogin`. Hide it when `window.PublicKeyCredential` is missing.
3. **Settings → "Bảo mật"** (`/cai-dat/bao-mat`):
   - **Status card** from `getMySecurity`.
   - **Step-up dialog.** It opens on any `403 STEP_UP_REQUIRED`, then retries the original action once. Offer only the methods the account has: password if `has_password`; TOTP; passkey; email code otherwise.
   - **TOTP.**
     - `startTotpSetup`: show the QR, rendered locally from `otpauth_uri` (no external QR service), plus the secret for manual entry.
     - Then `confirmTotpSetup`.
     - Then show the recovery codes once, with "Sao chép" and "Tải xuống .txt" buttons and an "Tôi đã lưu" checkbox before closing.
     - Turn off with `disableTotp`.
   - **Passkeys.** List, add (`passkeyRegistrationOptions`, then `navigator.credentials.create`, then `addPasskey`, with a default name from the device), rename, delete.
   - **Recovery codes.** Remaining count; "Tạo mã mới".
   - **Sessions.** List with device, country (flag + name), last used and "Thiết bị này"; "Đăng xuất" per row; "Đăng xuất tất cả thiết bị khác".
   - **Security log** (`listMySecurityEvents`) with Vietnamese labels for every kind, infinite scroll.
4. **Staff banner.** When `user.staff_roles_pending_mfa` is not empty, show a persistent banner: "Bật xác thực hai lớp để dùng quyền quản trị". It links to the security page. Hide admin UI until the roles are effective (this already follows `roles`).
5. **`/bao-cao-dang-nhap?token=…`** page for the "Không phải tôi" mail link. It calls `reportSession`, then suggests changing the password and enabling 2FA.
6. **Captcha.**
   - Load Cloudflare Turnstile only on `/register` and `/login`, from `challenges.cloudflare.com`, only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set.
   - Send `turnstile_token`.
   - On `CAPTCHA_REQUIRED` from `login`, show the widget and retry.
   - Update the CSP to allow only that script and frame origin.
7. `PASSWORD_BREACHED` on register, change and reset shows: "Mật khẩu này đã bị lộ trong một vụ rò rỉ dữ liệu, hãy chọn mật khẩu khác".

## Tests (Vitest + Testing Library; mock WebAuthn)
- `login` → `MfaChallenge` → `/login/2fa` → code → signed in. Recovery-code path. Passkey path (mock `navigator.credentials`). Expired token → back to login.
- Step-up dialog opens on `403 STEP_UP_REQUIRED` and retries.
- TOTP setup shows the QR and secret, and the recovery codes once.
- Session list: revoke one, revoke others.
- Staff banner visible only with pending roles.
- Turnstile appears only when the site key is set and on `CAPTCHA_REQUIRED`.
