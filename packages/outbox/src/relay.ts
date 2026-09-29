import { headers as natsHeaders, StringCodec } from 'nats';
import { sql } from 'kysely';
import type { OutboxRelayOptions, OutboxRow, Logger } from './types.js';

const sc = StringCodec();
const VALID_IDENTIFIER = /^[a-zA-Z0-9_]+$/;

const defaultLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...(typeof obj === 'object' ? obj : { data: obj }) })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...(typeof obj === 'object' ? obj : { data: obj }) })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...(typeof obj === 'object' ? obj : { data: obj }) })),
  debug: (obj, msg) => console.debug(JSON.stringify({ level: 'debug', msg, ...(typeof obj === 'object' ? obj : { data: obj }) })),
};

export class OutboxRelay {
  private readonly db: any;
  private readonly natsConnection: any;
  private readonly schema: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly cleanupMaxAgeDays: number;
  private readonly cleanupIntervalMs: number;
  private readonly logger: Logger;

  private isRunning = false;
  private isProcessing = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: OutboxRelayOptions) {
    if (!VALID_IDENTIFIER.test(options.schema)) {
      throw new Error(`Invalid schema identifier: ${options.schema}`);
    }
    this.db = options.db;
    this.natsConnection = options.natsConnection;
    this.schema = options.schema;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.cleanupMaxAgeDays = options.cleanupMaxAgeDays ?? 7;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 3600000; // 1 hour
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Starts the polling relay and periodic cleanup task.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info({ schema: this.schema }, 'Outbox relay started');

    this.scheduleNextPoll(0);

    this.cleanupInterval = setInterval(() => {
      this.cleanupOldPublishedRows().catch((err) => {
        this.logger.error({ err }, 'Error cleaning up old outbox rows');
      });
    }, this.cleanupIntervalMs);
  }

  /**
   * Stops the relay gracefully, waiting for current batch processing to finish.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Wait until in-flight processing completes
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    this.logger.info({ schema: this.schema }, 'Outbox relay stopped');
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimeout = setTimeout(async () => {
      try {
        const processedCount = await this.processBatch();
        // If there were messages in this batch, poll immediately again; otherwise wait pollIntervalMs
        const nextDelay = processedCount >= this.batchSize ? 10 : this.pollIntervalMs;
        this.scheduleNextPoll(nextDelay);
      } catch (err) {
        this.logger.error({ err }, 'Error in outbox relay poll loop');
        this.scheduleNextPoll(this.pollIntervalMs * 2);
      }
    }, delayMs);
  }

  /**
   * Polls one batch of pending events with FOR UPDATE SKIP LOCKED,
   * publishes them to NATS JetStream, and marks them as published.
   *
   * @returns Number of events processed in this batch.
   */
  async processBatch(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      if (typeof this.db.transaction === 'function') {
        // Kysely transaction
        return await this.db.transaction().execute(async (trx: any) => {
          return await this.processBatchInternal(trx);
        });
      } else if (typeof this.db.connect === 'function') {
        // pg.Pool
        const client = await this.db.connect();
        try {
          await client.query('BEGIN');
          const count = await this.processBatchInternal(client);
          await client.query('COMMIT');
          return count;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } else if (typeof this.db.query === 'function') {
        // Direct client
        await this.db.query('BEGIN');
        try {
          const count = await this.processBatchInternal(this.db);
          await this.db.query('COMMIT');
          return count;
        } catch (err) {
          await this.db.query('ROLLBACK').catch(() => {});
          throw err;
        }
      } else {
        throw new Error('Unsupported database client for outbox relay');
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processBatchInternal(tx: any): Promise<number> {
    const rows = await this.fetchPendingRows(tx);
    if (!rows || rows.length === 0) {
      return 0;
    }

    const js = this.natsConnection.jetstream();
    const publishedIds: (string | number)[] = [];

    for (const row of rows) {
      try {
        const h = natsHeaders();
        h.append('Nats-Msg-Id', row.event_id);

        const payloadStr =
          typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);

        await js.publish(row.subject, sc.encode(payloadStr), { headers: h });
        publishedIds.push(row.id);
      } catch (pubErr) {
        this.logger.error(
          { event_id: row.event_id, subject: row.subject, err: pubErr },
          'Failed to publish outbox event to JetStream'
        );
        // Break out to let this message and remaining rows retry next time
        break;
      }
    }

    if (publishedIds.length > 0) {
      await this.markRowsPublished(tx, publishedIds);
      this.logger.debug?.(
        { count: publishedIds.length, schema: this.schema },
        'Published outbox batch'
      );
    }

    return publishedIds.length;
  }

  private async fetchPendingRows(tx: any): Promise<OutboxRow[]> {
    if (typeof tx.executeQuery === 'function' || typeof tx.getExecutor === 'function') {
      const result = await sql<OutboxRow>`
        SELECT id, event_id, subject, payload, created_at, published_at
        FROM ${sql.table(`${this.schema}.outbox`)}
        WHERE published_at IS NULL
        ORDER BY id ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `.execute(tx);
      return result.rows;
    } else {
      const query = `
        SELECT id, event_id, subject, payload, created_at, published_at
        FROM "${this.schema}"."outbox"
        WHERE published_at IS NULL
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `;
      const res = await tx.query(query, [this.batchSize]);
      return res.rows;
    }
  }

  private async markRowsPublished(tx: any, ids: (string | number)[]): Promise<void> {
    if (typeof tx.executeQuery === 'function' || typeof tx.getExecutor === 'function') {
      await sql`
        UPDATE ${sql.table(`${this.schema}.outbox`)}
        SET published_at = now()
        WHERE id IN (${sql.join(ids)})
      `.execute(tx);
    } else {
      const query = `
        UPDATE "${this.schema}"."outbox"
        SET published_at = now()
        WHERE id = ANY($1::bigint[])
      `;
      await tx.query(query, [ids]);
    }
  }

  /**
   * Deletes rows that were published more than `cleanupMaxAgeDays` ago (ADR-008: 7 days).
   */
  async cleanupOldPublishedRows(): Promise<number> {
    const days = Math.max(1, this.cleanupMaxAgeDays);
    if (typeof this.db.executeQuery === 'function' || typeof this.db.getExecutor === 'function') {
      const result = await sql`
        DELETE FROM ${sql.table(`${this.schema}.outbox`)}
        WHERE published_at IS NOT NULL
          AND published_at < now() - (${days} || ' days')::interval
      `.execute(this.db);
      return Number(result.numAffectedRows ?? 0);
    } else if (typeof this.db.query === 'function') {
      const query = `
        DELETE FROM "${this.schema}"."outbox"
        WHERE published_at IS NOT NULL
          AND published_at < now() - ($1 || ' days')::interval
      `;
      const res = await this.db.query(query, [days]);
      return res.rowCount ?? 0;
    }
    return 0;
  }
}
