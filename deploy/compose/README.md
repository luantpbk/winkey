# Winkey Local Development Stack

Docker Compose development environment for Winkey platform services, supporting multi-arch (`linux/amd64` and `linux/arm64`).

## 1. Overview & Architecture

The stack runs all stateful dependencies and edge ingress required for developing Winkey:
- **PostgreSQL 17**: Database with roles `winkey_migrator`, `auth_svc`, `media_svc` and transactional outbox tables.
- **golang-migrate**: Applies `db/migrations` schema as `winkey_migrator`.
- **Valkey 8.x**: In-memory Redis-compatible cache and rate limiting.
- **NATS JetStream 2.x**: Message broker with streams `VIDEO`, `USER`, and `DLQ` configured.
- **Garage S3 (v1.x)**: Single-node object storage with buckets `winkey-raw`, `winkey-media`, `winkey-backups`, website hosting, and CORS.
- **media-cache**: Local Nginx proxy cache on port 8081 fronting Garage web endpoint with byte-range and immutable caching.
- **Traefik Gateway**: API Gateway on port 8080 routing `/v1/*` endpoints with security middleware stripping spoofed identity headers.
- **whoami**: Mock upstream used for gateway smoke testing.

## 2. Ports & Endpoints

| Service | Host Port | Internal Endpoint | Description |
|---|---|---|---|
| **Traefik Gateway** | `8080` | `http://traefik:8080` | Main entrypoint for web and API `/v1/*` |
| **Traefik Dashboard** | `8082` | `http://traefik:8082` | Traefik UI & metrics |
| **media-cache** | `8081` | `http://media-cache:8081` | HLS video segment delivery cache |
| **PostgreSQL** | `5432` | `postgres:5432` | PostgreSQL 17 database |
| **Valkey (Redis)** | `6379` | `valkey:6379` | Cache & session storage |
| **NATS Client** | `4222` | `nats:4222` | NATS JetStream messaging |
| **NATS Monitoring** | `8222` | `http://nats:8222` | NATS health & metrics |
| **Garage S3 API** | `3900` | `http://garage:3900` | S3 compatible API endpoint |
| **Garage Web Endpoint**| `3902` | `http://garage:3902` | Direct S3 website hosting |

All services bind to `${DEV_BIND_IP:-0.0.0.0}`, allowing access across local network and Tailnet (e.g., when hosted on `gpu-01`).

## 3. Database Roles & Credentials

Default development credentials configured via `deploy/compose/postgres/01-init-roles.sh`:

| Role | Default Password | Permissions & Grants |
|---|---|---|
| `winkey_migrator` | `winkey_migrator` | Database owner; schema migrations |
| `auth_svc` | `auth_svc` | `USAGE` on schema `auth`; CRUD on `auth.*` |
| `media_svc` | `media_svc` | `USAGE` on `media`; CRUD on `media.*`; `USAGE` on `auth` + `SELECT` on `auth.public_profiles` |
| `postgres` (superuser)| `postgres` | Maintenance & administration |

Database Connection URLs:
- Migrations: `postgres://winkey_migrator:winkey_migrator@localhost:5432/winkey?sslmode=disable`
- auth-svc: `postgres://auth_svc:auth_svc@localhost:5432/winkey?sslmode=disable`
- upload-svc / video-svc / transcoder: `postgres://media_svc:media_svc@localhost:5432/winkey?sslmode=disable`

## 4. Garage S3 Credentials & Buckets

Garage generates credentials dynamically upon bootstrap and saves them to:
`deploy/compose/.generated.env` (gitignored).

Standard Dev Values:
- **Region**: `garage`
- **S3 Endpoint (Internal)**: `http://garage:3900`
- **S3 Endpoint (Public / Local)**: `http://localhost:3900`
- **Buckets**:
  - `winkey-raw`: Input video uploads (CORS enabled for `http://localhost:3000`)
  - `winkey-media`: Transcoded HLS playlists and fragments (website enabled)
  - `winkey-backups`: Nightly database backups

### CORS Verification on `winkey-raw`
To verify that browser multipart uploads can access `winkey-raw` from `http://localhost:3000`:
```bash
curl -X OPTIONS \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: Content-Type,ETag" \
  -i http://localhost:3900/winkey-raw/test
```
Expected headers in response:
```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:3000
Access-Control-Allow-Methods: PUT, GET, HEAD
Access-Control-Expose-Headers: ETag
Access-Control-Max-Age: 3600
```

## 5. Quickstart & Makefile Commands

```bash
# 1. Start the stack and wait for all services to be healthy
make dev

# 2. View logs
make dev-logs

# 3. Open psql shell inside postgres container
make dev-psql

# 4. Open NATS CLI inside container
make dev-nats

# 5. Stop containers
make dev-down

# 6. Reset database and storage volumes to initial state
make dev-reset
```

## 6. How Agents Point Services at the Stack

### Antigravity 1 (`apps/web`)
Set in `apps/web/.env.local`:
```env
NEXT_PUBLIC_API_URL=http://localhost:8080/v1
NEXT_PUBLIC_MEDIA_URL=http://localhost:8081
```

### Antigravity 3 (`services/auth`)
Set in `services/auth/.env`:
```env
PORT=3001
DATABASE_URL=postgres://auth_svc:auth_svc@localhost:5432/winkey?sslmode=disable
NATS_URL=nats://localhost:4222
VALKEY_URL=redis://localhost:6379
```

### Sonnet 5.5 (`services/upload`, `services/transcoder`, `services/video`)
Source the generated S3 credentials from `deploy/compose/.generated.env`:
```env
DATABASE_URL=postgres://media_svc:media_svc@localhost:5432/winkey?sslmode=disable
NATS_URL=nats://localhost:4222
VALKEY_URL=redis://localhost:6379
AWS_REGION=garage
S3_ENDPOINT=http://localhost:3900
S3_PUBLIC_ENDPOINT=http://localhost:3900
# AWS_ACCESS_KEY_ID & AWS_SECRET_ACCESS_KEY from .generated.env
```

## 7. Security Smoke Test

To verify that Traefik strips client-supplied `X-User-Id` and `X-User-Roles` headers before requests reach upstreams:
```bash
./deploy/compose/smoke-test.sh
```
