# @winkey/outbox

Transactional outbox implementation for TypeScript services on Winkey (ADR-008).

## Overview

This package guarantees at-least-once message delivery between PostgreSQL and NATS JetStream by persisting domain events in an `<schema>.outbox` table within the same transaction as business data mutations. An outbox relay worker polls pending events and publishes them to NATS JetStream with duplicate-detection headers.

- **Envelope:** Follows `contracts/events/envelope.schema.json`.
- **Event IDs:** UUIDv7 generated per event.
- **De-duplication:** Publishes with header `Nats-Msg-Id: <event_id>` (JetStream de-duplication window: 2 minutes).
- **Relay:** Polling worker with `FOR UPDATE SKIP LOCKED` in batches of 100.
- **Retention:** Automatically deletes published events older than 7 days.

## Installation

```bash
pnpm add @winkey/outbox
```

## Database Table

Each service schema must declare its outbox table (e.g. from `db/migrations/000002_auth.up.sql`):

```sql
CREATE TABLE <schema>.outbox (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id     uuid NOT NULL UNIQUE,
    subject      text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX <schema>_outbox_pending ON <schema>.outbox (id) WHERE published_at IS NULL;
```

## Usage

### 1. Enqueue Event in a Transaction

```typescript
import { enqueue } from '@winkey/outbox';

await db.transaction().execute(async (trx) => {
  // 1. Business operation
  await trx.insertInto('auth.users').values(newUser).execute();

  // 2. Enqueue domain event within the exact same transaction
  await enqueue(trx, 'auth', 'user.registered', {
    user_id: newUser.id,
    handle: newUser.handle,
    method: 'password',
  }, {
    producer: 'auth-svc',
  });
});
```

### 2. Start the Outbox Relay

```typescript
import { OutboxRelay } from '@winkey/outbox';
import { connect } from 'nats';
import { db } from './db.js';

const nc = await connect({ servers: process.env.NATS_URL });

const relay = new OutboxRelay({
  db,
  natsConnection: nc,
  schema: 'auth',
  batchSize: 100,
  pollIntervalMs: 500,
  cleanupMaxAgeDays: 7,
  logger: fastify.log,
});

relay.start();

// On shutdown
await relay.stop();
```

## Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `db` | `Kysely` or `pg.Pool` | (required) | Database connection pool or Kysely instance |
| `natsConnection` | `NatsConnection` | (required) | Connected NATS client with JetStream support |
| `schema` | `string` | (required) | Database schema owning the `.outbox` table |
| `batchSize` | `number` | `100` | Number of events polled per batch (`FOR UPDATE SKIP LOCKED`) |
| `pollIntervalMs` | `number` | `500` | Delay between polls when queue is idle |
| `cleanupMaxAgeDays` | `number` | `7` | Retention period for published events |
| `cleanupIntervalMs` | `number` | `3600000` (1h) | Interval for purging expired published events |
| `logger` | `Logger` | `console` | Logger instance (`info`, `warn`, `error`, `debug`) |

## Running Tests

```bash
pnpm --dir packages/outbox test
pnpm --dir packages/outbox typecheck
```
