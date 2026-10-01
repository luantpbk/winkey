import { sql, type Kysely } from 'kysely';
import type { Database, MailTemplate, MailLocale } from '../db/types.js';
import type { MailSender, MailerLogger } from './mailer.js';
import { renderEmail } from './templates.js';
import {
  authMailSentCounter,
  authMailFailedCounter,
  authMailDeadCounter,
  authMailQueuePendingGauge,
} from './metrics.js';

export interface MailQueueWorkerOptions {
  db: Kysely<Database>;
  mailer: MailSender;
  logger?: MailerLogger;
  batchSize?: number;
  pollIntervalMs?: number;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const withoutEmails = raw.replace(EMAIL_REGEX, '[REDACTED]');
  return withoutEmails.slice(0, 500);
}

export class MailQueueWorker {
  private readonly db: Kysely<Database>;
  private readonly mailer: MailSender;
  private readonly logger?: MailerLogger;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private isRunning = false;
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCleanupAt = 0;

  constructor(options: MailQueueWorkerOptions) {
    this.db = options.db;
    this.mailer = options.mailer;
    this.logger = options.logger;
    this.batchSize = options.batchSize ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.processBatchOnce();
      } catch (err) {
        this.logger?.error({ err }, 'Error in mail queue worker poll');
      } finally {
        this.scheduleNext();
      }
    }, this.pollIntervalMs);
  }

  /**
   * Processes up to batchSize pending rows.
   * Exposed publicly so unit and integration tests can trigger processing deterministically.
   */
  async processBatchOnce(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const now = new Date();

      let processedCount = 0;

      await this.db.transaction().execute(async (trx) => {
        const queryRes = await sql<{
          id: string;
          user_id: string | null;
          to_email: string;
          template: MailTemplate;
          locale: MailLocale;
          params: Record<string, unknown> | null;
          attempts: number;
        }>`
          SELECT id, user_id, to_email, template, locale, params, attempts
          FROM auth.mail_queue
          WHERE sent_at IS NULL AND dead_at IS NULL AND next_attempt_at <= ${now}
          ORDER BY next_attempt_at ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        `.execute(trx);

        const rows = queryRes.rows;
        if (!rows || rows.length === 0) {
          return;
        }

        processedCount = rows.length;

        for (const row of rows) {
          const queueId = String(row.id);
          const template = row.template;
          const locale = row.locale;
          const toEmail = row.to_email;
          const params = row.params;
          const currentAttempts = Number(row.attempts) || 0;

          try {
            const rendered = renderEmail(template, locale, params);
            await this.mailer.sendMail({
              queueId,
              toEmail,
              template,
              rendered,
            });

            // On success: sent_at = now(), params = NULL
            await trx
              .updateTable('auth.mail_queue')
              .set({
                sent_at: new Date(),
                params: null,
              })
              .where('id', '=', queueId)
              .execute();

            authMailSentCounter.inc({ template });
          } catch (err: unknown) {
            const newAttempts = currentAttempts + 1;
            const sanitizedErr = sanitizeErrorMessage(err);

            if (newAttempts >= 8) {
              // Dead after 8 attempts: dead_at = now(), params = NULL
              await trx
                .updateTable('auth.mail_queue')
                .set({
                  attempts: newAttempts,
                  dead_at: new Date(),
                  params: null,
                  last_error: sanitizedErr,
                })
                .where('id', '=', queueId)
                .execute();

              authMailDeadCounter.inc();
            } else {
              // Exponential backoff: 2^attempts minutes, capped at 60 minutes
              const backoffMinutes = Math.min(60, Math.pow(2, newAttempts));
              const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

              await trx
                .updateTable('auth.mail_queue')
                .set({
                  attempts: newAttempts,
                  next_attempt_at: nextAttemptAt,
                  last_error: sanitizedErr,
                })
                .where('id', '=', queueId)
                .execute();

              authMailFailedCounter.inc({ template });
            }

            this.logger?.warn(
              { queueId, template, attempts: newAttempts, err: sanitizedErr },
              'Failed delivering mail from queue',
            );
          }
        }
      });

      await this.updatePendingGauge();
      await this.maybeCleanupOldRows();
      return processedCount;
    } finally {
      this.isProcessing = false;
    }
  }

  private async updatePendingGauge(): Promise<void> {
    try {
      const res = await this.db
        .selectFrom('auth.mail_queue')
        .select(sql<number>`count(*)::int`.as('cnt'))
        .where('sent_at', 'is', null)
        .where('dead_at', 'is', null)
        .executeTakeFirst();

      const count = Number(res?.cnt ?? 0);
      authMailQueuePendingGauge.set(count);
    } catch {
      // Ignore metric update failures
    }
  }

  private async maybeCleanupOldRows(): Promise<void> {
    const now = Date.now();
    // Run cleanup at most once every hour
    if (now - this.lastCleanupAt < 60 * 60 * 1000) return;
    this.lastCleanupAt = now;

    try {
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      await this.db.deleteFrom('auth.mail_queue').where('created_at', '<', sevenDaysAgo).execute();
    } catch (err) {
      this.logger?.warn({ err }, 'Failed cleaning up old mail_queue rows');
    }
  }
}
