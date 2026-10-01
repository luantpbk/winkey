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
| `CLICKHOUSE_INSERT_TIMEOUT` | `30s` | deadline of ONE INSERT attempt, 1s..30s (below half of ack_wait) |
| `ROLLUP_ENABLED` | `true` | run the daily rollup into PostgreSQL (below) |
| `POSTGRES_URL` | required when the rollup is enabled | PostgreSQL (role `analytics_svc`: CRUD on schema `analytics`), pool of at most 4 |
| `ROLLUP_INTERVAL` | `10m` | between runs, 1m..1h |
| `ROLLUP_WINDOW_DAYS` | `3` | days recomputed per run (today included), 1..8 |
| `ROLLUP_BACKFILL_DAYS` | `8` | window of the first successful run after start-up, 1..30 |
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

## Daily rollup for creator statistics (R1-b)

video-svc must not read ClickHouse (it listens on loopback on gpu-01 and gpu-01 is often off), so this worker copies
`winkey.video_qoe_hourly` into `analytics.video_daily` in PostgreSQL (migration 000015); the studio statistics endpoints
read only that table.

* Every `ROLLUP_INTERVAL` ONE ClickHouse query reads the last `ROLLUP_WINDOW_DAYS` days (the first run after start-up
  `ROLLUP_BACKFILL_DAYS`) with the `-Merge` combinators (no `FINAL`): sums, `uniqMerge(viewers)`, `quantilesMerge(0.5, 0.95)`.
  Days are calendar days in **Asia/Ho_Chi_Minh** (UTC+7, no DST): 16:59:59Z and 17:00:00Z are on different days.
* ClickHouse returns `nan` for the percentiles of a day without a start that has a startup time: that is stored as NULL.
  Percentiles are rounded to integers.
* The rows are upserted in batches of at most 1000 (`INSERT ... SELECT FROM unnest(...) ON CONFLICT (video_id, day) DO UPDATE`),
  all in one transaction per run, and `refreshed_at` is set only on rows whose values changed
  (`WHERE (...) IS DISTINCT FROM (EXCLUDED...)`), so it means "last change". Running the rollup again changes nothing.
* The first run of each Asia/Ho_Chi_Minh day also deletes rows older than 730 days.
* Runs never overlap (one goroutine). A failed run is logged, counted (`analytics_rollup_errors_total`) and retried at the next tick;
  it never fails `/readyz` and never stops ingestion. Other metrics: `analytics_rollup_last_success_timestamp_seconds`,
  `analytics_rollup_duration_seconds`, `analytics_rollup_rows_upserted_total`.
* Like the ClickHouse side, this inherits the known double-count risk of ADR-022 (a crash between INSERT and ack).
