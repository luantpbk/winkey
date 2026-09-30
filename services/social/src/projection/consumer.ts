import type { NatsConnection, JsMsg } from 'nats';
import { AckPolicy } from 'nats';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { isValidUuid } from '../utils/auth.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export class VideoProjectionConsumer {
  private readonly db: Kysely<Database>;
  private readonly nats: NatsConnection;
  private readonly logger: Logger;
  private running = false;
  private messagesIter: { stop(): void } | null = null;

  constructor(options: { db: Kysely<Database>; natsConnection: NatsConnection; logger?: Logger }) {
    this.db = options.db;
    this.nats = options.natsConnection;
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;

    try {
      const jsm = await this.nats.jetstreamManager();
      const js = this.nats.jetstream();

      // Ensure durable consumer "social-videos" exists on stream "VIDEO"
      try {
        await jsm.consumers.add('VIDEO', {
          durable_name: 'social-videos',
          ack_policy: AckPolicy.Explicit,
          ack_wait: 30 * 1_000_000_000, // 30s in nanoseconds
          max_deliver: 5,
          filter_subjects: ['video.ready', 'video.deleted', 'video.moderated'],
        });
      } catch {
        try {
          await jsm.consumers.update('VIDEO', 'social-videos', {
            ack_wait: 30 * 1_000_000_000,
            max_deliver: 5,
            filter_subjects: ['video.ready', 'video.deleted', 'video.moderated'],
          });
        } catch (err) {
          this.logger.warn(
            { err },
            'Could not add/update consumer social-videos; attempting to bind existing',
          );
        }
      }

      const consumer = await js.consumers.get('VIDEO', 'social-videos');
      const messages = await consumer.consume();
      this.messagesIter = messages;
      this.running = true;

      this.logger.info({}, 'social-videos projection consumer started');

      (async () => {
        try {
          for await (const m of messages) {
            if (!this.running) break;
            await this.processMessage(m);
          }
        } catch (err) {
          if (this.running) {
            this.logger.error({ err }, 'Unexpected error in social-videos consumption loop');
            this.running = false;
          }
        }
      })();

      return true;
    } catch (err) {
      this.running = false;
      this.logger.warn({ err }, 'Failed to start social-videos projection consumer; will retry');
      return false;
    }
  }

  async processMessage(m: JsMsg): Promise<void> {
    try {
      let raw = '';
      let event: Record<string, unknown>;

      try {
        raw = m.data ? new TextDecoder().decode(m.data) : '{}';
        event = JSON.parse(raw);
      } catch (parseErr) {
        this.logger.error(
          { err: parseErr, subject: m.subject },
          'Poison message: malformed JSON in social-videos projection; terminating message',
        );
        m.term();
        return;
      }

      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        this.logger.error(
          { event, subject: m.subject },
          'Poison message: invalid payload structure; terminating message',
        );
        m.term();
        return;
      }

      if (event.version !== 1) {
        this.logger.warn(
          { type: event.type, version: event.version },
          'Unsupported event version; acknowledging',
        );
        m.ack();
        return;
      }

      if (event.type === 'video.ready') {
        const data = event.data as Record<string, unknown> | undefined;
        const videoId = data?.video_id;
        const ownerId = data?.owner_id;

        if (
          typeof videoId !== 'string' ||
          !isValidUuid(videoId) ||
          typeof ownerId !== 'string' ||
          !isValidUuid(ownerId)
        ) {
          this.logger.error(
            { event, subject: m.subject },
            'Poison message: missing fields or invalid UUIDs in video.ready event; terminating message',
          );
          m.term();
          return;
        }

        try {
          await this.db
            .insertInto('social.videos')
            .values({ id: videoId, owner_id: ownerId })
            .onConflict((oc) => oc.column('id').doNothing())
            .execute();
          m.ack();
        } catch (dbErr) {
          this.logger.error(
            { err: dbErr, subject: m.subject },
            'Database error in video.ready projection; naking message for retry',
          );
          m.nak(5000);
        }
        return;
      }

      if (event.type === 'video.deleted') {
        const data = event.data as Record<string, unknown> | undefined;
        const videoId = data?.video_id;

        if (typeof videoId !== 'string' || !isValidUuid(videoId)) {
          this.logger.error(
            { event, subject: m.subject },
            'Poison message: missing or invalid video_id in video.deleted event; terminating message',
          );
          m.term();
          return;
        }

        try {
          await this.db.deleteFrom('social.videos').where('id', '=', videoId).execute();
          m.ack();
        } catch (dbErr) {
          this.logger.error(
            { err: dbErr, subject: m.subject },
            'Database error in video.deleted projection; naking message for retry',
          );
          m.nak(5000);
        }
        return;
      }

      if (event.type === 'video.moderated') {
        const data = event.data as Record<string, unknown> | undefined;
        const videoId = data?.video_id;
        const state = data?.state;

        if (
          typeof videoId !== 'string' ||
          !isValidUuid(videoId) ||
          (state !== 'VISIBLE' && state !== 'HIDDEN')
        ) {
          this.logger.error(
            { event, subject: m.subject },
            'Poison message: invalid payload in video.moderated event; terminating message',
          );
          m.term();
          return;
        }

        try {
          const isHidden = state === 'HIDDEN';
          await this.db
            .updateTable('social.videos')
            .set({ hidden: isHidden })
            .where('id', '=', videoId)
            .execute();
          m.ack();
        } catch (dbErr) {
          this.logger.error(
            { err: dbErr, subject: m.subject },
            'Database error in video.moderated projection; naking message for retry',
          );
          m.nak(5000);
        }
        return;
      }

      this.logger.warn(
        { type: event.type },
        'Unhandled event type on social-videos consumer; acknowledging',
      );
      m.ack();
    } catch (err) {
      this.logger.error(
        { err, subject: m.subject },
        'Unexpected error processing message in social-videos projection; naking for retry',
      );
      try {
        m.nak(5000);
      } catch {
        // Ignore nak error if connection dropped
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.messagesIter) {
      try {
        this.messagesIter.stop();
      } catch {
        // Ignore stop error
      }
      this.messagesIter = null;
    }
    this.logger.info({}, 'social-videos projection consumer stopped');
  }
}
