import crypto from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { attachmentObjectKey, type AttachmentStorage } from '../storage/attachment-storage.js';
import { UNLINKED_ATTACHMENT_TTL_MS } from '../utils/attachments.js';

export interface AttachmentsJanitorOptions {
  pool: pg.Pool;
  storage: AttachmentStorage;
  valkey?: Redis | null;
  intervalMs?: number;
  batchSize?: number;
  logger?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

/**
 * SOC-3b: deletes expired attachments and attachments no message references 24 h after they were reserved,
 * objects first (DeleteObjects, ≤ 1 000 keys per call) and then the rows whose object is gone. A row whose
 * object could not be deleted stays for the next run. Same pattern as the to-device purge: periodic, one replica
 * at a time through a Valkey lock. The bucket lifecycle rule (30 days) is the backstop.
 */
export class AttachmentsJanitor {
  private readonly pool: pg.Pool;
  private readonly storage: AttachmentStorage;
  private readonly valkey: Redis | null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger: NonNullable<AttachmentsJanitorOptions['logger']>;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AttachmentsJanitorOptions) {
    this.pool = options.pool;
    this.storage = options.storage;
    this.valkey = options.valkey ?? null;
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.batchSize = options.batchSize ?? 1000;
    this.logger = options.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error({ err }, 'Unexpected error in attachments janitor');
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the number of attachments deleted. `now` is for tests. */
  async runOnce(now: Date = new Date()): Promise<number> {
    const lockKey = 'lock:chat:attachments_janitor';
    const lockToken = crypto.randomUUID();
    let acquired = false;
    if (this.valkey && this.valkey.status === 'ready') {
      try {
        if ((await this.valkey.set(lockKey, lockToken, 'PX', 600_000, 'NX')) !== 'OK') {
          this.logger.info({}, 'Attachments janitor: another replica holds the lock, skipping run');
          return 0;
        }
        acquired = true;
      } catch (err) {
        this.logger.warn(
          { err },
          'Attachments janitor: could not take the Valkey lock, skipping run',
        );
        return 0;
      }
    }

    try {
      let total = 0;
      let failedTotal = 0;
      const seen = new Set<string>();
      for (;;) {
        const res = await this.pool.query<{ id: string; conversation_id: string }>(
          `SELECT id, conversation_id FROM chat.attachments
           WHERE (expires_at <= $1 OR (message_seq IS NULL AND created_at <= $2))
             AND NOT (id = ANY($3::uuid[]))
           ORDER BY created_at
           LIMIT $4`,
          [now, new Date(now.getTime() - UNLINKED_ATTACHMENT_TTL_MS), [...seen], this.batchSize],
        );
        if (res.rows.length === 0) break;

        const keyToId = new Map(
          res.rows.map((r) => [attachmentObjectKey(r.conversation_id, r.id), r.id] as const),
        );
        const failed = new Set(await this.storage.deleteObjects([...keyToId.keys()]));
        const deletedIds: string[] = [];
        for (const [key, id] of keyToId) {
          seen.add(id);
          if (!failed.has(key)) deletedIds.push(id);
        }
        if (deletedIds.length > 0) {
          const del = await this.pool.query(
            'DELETE FROM chat.attachments WHERE id = ANY($1::uuid[])',
            [deletedIds],
          );
          total += del.rowCount ?? 0;
        }
        failedTotal += failed.size;
        if (res.rows.length < this.batchSize) break;
      }

      if (total > 0 || failedTotal > 0) {
        this.logger.info({ deleted: total, failed: failedTotal }, 'Attachments janitor run');
      }
      return total;
    } finally {
      if (acquired && this.valkey) {
        const releaseLua = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else return 0 end
        `;
        await this.valkey.eval(releaseLua, 1, lockKey, lockToken).catch(() => {});
      }
    }
  }
}
