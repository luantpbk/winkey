# upload-svc

Direct-to-storage multipart uploads. Implements [`contracts/openapi/upload.v1.yaml`](../../contracts/openapi/upload.v1.yaml); emits `video.uploaded` through the transactional outbox (ADR-008). Owner: Sonnet 5.5.

## Behaviour

| Endpoint | Notes |
|---|---|
| `POST /v1/uploads` | Role `creator` (403 otherwise). `part_size = max(16 MiB, ceil(size/10000))` rounded up to a whole MiB. One transaction: owner quota check (see Quotas), the `media.videos` row (`UPLOADING`, `raw_key = {owner_id}/{video_id}/source`), the S3 multipart upload, `s3_upload_id` stored, commit. A refused request never reaches S3. If the commit fails the multipart upload is aborted; if S3 fails nothing is written. Over quota: `429 UPLOAD_QUOTA_EXCEEDED`. |
| `POST /v1/uploads/{id}/parts` | Presigns `UploadPart` URLs (TTL 1 h) with the **public** S3 client. Owner + `UPLOADING` required (409 otherwise). |
| `POST /v1/uploads/{id}/complete` | Part list must be exactly `1..part_count`. Completes the multipart upload, `HeadObject`s and compares with `size_bytes` (mismatch → `FAILED`, 400 `SIZE_MISMATCH`, object deleted). Then **one transaction**: conditional `UPLOADING→UPLOADED`, clear `s3_upload_id`, enqueue `video.uploaded`. Repeating the call on `UPLOADED/PROCESSING/READY` returns 202 with the current status. |
| `GET /v1/uploads/{id}` | Status + progress of the latest `transcode_jobs` row (100 when `READY`); `error` is always present (`null` if none). |
| `DELETE /v1/uploads/{id}` | 409 unless `UPLOADING`; aborts the multipart upload and deletes the row. |

Non-owners, unknown ids and malformed ids all get **404**, never 403. Identity comes only from `X-User-Id` / `X-User-Roles`.

**Janitor**: every `JANITOR_INTERVAL`, uploads `UPLOADING` for longer than `UPLOAD_STALE_AFTER` are aborted on S3 and their rows deleted (uses index `media.videos_stale_uploads`).

**Two S3 endpoints** (shared client `libs/go/s3x`): `S3_ENDPOINT` (internal) for server-side calls; `S3_PUBLIC_ENDPOINT` (e.g. `https://s3.winkey.vn`) only for presigning, because the signature is bound to the host. Both are path-style with `S3_REGION=garage`. SDK request checksums are disabled (`WhenRequired`) so presigned URLs carry no checksum headers a browser would not send.

## Quotas (UQ1, ADR-027)

`POST /v1/uploads` refuses a caller who is over one of three limits (checked in this order), unless their `X-User-Roles` contains `admin`:

| limit (`detail` and metric label) | refused when | `Retry-After` |
|---|---|---|
| `concurrent` | the owner already has `UPLOAD_MAX_CONCURRENT` rows in `UPLOADING`, **whatever their age** | 60 |
| `daily_count` | the owner created `UPLOAD_DAILY_COUNT` rows in the last 24 h | `ceil(oldest counted created_at + 24 h - now)` s, at least 1 |
| `daily_bytes` | their `size_bytes` in the last 24 h **plus the new upload's** would exceed `UPLOAD_DAILY_BYTES` (exactly at the limit is allowed) | as `daily_count` |

`daily_count` and `daily_bytes` are computed from the append-only **upload ledger** `media.upload_ledger` (migration 000017), not from `media.videos`. `createUpload` writes one ledger row (`video_id`, `owner_id`, `size_bytes`, `created_at`) in the same transaction as the video row, after the quota check, for every caller including admins. A refused request (429) or an S3 failure writes no ledger row. The ledger has no foreign key to `media.videos`, so a video that is aborted (`DELETE /v1/uploads/{id}`), deleted by video-svc or removed by the janitor still counts in the 24 h window: "upload, delete, upload again" does not give the quota back. Aborted uploads count on purpose. `concurrent` still reads `media.videos` (`status = 'UPLOADING'`, any age), because an upload that no longer exists occupies no slot.

**Retention.** A database trigger makes the ledger append-only (no `UPDATE`) and refuses to delete rows younger than 25 h. On every sweep the janitor deletes ledger rows older than 48 h, in statements of at most 1000 rows (`ctid` batches) until none are left, and logs the count.

The answer is `429`, `application/problem+json`, `code = UPLOAD_QUOTA_EXCEEDED`, `detail` such as `upload quota exceeded: concurrent limit is 3 uploads in progress`, and `Retry-After`. Each refusal increments `upload_quota_rejections_total{limit}` and logs at info `owner_id` and `limit` (no title, no filename).

**How it is enforced.** In one transaction the handler (1) takes `pg_advisory_xact_lock(hashtextextended('upload-quota:' || owner_id, 0))`, (2) runs ONE query (one round trip): count, sum of `size_bytes` and oldest `created_at` of the owner's ledger rows in the 24 h window (index `upload_ledger_owner_created`), and the owner's `UPLOADING` count in `media.videos`, (3) decides, (4) inserts the video row without `s3_upload_id` and the ledger row, (5) calls S3 `CreateMultipartUpload`, (6) stores the id and commits. Consequences:

- a refused request never calls S3, so it leaves no multipart upload and no row;
- two requests of one owner serialise on the lock until the first has committed, so 10 simultaneous requests with a limit of 3 create exactly 3 rows (other owners are not blocked);
- the lock and the transaction are held across one S3 `CreateMultipartUpload` call (a few ms); if S3 fails the transaction rolls back (nothing written), and if the commit fails the multipart upload is aborted;
- no other request can see a row without `s3_upload_id`, so the old guarantee (an `UPLOADING` row always has its upload id) holds.

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
| `UPLOAD_MAX_CONCURRENT` | `3` | most videos in status `UPLOADING` per owner, 1..50 |
| `UPLOAD_DAILY_COUNT` | `20` | most uploads started per owner in 24 h, 1..10000 |
| `UPLOAD_DAILY_BYTES` | `53687091200` (50 GiB) | most `size_bytes` started per owner in 24 h, at least 20 GiB so one maximum-size file always fits |
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

If the process dies between `CreateMultipartUpload` and the commit, the multipart upload is orphaned in Garage (the row rolls back, so there is nothing for the janitor to find). Configure a bucket lifecycle rule to abort incomplete multipart uploads if this matters.
