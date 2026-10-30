# Antigravity 1 — CSP1 phase 2: enforce

Read the CSP1 addendum (2026-10-29) at the end of `docs/DECISIONS.md` and your phase 1 brief
(`antigravity-1_CSP1_nonce.md`). Work in `apps/web` (and `e2e/`). Branch `agent/ag1/csp1-enforce`.

## Phase 1 result (24 h of Report-Only on production, 2026-10-29 12:44 → 2026-10-30 12:44 UTC)

89 reports, all `script-src-elem`:

| Blocked origin | Count | Source |
|---|---|---|
| `https://winkey.vn` | 77 | Next.js chunks on 404 pages (`/test`, `/en/test`) |
| `inline` | 11 | Next.js inline runtime scripts on the same 404 pages |
| an external origin | 1 | a manual injection probe (expected to be blocked) |

Allowed origins (Turnstile, media, upload) produced no reports. The only real gap is the 404 page.

**Cause.** `[locale]` has no catch-all route, so an unknown path like `/test` matches no route. Next then
serves the root `app/not-found.tsx`. Neither that page nor the root layout reads request data, so the
page is prerendered at build time. Its scripts therefore never get the per-request nonce.

## Tasks

1. **Nonce on every 404.**
   - Add `src/app/[locale]/[...rest]/page.tsx` that calls `notFound()`. This is the next-intl pattern:
     unknown paths then render `[locale]/not-found.tsx` inside the dynamic `[locale]` layout, which has
     the nonce.
   - Make the root `app/not-found.tsx` dynamic as well, by calling `await connection()` from
     `next/server` or reading `headers()`. Some paths still reach it, for example a path that the
     middleware matcher skips.
   - Check `/embed/<unknown>` (`app/embed/not-found.tsx`) the same way.
2. **Enforce.**
   - In the middleware, change `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
     This applies to both the normal branch and the `/embed` branch.
   - Remove the old `script-src … 'unsafe-inline'` CSP headers from `next.config.ts`, including the
     `/embed` rule, because the middleware now covers it. Keep the other security headers.
   - Keep `report-uri /api/csp-report` (and `report-to` if you have it) so violations keep showing
     up in Loki.
3. **Follow-ups from the #510 review** (same PR):
   - Send `upgrade-insecure-requests` only when the request is HTTPS. Use `x-forwarded-proto`, and
     only from a trusted proxy. Plain-HTTP systest and local dev must not be upgraded.
   - Remove the `window.__TURNSTILE_SITE_KEY__` fallback in `components/auth/turnstile-widget.tsx`;
     the site key comes from the env or config path only.
   - Replace the `images.unsplash.com` URLs in mocks and fixtures with local assets, so that tests
     never depend on an origin the policy does not allow.
4. **Tests.**
   - Unit: the middleware sends `Content-Security-Policy` (not Report-Only) with a fresh nonce on
     every request, for both normal and `/embed` routes. `upgrade-insecure-requests` appears only
     for HTTPS.
   - E2E (Playwright): turn the CSP check into an enforce-mode check. Fail on any
     `securitypolicyviolation` event and on any console CSP error. Cover these pages:
     - home, a film page with the player, login with Turnstile;
     - `/bang-tin` with a social video post, studio upload start, `/tin-nhan` (WASM);
     - **`/test`, `/en/test`, `/embed/does-not-exist` (404s)**.
   - Confirm that the 404 HTML carries `nonce=` on every `<script>` element and that the nonce
     matches the header.
5. **PR description (Handoff Report):** include
   - the `next build` route table, where `/_not-found` must no longer be static (`○`);
   - `curl -sI` output for `/` and `/test` showing `Content-Security-Policy` with a nonce;
   - the E2E run output.

Do not merge your own PR. AG2 deploys it after merge and watches `csp_violation` in Loki for 24 h.
