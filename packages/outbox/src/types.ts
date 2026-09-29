/**
 * EventEnvelope represents the standard envelope defined in
 * contracts/events/envelope.schema.json.
 */
export interface EventEnvelope<T = Record<string, unknown>> {
  /** UUIDv7 identifier for the event. */
  event_id: string;
  /** Subject/type of the event, e.g. 'user.registered'. */
  type: string;
  /** Schema version of `data`. Default 1. */
  version: number;
  /** ISO 8601 / RFC 3339 UTC timestamp. */
  occurred_at: string;
  /** Service identifier that produced the event, e.g. 'auth-svc'. */
  producer: string;
  /** Optional W3C trace context for OpenTelemetry propagation. */
  traceparent?: string;
  /** Event payload conforming to the event's specific schema. */
  data: T;
}

export interface EnqueueOptions {
  /** Producer name. Defaults to process.env.SERVICE_NAME or 'unknown-svc'. */
  producer?: string;
  /** Event version. Defaults to 1. */
  version?: number;
  /** Explicit event_id (UUIDv7). If not provided, a UUIDv7 will be generated. */
  eventId?: string;
  /** Explicit W3C traceparent. If not provided, extracted from active OpenTelemetry context if available. */
  traceparent?: string;
}

import type { NatsConnection } from 'nats';
import type { QueryExecutorProvider } from 'kysely';

export interface OutboxRow<T = unknown> {
  id: string | number;
  event_id: string;
  subject: string;
  payload: EventEnvelope<T> | string;
  created_at: Date | string;
  published_at: Date | string | null;
}

export interface SqlExecutor {
  executeQuery<R>(query: { sql: string; parameters: readonly unknown[] }): Promise<{ rows: R[] }>;
}

export interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount?: number | null;
}

export interface PgClientLike {
  query<R = unknown>(queryText: string, values?: readonly unknown[]): Promise<PgQueryResult<R>>;
  release?: () => void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<R = unknown>(queryText: string, values?: readonly unknown[]): Promise<PgQueryResult<R>>;
}

export interface KyselyDatabaseLike extends QueryExecutorProvider {
  transaction(): {
    execute<T>(callback: (trx: QueryExecutorProvider) => Promise<T>): Promise<T>;
  };
}

export type OutboxDatabaseClient = unknown;

export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  debug?(obj: Record<string, unknown> | string, msg?: string): void;
}

export interface OutboxRelayOptions {
  /** Database connection pool, Kysely instance, or Client. */
  db: OutboxDatabaseClient;
  /** NATS connection with JetStream capability. */
  natsConnection: NatsConnection;
  /** Schema name where the outbox table is located (e.g. 'auth'). */
  schema: string;
  /** Batch size per poll. Defaults to 100 per ADR-008. */
  batchSize?: number;
  /** Poll interval in milliseconds. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** Clean up published events older than N days. Defaults to 7 days per ADR-008. */
  cleanupMaxAgeDays?: number;
  /** Cleanup interval in milliseconds. Defaults to 1 hour. */
  cleanupIntervalMs?: number;
  /** Optional custom logger (compatible with Pino / console). */
  logger?: Logger;
}
