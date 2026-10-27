# Antigravity 2 — SOC-1a: secrets, egress and rollout of account security (ADR-049)

Read **ADR-049** (the SOC-1a addendum, especially the rollout order) and the env table in `docs/prompts/antigravity-3_SOC1a_account-security.md`. Work in `deploy/` and `.github/workflows/*` (not `contracts.yml`). **Apply to production only after the corresponding PR is merged.**

Branch: `agent/ag2/soc1a-rollout` from `origin/main`.

## Task
1. **Secrets** (k8s Secret for auth-svc, never in git; generate on the host with `openssl rand -base64 32`):
   - `TOTP_ENCRYPTION_KEYS` (`k1:<base64>`);
   - `SESSION_IP_SALT`;
   - `WEBAUTHN_USER_HANDLE_KEY`;
   - `TURNSTILE_SECRET`.
   For Turnstile, the user creates the site in the Cloudflare dashboard and puts the secret in with `read -rs`.
   - **Back up `TOTP_ENCRYPTION_KEYS`** with the other secrets (the vault). Losing it disables every user's TOTP.
2. **Config:**
   - `WEBAUTHN_RP_ID=winkey.vn`;
   - `WEBAUTHN_ORIGINS=https://winkey.vn,https://www.winkey.vn`;
   - `PASSWORD_BREACH_CHECK=true`;
   - `STAFF_MFA_REQUIRED=false` for the first rollout;
   - web `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
   Compose and systest: dummy keys, `STAFF_MFA_REQUIRED=true`, no Turnstile, breach check off.
3. **Country.** Confirm whether `winkey.vn` is proxied by Cloudflare (orange cloud). If it is, make sure `CF-IPCountry` reaches auth-svc and that the client-IP trust chain covers Cloudflare's ranges. If it is not, report it: `country` will stay null, which is acceptable.
4. **Egress.** Allow auth-svc to reach `challenges.cloudflare.com:443` and `api.pwnedpasswords.com:443` (NetworkPolicy, or document it if there is none).
5. **CSP.** Make the web `Content-Security-Policy` allow `https://challenges.cloudflare.com` for `script-src` and `frame-src`, only if AG1 does not own that header in the app. Coordinate with AG1.
6. **Rollout, in order:**
   1. migration `000028`;
   2. auth-svc PR #1, then PR #2;
   3. web;
   4. tell the user to enable 2FA on the admin account (the architect posts the steps);
   5. then set `STAFF_MFA_REQUIRED=true` and restart auth-svc.
7. Report each step on #47: digests from CI logs, `readyz`, synthetic 8/8, and a test login with and without 2FA on a test account (never the user's).
