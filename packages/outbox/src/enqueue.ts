import { sql, type QueryExecutorProvider } from 'kysely';
import { buildEnvelope } from './envelope.js';
import type { EventEnvelope, EnqueueOptions, PgClientLike } from './types.js';

const VALID_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/**
 * Enqueues a domain event into the transactional outbox table in the same transaction
 * as business changes (ADR-008).
 *
 * @param trx - Kysely Transaction, Kysely instance, or pg Client/Pool.
 * @param schema - The database schema owning the outbox table (e.g. 'auth').
 * @param subject - The NATS subject / event type (e.g. 'user.registered').
 * @param data - The event data payload.
 * @param options - Optional envelope overrides (producer, version, eventId, traceparent).
 */
export async function enqueue<T = Record<string, unknown>>(
  trx: QueryExecutorProvider | PgClientLike | unknown,
  schema: string,
  subject: string,
  data: T,
  options: EnqueueOptions = {},
): Promise<EventEnvelope<T>> {
  if (!VALID_SCHEMA.test(schema)) {
    throw new Error(`Invalid schema identifier: ${schema}`);
  }

  const envelope = buildEnvelope(subject, data, options);
  const payloadJson = JSON.stringify(envelope);

  // Kysely Transaction / QueryExecutor
  if (
    trx &&
    typeof trx === 'object' &&
    (typeof (trx as QueryExecutorProvider).getExecutor === 'function' ||
      typeof (trx as { executeQuery?: unknown }).executeQuery === 'function')
  ) {
    await sql`
      INSERT INTO ${sql.table(`${schema}.outbox`)} (event_id, subject, payload)
      VALUES (${envelope.event_id}, ${subject}, ${payloadJson}::jsonb)
    `.execute(trx as QueryExecutorProvider);
  } else if (trx && typeof trx === 'object' && typeof (trx as PgClientLike).query === 'function') {
    // Standard pg PoolClient / Pool
    const query = `INSERT INTO "${schema}"."outbox" (event_id, subject, payload) VALUES ($1, $2, $3::jsonb)`;
    await (trx as PgClientLike).query(query, [envelope.event_id, subject, payloadJson]);
  } else {
    throw new TypeError(
      'Transaction object must be a Kysely transaction or a pg Client/Pool with a query method',
    );
  }

  return envelope;
}
