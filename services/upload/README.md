# upload-svc

Direct-to-storage multipart uploads. Implements [`contracts/openapi/upload.v1.yaml`](../../contracts/openapi/upload.v1.yaml); emits `video.uploaded` through the transactional outbox (ADR-008). Owner: Sonnet 5.5.

## Behaviour

| Endpoint | Notes |
|---|---|
| `POST /v1/uploads` | Role `creator` (403 otherwise). `part_size = max(16 MiB, ceil(size/10000))` rounded up to a whole MiB. Creates the S3 multipart upload, then the `media.videos` row (`UPLOADING`, `raw_key = {owner_id}/{video_id}/source`). If the insert fails the multipart upload is aborted. |
| `POST /v1/uploads/{id}/parts` | Presigns `UploadPart` URLs (TTL 1 h) with the **public** S3 client. Owner + `UPLOADING` required (409 otherwise). |
| `POST /v1/uploads/{id}/complete` | Part list must be exactly `1..part_count`. Completes the multipart upload, `HeadObject`s and compares with `size_bytes` (mismatch → `FAILED`, 400 `SIZE_MISMATCH`, object deleted). Then **one transaction**: conditional `UPLOADING→UPLOADED`, clear `s3_upload_id`, enqueue `video.uploaded`. Repeating the call on `UPLOADED/PROCESSING/READY` returns 202 with the current status. |
| `GET /v1/uploads/{id}` | Status + progress of the latest `transcode_jobs` row (100 when `READY`); `error` is always present (`null` if none). |
| `DELETE /v1/uploads/{id}` | 409 unless `UPLOADING`; aborts the multipart upload and deletes the row. |

Non-owners, unknown ids and malformed ids all get **404**, never 403. Identity comes only from `X-User-Id` / `X-User-Roles`.

**Janitor**: every `JANITOR_INTERVAL`, uploads `UPLOADING` for longer than `UPLOAD_STALE_AFTER` are aborted on S3 and their rows deleted (uses index `media.videos_stale_uploads`).

**Two S3 endpoints** (shared client `libs/go/s3x`): `S3_ENDPOINT` (internal) for server-side calls; `S3_PUBLIC_ENDPOINT` (e.g. `https://s3.winkey.vn`) only for presigning, because the signature is bound to the host. Both are path-style with `S3_REGION=garage`. SDK request checksums are disabled (`WhenRequired`) so presigned URLs carry no checksum headers a browser would not send.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL (role `media_svc`) |
| `NATS_URL` | required | JetStream for the outbox relay |
| `S3_ENDPOINT` | required | Internal S3 endpoint |
| `S3_PUBLIC_ENDPOINT` | required | Public endpoint used only to presign |
| `S3_REGION` | `garage` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | required | |
| `S3_RAW_BUCKET` | `winkey-raw` | |
| `HTTP_ADDR` | `:8080` | |
| `LOG_LEVEL` | `info` | |
| `JANITOR_INTERVAL` | `10m` | |
| `UPLOAD_STALE_AFTER` | `24h` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Tracing is a no-op when unset |

Probes: `GET /healthz`, `GET /readyz` (PostgreSQL, NATS, S3 bucket), `GET /metrics`.

## Run

```bash
cp .env.example .env   # edit, then export the variables
go run ./cmd/upload
```

## Test

```bash
go test ./...                              # unit tests; integration tests skip without Docker
WINKEY_REQUIRE_DOCKER=1 go test ./...      # CI: PostgreSQL 17 + NATS + Garage via testkit
```

## Image

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f services/upload/Dockerfile .   # from the repo root
```
Distroless `static:nonroot`, no shell, runs as non-root.

## Known limitation

If the process dies between `CreateMultipartUpload` and the row insert, the multipart upload is orphaned in Garage (no row for the janitor to find). Configure a bucket lifecycle rule to abort incomplete multipart uploads if this matters.
