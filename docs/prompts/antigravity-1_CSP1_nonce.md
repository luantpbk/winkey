# Antigravity 1 — CSP1: strict CSP with per-request nonces (web)

Read `AGENTS.md`, then **ADR-049**, the CSP1 addendum (2026-10-29) at the end of `docs/DECISIONS.md`. Work in `apps/web` and `e2e/`. Branch `agent/ag1/csp1-nonce` from `origin/main`. Do not merge your own PR.

## Phase 1 (this PR): Report-Only
1. **Policy builder** `src/lib/security/csp.ts`: `buildCsp({ nonce, isDev, embed, mediaOrigin, uploadOrigin })` → the exact policy string in the addendum. Origins come from `CSP_MEDIA_ORIGIN` / `CSP_UPLOAD_ORIGIN`; validate each one as an origin (`new URL(x).origin === x`), otherwise drop it and log once. Never emit `*` outside `frame-ancestors` on `/embed/*`.
2. **Middleware** (`src/middleware.ts`, `export const config = { runtime: 'nodejs', matcher: … }`):
   - generate the nonce with `crypto.getRandomValues` (16 bytes, base64);
   - pass `x-nonce` and `content-security-policy` on the **request** headers (`NextResponse.next({ request: { headers } })`, and the same for the `next-intl` response path), so Next applies the nonce to its own scripts;
   - set `Content-Security-Policy-Report-Only` on the **response** (phase 1). Keep the existing `Content-Security-Policy` from `next.config.ts` unchanged in phase 1;
   - the matcher must now also cover `/embed/*` (with `embed: true`, and still no locale rewrite) and every HTML page. It must not cover `_next/static`, `_next/image`, `/v1/*`, files with an extension, `/healthz`, `/readyz` or `/api/csp-report`. Keep every existing redirect working.
3. **Dynamic rendering:** the locale layout and the static legal pages must render per request; otherwise the nonce is missing. Remove `generateStaticParams` there, or read `headers()` in the root layout. Check `next build` output: every HTML route is `ƒ` (dynamic).
4. **Turnstile:** load `https://challenges.cloudflare.com/turnstile/v0/api.js` with `next/script` and `nonce={nonce}` from `headers().get('x-nonce')`, passed down from a server component. With `'strict-dynamic'`, any script it inserts is allowed.
5. **JSON-LD** blocks (`type="application/ld+json"`) are data, not script; keep `jsonLd()` escaping. Do not add other inline scripts or `eval`. Grep for `new Function`, `setTimeout("…")` and inline `on*=` handlers and remove any you find.
6. **Report endpoint** `src/app/api/csp-report/route.ts` (`POST` only, `dynamic = 'force-dynamic'`):
   - accept `application/csp-report` (`{ "csp-report": {…} }`) and `application/reports+json` (array of `{ type: "csp-violation", body: {…} }`);
   - body ≤ 8 KiB, else `413`;
   - 60 reports/min per client IP (in-memory, from `x-forwarded-for`'s first hop, trusted because the ingress sets it);
   - log one JSON line per violation with `effective_directive`, `blocked_uri` and `document_uri`, both URIs with **query and fragment stripped**, plus `disposition` and `status_code`. Log no cookies, no user agent string beyond its family, no IP;
   - always answer `204`.

## Tests
- Unit, `buildCsp`: production has no `unsafe-inline` or `unsafe-eval` in `script-src`; dev adds `unsafe-eval`; embed → `frame-ancestors *`, everything else `frame-ancestors 'self'`; invalid origins are dropped; the nonce appears exactly once.
- Middleware: two requests get different nonces; the response Report-Only header and the request `x-nonce` carry the same nonce; `/embed/x` gets the embed policy and no locale redirect; every existing redirect test still passes.
- Report route: both formats, query stripping, the size limit, the rate limit, always `204`.
- Update `test/csp-headers.test.ts` for phase 1: the old header is still sent, and the new Report-Only header is present.
- **E2E (Playwright):** collect `securitypolicyviolation` events (`page.addInitScript` that pushes `e.violatedDirective` and `e.blockedURI` to `window.__csp`) and assert there are none on:
  - home, watch (HLS playback starts), `/embed/{id}`;
  - login and register with Turnstile (test site key);
  - studio upload start, `/bang-tin` with a social video post, settings/security.
- `next build` route table in the PR description, with every HTML route dynamic.

Push, open the PR with the Handoff Report, and report when CI is green.

## Phase 2 (a separate PR, only when the architect says so after 24 h of clean reports)
Switch the middleware header to `Content-Security-Policy`, remove the `script-src … 'unsafe-inline'` header from `next.config.ts` (the `/embed` rule goes too, since the middleware covers it), and turn the E2E check into an enforce-mode check.
