<!-- Handoff Report for review (PR description). Delete this file once the PR is opened. -->
## Task
[LIB] agent/sonnet/lib-go-foundation

## What was built
`libs/go` (module `github.com/luantpbk/winkey/libs/go`): `config`, `ids`, `obs`, `httpx`, `outbox`, `testkit`, README and `.golangci.yml`. See `libs/go/README.md`.

## Key decisions & deviations from contracts/ADRs
- No contract deviations. The envelope is unit-tested against `envelope.schema.json` + `video.uploaded.schema.json`.
- `outbox.Enqueue(ctx, tx, schema, subject, event)` takes the `data` payload only; the producer name comes from a one-time `outbox.SetProducer(...)` at startup.
- Enqueue also issues a transactional `pg_notify('outbox_<schema>')`; the relay LISTENs on a hijacked connection when `Listen` is set and always polls every 500 ms.
- Multiple relay replicas are safe (`SKIP LOCKED`) but ordering across replicas is best-effort; consumers must be idempotent.
- No root `go.work` (owned by Platform). Services use `replace ... => ../../libs/go`.
- Container tests skip when Docker is unavailable; `WINKEY_REQUIRE_DOCKER=1` makes them fail instead (use in CI).

## How to run & test
```bash
cd libs/go
go test ./...
WINKEY_REQUIRE_DOCKER=1 go test ./...   # CI
GOOS=linux GOARCH=arm64 go build ./... && GOOS=windows go build ./...
```

## Known limitations / risks
- **Verified on a real PostgreSQL 17.5** (embedded binaries + the real `db/migrations`, via a temporary uncommitted testkit patch, because the dev machine has no Docker): `Enqueue` (incl. rollback), `PublishBatch` partial-failure retry, LISTEN/NOTIFY wake-up, retention cleanup (`relay_test.go`, `outbox_test.go`).
- **Not run:** the testkit container paths themselves (Postgres/NATS/Garage containers) and the JetStream end-to-end relay test (`TestEnqueueRelayEndToEnd`) were skipped (no Docker). The Garage bootstrap (`garage` CLI syntax for v1.0.1, `PutBucketCors`) is the most likely place to need a fix on first real run. Please run with `WINKEY_REQUIRE_DOCKER=1` in CI.
- `go test -race` and `golangci-lint` were not run (no cgo / not installed).
- Verified: `go vet`, `gofmt`, unit tests, cross-builds for linux/arm64 and windows.

## Open questions for the architect
- Is a shared `libs/go` S3 client helper (two endpoints, path-style) wanted, or should each service build its own?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
