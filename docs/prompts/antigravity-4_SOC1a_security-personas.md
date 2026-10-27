# Antigravity 4 — SOC-1a: system tests for account security (ADR-049)

Read **ADR-049** (the SOC-1a addendum) and the `security` operations in `contracts/openapi/auth.v1.yaml`. Work in `systest/` only. Start when the auth-svc and web SOC-1a PRs are merged. Run only on the local or CI systest stack, never on production.

Branch: `agent/ag4/soc1a-security-personas` from `origin/main`.

## Personas (Playwright + API)
1. **`mfa-user`:**
   - register;
   - enable TOTP: compute codes with `otplib` from the secret shown on the page;
   - save the recovery codes;
   - sign out;
   - sign in → `/login/2fa` → code → signed in;
   - sign out → sign in with a recovery code → it works once, then the same code is rejected.
2. **`passkey-user`:**
   - use Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, internal transport, resident keys, user verification);
   - add a passkey in settings (step-up with password);
   - sign out;
   - "Đăng nhập bằng passkey" → signed in, no second step.
3. **`session-manager`:**
   - sign in from two browser contexts;
   - context A lists 2 sessions and revokes B;
   - B's next navigation is signed out (refresh → 401).
4. **`staff-mfa`:**
   - the seeded admin without 2FA (systest runs `STAFF_MFA_REQUIRED=true`) sees the banner and no admin UI, and admin API calls return `403`;
   - after enabling TOTP and a refresh, the admin UI is back.

Add the personas to the sim matrix and keep each one under 30 s. No sleeps; wait on UI or network conditions.
