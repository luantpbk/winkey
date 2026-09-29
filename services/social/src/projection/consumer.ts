import type { NatsConnection, JsMsg } from 'nats';
import { AckPolicy } from 'nats';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

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
          filter_subjects: ['video.ready', 'video.deleted'],
        });
      } catch (err) {
        this.logger.warn(
          { err },
          'Could not add/update consumer social-videos; attempting to bind existing',
        );
      }

      const consumer = await js.consumers.get('VIDEO', 'social-videos');
      const messages = await consumer.consume();
      this.messagesIter = messages;

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
          }
        }
      })();
    } catch (err) {
      this.logger.error({ err }, 'Failed to start social-videos projection consumer');
    }
  }

  async processMessage(m: JsMsg): Promise<void> {
    try {
      const raw = m.data ? new TextDecoder().decode(m.data) : '{}';
      const event = JSON.parse(raw);

      if (event.version !== 1) {
        this.logger.warn(
          { type: event.type, version: event.version },
          'Unknown event version; acknowledging',
        );
        m.ack();
        return;
      }

      if (event.type === 'video.ready') {
        const videoId = event.data?.video_id;
        const ownerId = event.data?.owner_id;
        if (videoId && ownerId) {
          await this.db
            .insertInto('social.videos')
            .values({ id: videoId, owner_id: ownerId })
            .onConflict((oc) => oc.column('id').doNothing())
            .execute();
        }
        m.ack();
        return;
      }

      if (event.type === 'video.deleted') {
        const videoId = event.data?.video_id;
        if (videoId) {
          await this.db.deleteFrom('social.videos').where('id', '=', videoId).execute();
        }
        m.ack();
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
        'Error processing message in social-videos projection',
      );
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
