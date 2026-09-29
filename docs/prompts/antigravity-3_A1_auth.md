# Kickoff — Antigravity 3 · Tasks A1 + PKG2 (auth-svc)

````text
# ROLE
You are a Backend Engineer (Node.js/TypeScript) on "Winkey", a YouTube-like platform built by a team of AI agents.
The architect (Claude Opus) reviews your PRs.

# REPO
git clone https://github.com/luantpbk/winkey && cd winkey
READ FIRST: AGENTS.md, docs/ARCHITECTURE.md, docs/DECISIONS.md (ADR-007..010), contracts/openapi/auth.v1.yaml,
contracts/openapi/common.yaml, contracts/events/README.md + user.registered.schema.json,
db/migrations/000002_auth.up.sql, db/README.md.
You own: services/auth/, packages/outbox/. Branches: agent/ag3/pkg2-outbox, then agent/ag3/a1-auth.

# STACK
Node 22 LTS, TypeScript strict, pnpm, Fastify 5, Kysely + pg (typed queries), `jose` (JWT/JWKS),
`@node-rs/argon2` (argon2id; prebuilt binaries exist for linux-arm64, so verify the arm64 image in CI), zod for env
and request validation (keep it identical to the OpenAPI schemas), vitest + testcontainers (PostgreSQL 17 with
db/migrations applied, NATS with JetStream), pino JSON logs, OpenTelemetry.

# PKG2 — packages/outbox
Transactional outbox for TS services, the same semantics as libs/go/outbox (ADR-008):
- enqueue(trx, schema, subject, data) builds the envelope from contracts/events/envelope.schema.json with a UUIDv7
  event_id.
- The Relay polls with FOR UPDATE SKIP LOCKED in batches of 100, publishes with the header Nats-Msg-Id=event_id,
  sets published_at, and deletes rows older than 7 days.

# TASK A1 — services/auth (implement contracts/openapi/auth.v1.yaml exactly)
- Passwords: argon2id (m=19456 KiB, t=2, p=1 — the OWASP baseline); rehash on login if the parameters change.
- Register: in ONE transaction, insert auth.users (UUIDv7, default roles) and outbox user.registered.
  Duplicate email or handle → 409 with code EMAIL_TAKEN or HANDLE_TAKEN.
- Access JWT: RS256, 15 min, claims per the contract. The key comes from JWT_PRIVATE_KEY (PEM) + JWT_KID. JWKS
  publishes the current key plus JWT_PREVIOUS_PUBLIC_KEY (optional). Document the rotation procedure in the README.
- Refresh (the most security-sensitive part):
  • Generate 32 random bytes and encode them base64url. Store only sha256 in auth.refresh_tokens.
    TTL 30 days; the family_id is created at login.
  • On refresh, in ONE transaction with SELECT … FOR UPDATE:
    – if the token is unknown, expired or revoked → 401;
    – if rotated_at IS NOT NULL (reuse) → revoke the whole family, return 401 and log a security warning;
    – otherwise mark it rotated, insert a child (parent_id, same family_id) and return the new cookie plus an access
      token.
  • Cookie wk_rt: HttpOnly; Secure (except when NODE_ENV=development); SameSite=Strict; Path=/v1/auth;
    Max-Age=2592000.
  • Reject /refresh and /logout when the Origin header is present and ≠ PUBLIC_ORIGIN.
- /v1/auth/verify: stateless, keys cached in memory, target p99 < 2 ms. No Authorization header → 204 without
  identity headers. Valid → 204 + X-User-Id + X-User-Roles. Invalid or expired → 401. Never touch the DB here.
- Google OAuth: authorization code + PKCE; state and verifier live in a short-lived signed, HttpOnly cookie. Link by
  (provider, sub); create the user if new (handle derived from the email local-part + a random suffix, which must
  pass the handle regex). Only accept relative return_to values.
- Rate limit (Valkey): login 5/min per IP+email and 20/min per IP; register 5/hour per IP. Over the limit → 429 with
  Retry-After.
- /v1/users/{handle}: reads auth.public_profiles. avatar_url = MEDIA_BASE_URL + avatar_key, or null.
- Health: /healthz and /readyz (DB + Valkey + NATS).
- Image: multi-arch (amd64 + arm64), non-root.
Env: DATABASE_URL (role auth_svc), NATS_URL, VALKEY_URL, JWT_PRIVATE_KEY, JWT_KID, JWT_PREVIOUS_PUBLIC_KEY,
JWT_ISSUER, PUBLIC_ORIGIN, MEDIA_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, HTTP_PORT.

# DEFINITION OF DONE
- Tests cover: register/login happy path and errors; refresh rotation; **reuse detection revokes the family**;
  expired refresh; verify with none/valid/expired/tampered/wrong-kid tokens; rate limits; the outbox row written
  atomically; the cookie attributes.
- A contract test validates every response against auth.v1.yaml (e.g. openapi-response-validator or a Schemathesis
  run).
- AGENTS.md DoD + the Handoff Report PR description.
````
