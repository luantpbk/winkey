import crypto from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';

export interface ToDevicePurgeJobOptions {
  pool: pg.Pool;
  valkey?: Redis | null;
  retentionDays?: number;
  intervalMs?: number;
  batchSize?: number;
  logger?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

export class ToDevicePurgeJob {
  private readonly pool: pg.Pool;
  private readonly valkey: Redis | null;
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: ToDevicePurgeJobOptions) {
    this.pool = options.pool;
    this.valkey = options.valkey ?? null;
    this.retentionDays = options.retentionDays ?? 30;
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000; // 1 hour
    this.batchSize = options.batchSize ?? 5000;
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error({ err }, 'Unexpected error in to-device purge job');
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<number> {
    const lockKey = 'lock:chat:purge_to_device';
    const lockToken = crypto.randomUUID();
    let acquired = false;

    if (this.valkey && this.valkey.status === 'ready') {
      try {
        const res = await this.valkey.set(lockKey, lockToken, 'PX', 600_000, 'NX');
        if (res !== 'OK') {
          this.logger.info({}, 'To-device purge job: another replica holds the lock, skipping run');
          return 0;
        }
        acquired = true;
      } catch (err) {
        this.logger.warn({ err }, 'Failed to acquire Valkey lock for purge job, skipping run');
        return 0;
      }
    }

    try {
      let totalDeleted = 0;
      const client = await this.pool.connect();
      try {
        let deletedBatch = 0;
        do {
          const res = await client.query(
            `DELETE FROM chat.to_device
             WHERE id IN (
               SELECT id FROM chat.to_device
               WHERE created_at < now() - ($1 || ' days')::interval
               LIMIT $2
             )`,
            [this.retentionDays, this.batchSize],
          );
          deletedBatch = res.rowCount ?? 0;
          totalDeleted += deletedBatch;
        } while (deletedBatch >= this.batchSize);

        if (totalDeleted > 0) {
          this.logger.info({ totalDeleted }, 'To-device purge job: purged expired messages');
        }
        return totalDeleted;
      } finally {
        client.release();
      }
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

export async function runToDevicePurgeIteration(
  pool: pg.Pool,
  retentionDays = 30,
  batchSize = 5000,
): Promise<number> {
  const job = new ToDevicePurgeJob({ pool, retentionDays, batchSize });
  return job.runOnce();
}
