# analytics-worker (R1, ADR-022)

Moves `analytics.playback` v1 events from the JetStream stream `ANALYTICS` into ClickHouse
(`winkey.playback_events`; the materialized view fills `winkey.video_qoe_hourly`). video-svc is the producer
(`POST /v1/playback/heartbeats`); this worker is the only consumer. It runs next to ClickHouse on gpu-01.

## How it keeps the numbers exact

* Durable pull consumer `analytics-clickhouse`: `max_deliver=-1`, `max_ack_pending=20000`, `ack_wait=60s`, explicit acks.
* A batch is up to `BATCH_MAX_MESSAGES` (5000) messages or `BATCH_MAX_WAIT` (2 s), inserted with ONE `INSERT` and
  `SETTINGS insert_deduplication_token='<first stream seq>-<last stream seq>', deduplicate_blocks_in_dependent_materialized_views=1`.
  The setting is required: without it a retried block is dropped from the raw table but counted again by the hourly view.
* Messages are acknowledged only after the INSERT succeeded. When ClickHouse is down the worker retries the **same batch
  with the same token** (with back-off, telling JetStream it is still working via `InProgress`), so a block that was
  written but not confirmed is recognised and not counted twice. (A token identifies a block only when the same messages
  form the same block, which is why the batch is retried in-process and not Nak'ed and re-fetched.)
* Duplicates of one `event_id` inside a batch are dropped before the INSERT (the hourly view would sum them).
* A malformed or schema-invalid message is `Term`'d (counted in `analytics_messages_total{result="malformed"}`), never retried.
* Migrations: `db/clickhouse/*.sql` from `CLICKHOUSE_MIGRATIONS_DIR` (mounted at `/migrations`) are applied in name order
  at start-up and recorded in `winkey.schema_migrations`. A failing statement stops the start.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NATS_URL` | required | NATS server |
| `CLICKHOUSE_ADDR` | `localhost:9000` | native protocol address |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | credentials |
| `CLICKHOUSE_MIGRATIONS_DIR` | `/migrations` | directory with the `.sql` files |
| `BATCH_MAX_MESSAGES` | `5000` | 1..20000 |
| `BATCH_MAX_WAIT` | `2s` | at least 100 ms |
| `HTTP_ADDR` | `:8081` | `/healthz`, `/readyz`, `/metrics` |
| `LOG_LEVEL` | `info` | |

## Run and test

The module is built standalone (the Dockerfile does the same):

```bash
cd services/analytics
GOWORK=off go build ./...
GOWORK=off go test -race ./...                           # unit tests, no Docker
WINKEY_REQUIRE_DOCKER=1 GOWORK=off go test ./internal/integration/   # real NATS + ClickHouse (containers)
```

The integration tests cover: migrations applied once; 10,000 events give exactly 10,000 rows and exact hourly sums;
ClickHouse unreachable mid-run (TCP proxy) and a worker restart lose nothing and double-count nothing; malformed
messages are terminated; a duplicate `event_id` counts once; the durable matches the contract; the worker waits for a
missing stream. `WINKEY_CLICKHOUSE_IMAGE` overrides the ClickHouse image.
