# auth-svc (services/auth)

Authentication and session identity service for Winkey.
Owner: **Antigravity 3** (Tasks A1, A2, A3).

## Overview

- **Access Token:** RS256 JWT, 15 minutes TTL (`expires_in: 900`). Verified completely in-memory by `/v1/auth/verify` for Traefik forwardAuth (target p99 < 2ms).
- **Refresh Token (`wk_rt`):** 32-byte opaque random token stored as SHA-256 binary hash in `auth.refresh_tokens`. Rotates on every use; token reuse detection revokes the entire family immediately.
- **Passwords:** Argon2id with OWASP baseline parameters (`m=19456 KiB`, `t=2`, `p=1`). Transparently rehashes on login if parameters change.
- **Outbox:** Enqueues `user.registered` domain events into `auth.outbox` within the registration transaction via `@winkey/outbox`.
- **Public Profiles:** Exposes `GET /v1/users/{handle}` reading the `auth.public_profiles` view.

---

## Environment Variables

| Variable | Description | Default / Example |
|---|---|---|
| `NODE_ENV` | Runtime environment (`development`, `production`, `test`) | `development` |
| `HTTP_PORT` | Port for the HTTP server to listen on | `8001` |
| `DATABASE_URL` | PostgreSQL connection string (must connect as role `auth_svc`) | `postgres://auth_svc:auth_svc@localhost:5432/winkey?sslmode=disable` |
| `NATS_URL` | NATS JetStream server URL | `nats://localhost:4222` |
| `VALKEY_URL` | Valkey (Redis) connection string for rate limiting | `redis://localhost:6379` |
| `JWT_PRIVATE_KEY` | RSA private key (PEM format, PKCS#8) for signing access tokens | (required) |
| `JWT_KID` | Key identifier for the active RSA key | `winkey-auth-key-1` |
| `JWT_PREVIOUS_PUBLIC_KEY` | Optional previous RSA public key (PEM format, SPKI) during rotation | (optional) |
| `JWT_ISSUER` | Issuer URI for token claims (`iss`) | `https://winkey.vn` |
| `PUBLIC_ORIGIN` | Public website origin used to enforce CORS/Origin security on `/refresh` and `/logout` | `https://winkey.vn` |
| `MEDIA_BASE_URL` | Base URL for avatars and static media | `https://media.winkey.vn` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | (optional for local dev) |
| `GOOGLE_CLIENT_SECRET`| Google OAuth Client Secret | (optional for local dev) |
| `GOOGLE_REDIRECT_URI` | Google OAuth Redirect Callback URI | `https://winkey.vn/v1/auth/oauth/google/callback` |
| `COOKIE_SECRET` | Secret key used to sign temporary OAuth session state cookies | (minimum 32 characters) |
| `TRUST_PROXY_CIDRS` | Comma-separated CIDRs of upstream reverse proxies to trust for client IP resolution | `10.42.0.0/16,127.0.0.1` |

---

## JWT Key Generation & Rotation Procedure

RS256 keys rotate smoothly without invalidating currently active access tokens:

### 1. Generating a New Key Pair
```bash
# Generate a new 2048-bit RSA private key (PKCS#8)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private_new.pem

# Extract the public key (SPKI)
openssl pkey -in private_new.pem -pubout -out public_new.pem
```

### 2. Zero-Downtime Rotation Steps
1. **Prepare rotation:** Set `JWT_PREVIOUS_PUBLIC_KEY` to the contents of the *currently active public key*.
2. **Promote new key:** Update `JWT_PRIVATE_KEY` to the new private key and assign a new `JWT_KID` (e.g. `winkey-auth-key-2`).
3. **Deploy:** Restart or redeploy `auth-svc`.
   - `auth-svc` now issues new JWTs with the new key (`JWT_KID`).
   - `/.well-known/jwks.json` publishes both the new key and previous key.
   - Any access tokens issued right before the deployment (valid for up to 15 min) continue to be accepted by `/v1/auth/verify`.
4. **Retire previous key:** After at least 24 hours, remove `JWT_PREVIOUS_PUBLIC_KEY` from configuration and redeploy.

---

## Rate Limiting

Rate limiting is enforced via Valkey (sliding window counter):
- **Login:** Maximum 5 requests/minute per (IP + email) AND 20 requests/minute per IP.
- **Register:** Maximum 5 requests/hour per IP.
- **Profile Updates (`PATCH /v1/auth/me`):** Maximum 10 changes/hour per user ID.
- **Account Actions (`changePassword`, `deleteMe`):** Maximum 5 requests/minute per user ID AND 20 requests/minute per IP.
- **Exceeded:** Returns `429 Too Many Requests` with RFC 9457 `application/problem+json` and `Retry-After: <seconds>` header.

---

## Account Self-Service (Task A3)

| Endpoint | Method | Security | Description |
|---|---|---|---|
| `/v1/auth/me` | `GET` | Bearer | Returns the authenticated `User` record including `has_password: boolean`. |
| `/v1/auth/me` | `PATCH` | Bearer | Edits `display_name` (1-50 chars) and/or `handle` (`^[A-Za-z0-9_.]{3,30}$`). Case-insensitive collision maps to `409` `HANDLE_TAKEN` via DB unique violation. Same values return `200` without a DB write. Rate limited to 10 changes/hour per user ID. Updates immediately reflect in `auth.public_profiles`. |
| `/v1/auth/me/password` | `PUT` | Bearer | Sets or changes account password. Accounts with a password require `current_password` (verified with argon2id, mismatch yields `403` `INVALID_CREDENTIALS`). OAuth-only accounts must omit `current_password` (if provided -> `400`) and set their first password. In the same transaction, revokes all refresh token families except the family matching the request's `wk_rt` cookie (other devices logged out; current session preserved). Rate limited like login. Returns `204`. |
| `/v1/auth/me` | `DELETE` | Bearer | Anonymizes and deletes account. Requires `confirm_handle` (case-insensitive match, else `400` `CONFIRMATION_MISMATCH`) and `password` if account has a password (`403` `INVALID_CREDENTIALS` if invalid). Protected by `LAST_ADMIN` transaction advisory lock (`pg_advisory_xact_lock(hashtext('auth.last_admin'))`); sole admin receives `409` `LAST_ADMIN`. In a single transaction with `SELECT ... FOR UPDATE`: scrubs user row (`email = deleted+<id>@invalid.winkey.vn`, `handle = d_<28 hex>` [exactly 30 chars], `display_name = 'Deleted user'`, `status = 'DELETED'`, NULLs for passwords, avatar, suspension), deletes `auth.oauth_identities`, and revokes all refresh tokens. Clears `wk_rt` cookie (Max-Age=0) and returns `204`. The previous email and handle become immediately available for new registrations. |

---

## Admin & Moderation (Task A2a)

### RBAC Matrix

| Endpoint | Roles Allowed | Notes |
|---|---|---|
| `GET /v1/admin/users` | `moderator`, `admin` | Prefix search on email/handle, trigram search on `display_name`, status & role filters, cursor pagination. |
| `GET /v1/admin/users/{user_id}` | `moderator`, `admin` | Returns detailed `AdminUser` record. |
| `PUT /v1/admin/users/{user_id}/roles` | `admin` only | Cannot modify self or another admin. Transactionally audited as `USER_ROLES_CHANGED`. No-op writes nothing. |
| `PUT /v1/admin/users/{user_id}/suspension` | `moderator`, `admin` | Moderator cannot suspend moderator or admin. Nobody can suspend self or an admin. Immediately revokes all refresh tokens. Transactionally audited as `USER_SUSPENDED`. |
| `DELETE /v1/admin/users/{user_id}/suspension` | `moderator`, `admin` | Moderator cannot unsuspend moderator or admin. Idempotent: lifting active status returns 200 without audit row. |
| `GET /v1/admin/audit-log` | `admin` only | Lists admin audit records newest-first with actor profiles, supports optional `target_user_id` query filter and cursor pagination. |

### Suspension Lifecycle & Security

1. **Immediate Revocation:** Suspending a user revokes all active refresh-token families (`revoked_at = NOW()`), immediately preventing token refreshes.
2. **Login Rejection:** Suspended users attempting `POST /v1/auth/login` receive `403 Forbidden` (`ACCOUNT_SUSPENDED`). The problem `detail` communicates the suspension expiry `until` timestamp if temporary; internal staff `reason` notes are never leaked.
3. **OAuth Handling:** Google OAuth callbacks for suspended users redirect to `/login?error=ACCOUNT_SUSPENDED` without issuing session cookies.
4. **Auto-Unsuspend:** When a user with an expired temporary suspension authenticates with valid credentials, `auth-svc` automatically restores status to `ACTIVE`, clears suspension fields, and records a `USER_UNSUSPENDED` audit log entry (`{"expired": true}`) in a single transaction.

---

## Running & Testing

```bash
# Install dependencies
pnpm --dir services/auth install

# Run unit and integration tests
pnpm --dir services/auth test

# Typecheck
pnpm --dir services/auth typecheck

# Build for production
pnpm --dir services/auth build

# Start production server
pnpm --dir services/auth start
```

