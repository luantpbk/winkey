<!-- Handoff Report for review (PR description). Delete this file once the PR is opened. -->
## Task
[V1] upload-svc. **Stacked on `agent/sonnet/lib-go-foundation` (PR 1)**; retarget to `main` after PR 1 merges.

## What was built
`services/upload`: implements `contracts/openapi/upload.v1.yaml` (create / presign parts / complete / get / abort), transactional `video.uploaded` outbox event + relay, stale-upload janitor, Dockerfile (distroless, amd64+arm64), README with env table, `.env.example`.

## Key decisions & deviations from contracts/ADRs
- No contract deviations. Codes used in problem responses: `VALIDATION_ERROR`, `UPLOAD_TOO_LARGE` (size only), `INVALID_JSON`, `INVALID_PART_NUMBER`, `INVALID_PARTS`, `SIZE_MISMATCH`, `INVALID_STATE` (409), `NOT_FOUND`.
- `CreateMultipartUpload` is called before the row insert (aborted if the insert fails), so no row ever exists without an upload id. Trade-off: a crash in between orphans a multipart upload (documented in README).
- Non-owner / unknown / malformed id → 404 everywhere. `GET` needs no `creator` role, only ownership.
- SDK request checksums are `WhenRequired`, so presigned URLs carry no checksum params (unit-tested: host = public endpoint, path-style, only `host` signed).
- `complete`: if S3 reports `NoSuchUpload` (concurrent complete), it proceeds to `HeadObject`; size mismatch → row `FAILED`, raw object deleted, 400 `SIZE_MISMATCH`.
- Status `progress`: latest job's progress for PROCESSING/FAILED, 100 for READY, 0 otherwise; `error` always serialized.

## How to run & test
```bash
cd services/upload
go test ./...
WINKEY_REQUIRE_DOCKER=1 go test ./...     # PostgreSQL 17 + NATS + Garage
GOOS=linux GOARCH=arm64 go build ./...
docker buildx build --platform linux/amd64,linux/arm64 -f services/upload/Dockerfile .   # from repo root
```

## Known limitations / risks
- **Verified on a real PostgreSQL 17.5** (embedded binaries + real migrations, temporary uncommitted testkit patch): `internal/store` (`store_test.go`): insert/get, conditional UPLOADING→UPLOADED with exactly one `video.uploaded` outbox row, lost-race no-op, MarkFailed, DeleteUploading, StaleUploads, latest-job progress.
- **Not run (no Docker on the dev machine):** `internal/integration` (full multipart flow with real presigned PUTs against Garage, JetStream delivery of `video.uploaded`, size mismatch, abort, janitor) and the Dockerfile build. They skip locally; CI must run them with `WINKEY_REQUIRE_DOCKER=1`.
- Not run: `golangci-lint` (not installed), `go test -race` (no cgo). `make dev`/compose not available yet (F3).
- Unit tests cover: part-size math, handlers via in-memory fakes (auth, validation, ownership 404s, presign bounds/TTL, part list validation, idempotent complete, size mismatch, abort, status), janitor, presign host/signing.
- The service imports `libs/go` via `replace ../../libs/go` (no root `go.work`).

## Open questions for the architect
- Should incomplete multipart uploads also be covered by a Garage bucket lifecycle rule (infra) as a backstop for the orphan case?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
