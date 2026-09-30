import type { NatsConnection, JsMsg } from 'nats';
import { AckPolicy } from 'nats';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, VideoVisibility } from '../db/types.js';
import { isValidUuid } from '../utils/auth.js';
import { notificationsCreatedCounter, notificationsFanoutDuration } from '../metrics.js';

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

      const filterSubjects = [
        'video.ready',
        'video.deleted',
        'video.moderated',
        'video.visibility_changed',
      ];

      // Ensure durable consumer "social-videos" exists on stream "VIDEO"
      try {
        await jsm.consumers.add('VIDEO', {
          durable_name: 'social-videos',
          ack_policy: AckPolicy.Explicit,
          ack_wait: 30 * 1_000_000_000, // 30s in nanoseconds
          max_deliver: 5,
          filter_subjects: filterSubjects,
        });
      } catch {
        try {
          await jsm.consumers.update('VIDEO', 'social-videos', {
            ack_wait: 30 * 1_000_000_000,
            max_deliver: 5,
            filter_subjects: filterSubjects,
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
        const rawVisibility = data?.visibility;

        if (
          typeof videoId !== 'string' ||
          !isValidUuid(videoId) ||
          typeof ownerId !== 'string' ||
          !isValidUuid(ownerId) ||
          (rawVisibility !== undefined &&
            rawVisibility !== 'PUBLIC' &&
            rawVisibility !== 'UNLISTED' &&
            rawVisibility !== 'PRIVATE')
        ) {
          this.logger.error(
            { event, subject: m.subject },
            'Poison message: missing fields or invalid UUIDs/visibility in video.ready event; terminating message',
          );
          m.term();
          return;
        }

        try {
          await this.db.transaction().execute(async (trx) => {
            const prev = await trx
              .selectFrom('social.videos')
              .select(['id', 'owner_id', 'hidden', 'visibility'])
              .where('id', '=', videoId)
              .forUpdate()
              .executeTakeFirst();

            const wasPublic = prev !== undefined && prev.visibility === 'PUBLIC' && !prev.hidden;

            const visibility: VideoVisibility =
              (rawVisibility as VideoVisibility) ?? prev?.visibility ?? 'PUBLIC';

            if (rawVisibility !== undefined) {
              await trx
                .insertInto('social.videos')
                .values({ id: videoId, owner_id: ownerId, visibility })
                .onConflict((oc) =>
                  oc.column('id').doUpdateSet({
                    owner_id: ownerId,
                    visibility,
                  }),
                )
                .execute();
            } else {
              await trx
                .insertInto('social.videos')
                .values({ id: videoId, owner_id: ownerId })
                .onConflict((oc) =>
                  oc.column('id').doUpdateSet({
                    owner_id: ownerId,
                  }),
                )
                .execute();
            }

            const isNowHidden = prev ? Boolean(prev.hidden) : false;
            const isNowPublic = visibility === 'PUBLIC' && !isNowHidden;

            if (!wasPublic && isNowPublic) {
              await this.fanoutVideoPublished(trx, ownerId, videoId);
            }
          });

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

      if (event.type === 'video.visibility_changed') {
        const data = event.data as Record<string, unknown> | undefined;
        const videoId = data?.video_id;
        const ownerId = data?.owner_id;
        const visibility = data?.visibility;

        if (
          typeof videoId !== 'string' ||
          !isValidUuid(videoId) ||
          typeof ownerId !== 'string' ||
          !isValidUuid(ownerId) ||
          (visibility !== 'PUBLIC' && visibility !== 'UNLISTED' && visibility !== 'PRIVATE')
        ) {
          this.logger.error(
            { event, subject: m.subject },
            'Poison message: invalid payload in video.visibility_changed event; terminating message',
          );
          m.term();
          return;
        }

        try {
          await this.db.transaction().execute(async (trx) => {
            const prev = await trx
              .selectFrom('social.videos')
              .select(['id', 'owner_id', 'hidden', 'visibility'])
              .where('id', '=', videoId)
              .forUpdate()
              .executeTakeFirst();

            if (!prev) {
              // Video not in projection yet, skip
              return;
            }

            const wasPublic = prev.visibility === 'PUBLIC' && !prev.hidden;

            await trx
              .updateTable('social.videos')
              .set({ visibility: visibility as VideoVisibility })
              .where('id', '=', videoId)
              .execute();

            const isNowPublic = (visibility as VideoVisibility) === 'PUBLIC' && !prev.hidden;

            if (!wasPublic && isNowPublic) {
              await this.fanoutVideoPublished(trx, ownerId, videoId);
            }
          });

          m.ack();
        } catch (dbErr) {
          this.logger.error(
            { err: dbErr, subject: m.subject },
            'Database error in video.visibility_changed projection; naking message for retry',
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

  private async fanoutVideoPublished(
    trx: Kysely<Database>,
    ownerId: string,
    videoId: string,
  ): Promise<void> {
    const endTimer = notificationsFanoutDuration.startTimer();
    try {
      let lastSubscriberId: string | null = null;
      const pageSize = 1000;

      while (true) {
        let query = trx
          .selectFrom('social.subscriptions')
          .select('subscriber_id')
          .where('channel_id', '=', ownerId)
          .orderBy('subscriber_id', 'asc')
          .limit(pageSize);

        if (lastSubscriberId) {
          query = query.where('subscriber_id', '>', lastSubscriberId);
        }

        const subscribers = await query.execute();
        if (subscribers.length === 0) {
          break;
        }

        const validSubscribers = subscribers.filter((s) => s.subscriber_id !== ownerId);

        if (validSubscribers.length > 0) {
          const ids = validSubscribers.map(() => uuidv7());
          const userIds = validSubscribers.map((s) => s.subscriber_id);

          const inserted = await sql<{ id: string }>`
            INSERT INTO social.notifications (id, user_id, kind, actor_id, video_id, comment_id)
            SELECT u.id, u.user_id, 'VIDEO_PUBLISHED'::social.notification_kind, ${ownerId}::uuid, ${videoId}::uuid, NULL
            FROM unnest(${sql.val(ids)}::uuid[], ${sql.val(userIds)}::uuid[]) AS u(id, user_id)
            ON CONFLICT DO NOTHING
            RETURNING id
          `.execute(trx);

          if (inserted.rows.length > 0) {
            notificationsCreatedCounter.inc({ kind: 'VIDEO_PUBLISHED' }, inserted.rows.length);
          }
        }

        lastSubscriberId = subscribers[subscribers.length - 1].subscriber_id;
        if (subscribers.length < pageSize) {
          break;
        }
      }
    } finally {
      endTimer();
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
