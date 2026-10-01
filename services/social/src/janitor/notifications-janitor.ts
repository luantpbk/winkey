import type pg from 'pg';
import { notificationsJanitorDeletedCounter } from '../metrics.js';

export const NOTIFICATIONS_JANITOR_LOCK_KEY = 821390;

export interface NotificationsJanitorOptions {
  pool: pg.Pool;
  retentionDays?: number;
  intervalMs?: number;
  logger?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

export class NotificationsJanitor {
  private readonly pool: pg.Pool;
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly logger: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: NotificationsJanitorOptions) {
    this.pool = options.pool;
    this.retentionDays = options.retentionDays ?? 90;
    this.intervalMs = options.intervalMs ?? 10 * 60 * 1000;
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
        this.logger.error({ err }, 'Unexpected error in notifications janitor run');
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
    const client = await this.pool.connect();
    try {
      const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [
        NOTIFICATIONS_JANITOR_LOCK_KEY,
      ]);
      const locked = lockRes.rows[0]?.locked === true;
      if (!locked) {
        this.logger.info({}, 'Notifications janitor: another replica holds the lock, skipping run');
        return 0;
      }

      let totalDeleted = 0;
      try {
        let deletedBatch = 0;
        do {
          const res = await client.query(
            `DELETE FROM social.notifications
             WHERE id IN (
               SELECT id FROM social.notifications
               WHERE created_at < now() - ($1 || ' days')::interval
               LIMIT 5000
             )`,
            [this.retentionDays],
          );
          deletedBatch = res.rowCount ?? 0;
          totalDeleted += deletedBatch;
          if (deletedBatch > 0) {
            notificationsJanitorDeletedCounter.inc(deletedBatch);
          }
        } while (deletedBatch >= 5000);

        if (totalDeleted > 0) {
          this.logger.info({ totalDeleted }, 'Notifications janitor: purged expired notifications');
        }
        return totalDeleted;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [NOTIFICATIONS_JANITOR_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
