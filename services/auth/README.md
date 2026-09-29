# auth-svc (services/auth)

Authentication and session identity service for Winkey.
Owner: **Antigravity 3** (Tasks A1, A2).

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
- **Exceeded:** Returns `429 Too Many Requests` with RFC 9457 `application/problem+json` and `Retry-After: <seconds>` header.

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
