import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { enqueue } from '@winkey/outbox';
import type {
  Database,
  SubscriptionStateDto,
  SubscriptionPageDto,
  SubscriptionItemDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildSubscriptionRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { v7 as uuidv7 } from 'uuid';
import { notificationsCreatedCounter } from '../metrics.js';

export interface SubscriptionsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

interface SubscriptionCursor {
  created_at: string;
  channel_id: string;
}

export const subscriptionsRoute: FastifyPluginAsync<SubscriptionsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Get channel subscription status
  fastify.get<{ Params: { channel_id: string } }>(
    '/v1/channels/:channel_id/subscription',
    async (request, reply) => {
      const { channel_id } = request.params;

      if (!isValidUuid(channel_id)) {
        throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
      }

      const caller = getCaller(request);

      const channel = await db
        .selectFrom('social.channels')
        .select(['id', 'subscriber_count'])
        .where('id', '=', channel_id)
        .executeTakeFirst();

      const subscriberCount = channel ? Number(channel.subscriber_count) : 0;

      let subscribed = false;
      if (caller.userId) {
        const subRecord = await db
          .selectFrom('social.subscriptions')
          .select(sql`1`.as('one'))
          .where('subscriber_id', '=', caller.userId)
          .where('channel_id', '=', channel_id)
          .executeTakeFirst();
        subscribed = !!subRecord;
      }

      const response: SubscriptionStateDto = {
        channel_id,
        subscribed,
        subscriber_count: subscriberCount,
      };

      return reply.status(200).send(response);
    },
  );

  // 2. Subscribe to channel (idempotent PUT)
  fastify.put<{ Params: { channel_id: string } }>(
    '/v1/channels/:channel_id/subscription',
    async (request, reply) => {
      const { channel_id } = request.params;

      if (!isValidUuid(channel_id)) {
        throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
      }

      const caller = requireAuth(request);

      // Rate limit: 60/min per user
      await rateLimiter.consume({
        key: buildSubscriptionRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 60,
      });

      if (caller.userId === channel_id) {
        throw ProblemError.badRequest(
          'Cannot subscribe to yourself',
          undefined,
          'CANNOT_SUBSCRIBE_SELF',
        );
      }

      // Check channel exists in auth.public_profiles
      const profile = await db
        .selectFrom('auth.public_profiles')
        .select('id')
        .where('id', '=', channel_id)
        .executeTakeFirst();

      if (!profile) {
        throw ProblemError.notFound('Channel not found', 'CHANNEL_NOT_FOUND');
      }

      let currentSubscriberCount = 0;

      await db.transaction().execute(async (trx) => {
        const insertResult = await sql<{ inserted: number }>`
          INSERT INTO social.subscriptions (subscriber_id, channel_id)
          VALUES (${caller.userId}, ${channel_id})
          ON CONFLICT (subscriber_id, channel_id) DO NOTHING
          RETURNING 1 as inserted
        `.execute(trx);

        const wasInserted = insertResult.rows.length > 0;

        const channelRow = await trx
          .selectFrom('social.channels')
          .select('subscriber_count')
          .where('id', '=', channel_id)
          .executeTakeFirstOrThrow();

        currentSubscriberCount = Number(channelRow.subscriber_count);

        if (wasInserted) {
          await enqueue(
            trx,
            'social',
            'social.subscription.changed',
            {
              subscriber_id: caller.userId,
              channel_id,
              subscribed: true,
              subscriber_count: currentSubscriberCount,
            },
            { producer: 'social-svc', version: 1 },
          );

          // In-app Notification (Task N1, ADR-023)
          if (caller.userId !== channel_id) {
            const notifId = uuidv7();
            const inserted = await trx
              .insertInto('social.notifications')
              .values({
                id: notifId,
                user_id: channel_id,
                kind: 'NEW_SUBSCRIBER',
                actor_id: caller.userId,
                video_id: null,
                comment_id: null,
              })
              .onConflict((oc) => oc.doNothing())
              .returning('id')
              .execute();
            if (inserted.length > 0) {
              notificationsCreatedCounter.inc({ kind: 'NEW_SUBSCRIBER' });
            }
          }
        }
      });

      const response: SubscriptionStateDto = {
        channel_id,
        subscribed: true,
        subscriber_count: currentSubscriberCount,
      };

      return reply.status(200).send(response);
    },
  );

  // 3. Unsubscribe from channel (idempotent DELETE)
  fastify.delete<{ Params: { channel_id: string } }>(
    '/v1/channels/:channel_id/subscription',
    async (request, reply) => {
      const { channel_id } = request.params;

      // Contract specifies 200, 401, 429 (no 400). Unsubscribing from non-existent channel is 200.
      if (!isValidUuid(channel_id)) {
        const response: SubscriptionStateDto = {
          channel_id,
          subscribed: false,
          subscriber_count: 0,
        };
        return reply.status(200).send(response);
      }

      const caller = requireAuth(request);

      // Rate limit: 60/min per user
      await rateLimiter.consume({
        key: buildSubscriptionRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 60,
      });

      let currentSubscriberCount = 0;

      await db.transaction().execute(async (trx) => {
        const deleteResult = await sql<{ deleted: number }>`
          DELETE FROM social.subscriptions
          WHERE subscriber_id = ${caller.userId} AND channel_id = ${channel_id}
          RETURNING 1 as deleted
        `.execute(trx);

        const wasDeleted = deleteResult.rows.length > 0;

        const channelRow = await trx
          .selectFrom('social.channels')
          .select('subscriber_count')
          .where('id', '=', channel_id)
          .executeTakeFirst();

        currentSubscriberCount = channelRow ? Number(channelRow.subscriber_count) : 0;

        if (wasDeleted) {
          await enqueue(
            trx,
            'social',
            'social.subscription.changed',
            {
              subscriber_id: caller.userId,
              channel_id,
              subscribed: false,
              subscriber_count: currentSubscriberCount,
            },
            { producer: 'social-svc', version: 1 },
          );
        }
      });

      const response: SubscriptionStateDto = {
        channel_id,
        subscribed: false,
        subscriber_count: currentSubscriberCount,
      };

      return reply.status(200).send(response);
    },
  );

  // 4. List my subscriptions (most recent first)
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/me/subscriptions', async (request, reply) => {
    const caller = requireAuth(request);
    const { cursor, limit } = request.query;

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: SubscriptionCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<SubscriptionCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.channel_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.subscriptions as s')
      .innerJoin('auth.public_profiles as p', 'p.id', 's.channel_id')
      .select([
        's.channel_id',
        's.created_at as subscribed_at',
        sql<string>`to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'subscribed_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('s.subscriber_id', '=', caller.userId);

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((s.created_at < ${cursorData.created_at}::timestamptz) OR (s.created_at = ${cursorData.created_at}::timestamptz AND s.channel_id < ${cursorData.channel_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('s.created_at', 'desc')
      .orderBy('s.channel_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: SubscriptionItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      return {
        channel: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        subscribed_at: new Date(r.subscribed_at).toISOString(),
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { subscribed_at_cursor?: string }).subscribed_at_cursor ||
        new Date(last.subscribed_at).toISOString();
      nextCursor = encodeCursor<SubscriptionCursor>({
        created_at: cursorCreatedAt,
        channel_id: last.channel_id,
      });
    }

    const response: SubscriptionPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });
};
