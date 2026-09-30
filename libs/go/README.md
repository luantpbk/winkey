# libs/go

Shared Go library for Winkey services (`github.com/luantpbk/winkey/libs/go`). Owner: Sonnet 5.5.

| Package | Purpose |
|---|---|
| `config` | Env loading into a struct via `env:"NAME,required"` / `default:"…"` tags. Reports **all** problems at once; never echoes values. |
| `ids` | UUIDv7 (`ids.New`, `ids.NewString`) — ADR-010. |
| `obs` | JSON `slog` logger (`ts, level, msg, service, trace_id, request_id`), OTLP tracing (no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set), `Health` (`/healthz`, `/readyz`, `/metrics`). |
| `httpx` | chi router with request-id → tracing → recover → access-log/metrics; RFC 9457 `problem+json`; `Authenticate` / `RequireRole` from `X-User-Id` / `X-User-Roles`; strict `DecodeJSON`. |
| `outbox` | Transactional outbox (ADR-008): `Enqueue(ctx, tx, schema, subject, event)` and `Relay`. |
| `s3x` | Shared S3 client for Garage (ADR-004): path-style, checksums only when required, **internal endpoint for server-side calls and a separate public endpoint used only to presign** (`ErrNoPublicEndpoint` instead of silently signing for the wrong host). Head/Delete/`DeletePrefix` (guarded)/`ListPrefixes`, ranged `Download`, `UploadFile` with Content-Type/Cache-Control, multipart (create, presign part, complete, abort), and sentinel errors `ErrNotFound` / `ErrNoSuchUpload` / `ErrInvalidPart`. |
| `testkit` | Testcontainers helpers: PostgreSQL 17 (+ `db/migrations`; or an external server via `WINKEY_TEST_PG_URL`), NATS JetStream (+ contract streams), Garage single node (+ buckets, key, CORS). |

## Using it from a service

```go
// services/<svc>/go.mod
require github.com/luantpbk/winkey/libs/go v0.0.0
replace github.com/luantpbk/winkey/libs/go => ../../libs/go
```

(No root `go.work` is committed: root tooling belongs to the platform owner. Once it exists the `replace` can go.)

## Outbox

```go
outbox.SetProducer("upload-svc")                 // once, at startup
tx, _ := pool.Begin(ctx)
// ... business writes ...
err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", VideoUploaded{...}) // `data` payload only
tx.Commit(ctx)

relay := &outbox.Relay{Pool: pool, Publisher: outbox.JetStreamPublisher{JS: js}, Schema: "media", Listen: true}
go relay.Run(ctx)
```

- The envelope (`event_id` UUIDv7, `type` = subject, `version` 1, `occurred_at`, `producer`, `traceparent`) follows `contracts/events/envelope.schema.json`; a unit test validates it against the contract.
- Relay: polls every 500 ms (plus `LISTEN/NOTIFY` when `Listen` is set), batches of 100 with `FOR UPDATE SKIP LOCKED`, publishes with `Nats-Msg-Id = event_id`, sets `published_at`, and deletes rows published more than 7 days ago. With several relay replicas, ordering is best-effort — consumers must be idempotent.
- `schema` is validated as a plain identifier and quoted.

## Tests

```bash
cd libs/go
go test ./...                          # unit tests; container tests skip without Docker
WINKEY_REQUIRE_DOCKER=1 go test ./...  # CI: fail instead of skip when Docker is missing
```

### Running the PostgreSQL tests without Docker

`testkit.StartPostgres` starts a `postgres:17-alpine` container. If you have no Docker, point it at a PostgreSQL 17 server you run yourself:

```bash
export WINKEY_TEST_PG_URL='postgres://winkey:winkey@127.0.0.1:5432/postgres?sslmode=disable'
go test ./...                       # in libs/go or any service
```

Each `StartPostgres` call then creates a **new database** (`winkey_test_<random>`) on that server, applies `db/migrations` to it and drops it (`DROP DATABASE … WITH (FORCE)`) when the test ends, so tests are isolated and can run in parallel. The URL should name an existing database (e.g. `postgres`), and the role needs `CREATEDB` and the right to create the `citext`, `pg_trgm` and `unaccent` extensions (server with the contrib package; superuser or trusted extensions). Use a throwaway server: never point it at data you care about. Valkey and NATS still need Docker (`-tags miniredis` replaces Valkey in video-svc). CI does not set the variable: it uses the container with `WINKEY_REQUIRE_DOCKER=1`, and `WINKEY_TEST_PG_URL` takes precedence over both when set.

`testkit.StartGarage` uses `dxflrs/garage:v1.0.1`, layout/key/bucket bootstrap through the `garage` CLI, CORS on `winkey-raw` via `PutBucketCors`. Integration tests must use it rather than MinIO.
