import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { enqueue } from '@winkey/outbox';
import type {
  Database,
  SubscriptionStateDto,
  SubscriptionPageDto,
  SubscriptionItemDto,
  FollowPageDto,
  FollowItemDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildSubscriptionRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { isBlockedEitherWay, shouldSuppressNotification } from '../utils/blocks.js';
import { v7 as uuidv7 } from 'uuid';
import { notificationsCreatedCounter } from '../metrics.js';
import { onNewFollow } from '../utils/friends.js';

export interface SubscriptionsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

interface SubscriptionCursor {
  created_at: string;
  channel_id: string;
}

interface FollowersCursor {
  created_at: string;
  subscriber_id: string;
}

interface FollowingCursor {
  created_at: string;
  channel_id: string;
}

export const subscriptionsRoute: FastifyPluginAsync<SubscriptionsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Get channel subscription status (Optional auth)
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
      let requested = false;

      if (caller.userId) {
        // If caller and channel are in a block relation, they cannot be subscribed or requested
        const blocked = await isBlockedEitherWay(db, caller.userId, channel_id);
        if (!blocked) {
          const subRecord = await db
            .selectFrom('social.subscriptions')
            .select(sql`1`.as('one'))
            .where('subscriber_id', '=', caller.userId)
            .where('channel_id', '=', channel_id)
            .executeTakeFirst();
          subscribed = !!subRecord;

          if (!subscribed) {
            const reqRecord = await db
              .selectFrom('social.follow_requests')
              .select(sql`1`.as('one'))
              .where('requester_id', '=', caller.userId)
              .where('target_id', '=', channel_id)
              .executeTakeFirst();
            requested = !!reqRecord;
          }
        }
      }

      const response: SubscriptionStateDto = {
        channel_id,
        subscribed,
        requested,
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

      // Check block between caller and channel in either direction -> 404
      const blocked = await isBlockedEitherWay(db, caller.userId, channel_id);
      if (blocked) {
        throw ProblemError.notFound('Channel not found', 'CHANNEL_NOT_FOUND');
      }

      // Check channel exists in auth.public_profiles
      const profile = await db
        .selectFrom('auth.public_profiles')
        .select(['id', 'is_private'])
        .where('id', '=', channel_id)
        .executeTakeFirst();

      if (!profile) {
        throw ProblemError.notFound('Channel not found', 'CHANNEL_NOT_FOUND');
      }

      // Check if already subscribed
      const alreadySubscribed = await db
        .selectFrom('social.subscriptions')
        .select(sql`1`.as('one'))
        .where('subscriber_id', '=', caller.userId)
        .where('channel_id', '=', channel_id)
        .executeTakeFirst();

      if (alreadySubscribed) {
        const channelRow = await db
          .selectFrom('social.channels')
          .select('subscriber_count')
          .where('id', '=', channel_id)
          .executeTakeFirst();
        return reply.status(200).send({
          channel_id,
          subscribed: true,
          requested: false,
          subscriber_count: channelRow ? Number(channelRow.subscriber_count) : 0,
        });
      }

      // Private target handling (SOC-1b, ADR-049)
      if (profile.is_private) {
        // Check if follow request already pending
        const existingReq = await db
          .selectFrom('social.follow_requests')
          .select(sql`1`.as('one'))
          .where('requester_id', '=', caller.userId)
          .where('target_id', '=', channel_id)
          .executeTakeFirst();

        let currentSubscriberCount = 0;

        await db.transaction().execute(async (trx) => {
          if (!existingReq) {
            // Check quota: at most 200 pending outgoing follow requests per user
            const outgoingCountRes = await sql<{ count: number }>`
              SELECT count(*)::int AS count
              FROM social.follow_requests
              WHERE requester_id = ${caller.userId}::uuid
            `.execute(trx);

            const outgoingCount = Number(outgoingCountRes.rows[0]?.count ?? 0);
            if (outgoingCount >= 200) {
              throw ProblemError.conflict(
                'Maximum pending follow requests limit reached',
                'LIMIT_REACHED',
              );
            }

            await trx
              .insertInto('social.follow_requests')
              .values({
                requester_id: caller.userId,
                target_id: channel_id,
              })
              .onConflict((oc) => oc.doNothing())
              .execute();

            // Create FOLLOW_REQUEST in-app notification if not suppressed
            const suppressed = await shouldSuppressNotification(trx, caller.userId, channel_id);
            if (!suppressed) {
              const notifId = uuidv7();
              const inserted = await trx
                .insertInto('social.notifications')
                .values({
                  id: notifId,
                  user_id: channel_id,
                  kind: 'FOLLOW_REQUEST',
                  actor_id: caller.userId,
                  video_id: null,
                  comment_id: null,
                })
                .onConflict((oc) => oc.doNothing())
                .returning('id')
                .execute();

              if (inserted.length > 0) {
                notificationsCreatedCounter.inc({ kind: 'FOLLOW_REQUEST' });
              }
            }
          }

          const channelRow = await trx
            .selectFrom('social.channels')
            .select('subscriber_count')
            .where('id', '=', channel_id)
            .executeTakeFirst();
          currentSubscriberCount = channelRow ? Number(channelRow.subscriber_count) : 0;
        });

        // Response for private account: subscribed = false, requested = true, NO outbox event
        const response: SubscriptionStateDto = {
          channel_id,
          subscribed: false,
          requested: true,
          subscriber_count: currentSubscriberCount,
        };
        return reply.status(200).send(response);
      }

      // Public channel: normal subscription
      let currentSubscriberCount = 0;

      await db.transaction().execute(async (trx) => {
        // Clear any previous pending follow request (e.g. if account became public)
        await trx
          .deleteFrom('social.follow_requests')
          .where('requester_id', '=', caller.userId)
          .where('target_id', '=', channel_id)
          .execute();

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
            const suppressed = await shouldSuppressNotification(trx, caller.userId, channel_id);
            if (!suppressed) {
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

          // SOC-6b: following back clears a dismissal; a pair that just became mutual is a friendship.
          await onNewFollow(trx, caller.userId, channel_id, { notifyFriendAccepted: true });
        }
      });

      const response: SubscriptionStateDto = {
        channel_id,
        subscribed: true,
        requested: false,
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

      if (!isValidUuid(channel_id)) {
        const response: SubscriptionStateDto = {
          channel_id,
          subscribed: false,
          requested: false,
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
        // Also cancel any pending follow request (SOC-1b)
        await trx
          .deleteFrom('social.follow_requests')
          .where('requester_id', '=', caller.userId)
          .where('target_id', '=', channel_id)
          .execute();

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
        requested: false,
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
      .where('s.subscriber_id', '=', caller.userId)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = s.channel_id)
             OR (b.blocker_id = s.channel_id AND b.blocked_id = ${caller.userId})
        )`,
      );

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

  // 5. List followers of a channel (task SOC-1b, Optional auth)
  fastify.get<{
    Params: { channel_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/channels/:channel_id/followers', async (request, reply) => {
    const { channel_id } = request.params;
    const { cursor, limit } = request.query;

    if (!isValidUuid(channel_id)) {
      throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: FollowersCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<FollowersCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.subscriber_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Check target channel
    const channelProfile = await db
      .selectFrom('auth.public_profiles')
      .select(['id', 'is_private'])
      .where('id', '=', channel_id)
      .executeTakeFirst();

    // Unknown channel -> empty page
    if (!channelProfile) {
      const response: FollowPageDto = { items: [], next_cursor: null };
      return reply.status(200).send(response);
    }

    // If channel is private: only owner and approved followers may read
    if (channelProfile.is_private) {
      if (!caller.userId) {
        throw ProblemError.forbidden('Private account', 'PRIVATE_ACCOUNT');
      }

      if (caller.userId !== channel_id) {
        const isFollower = await db
          .selectFrom('social.subscriptions')
          .select(sql`1`.as('one'))
          .where('subscriber_id', '=', caller.userId)
          .where('channel_id', '=', channel_id)
          .executeTakeFirst();

        if (!isFollower) {
          throw ProblemError.forbidden('Private account', 'PRIVATE_ACCOUNT');
        }
      }
    }

    let query = db
      .selectFrom('social.subscriptions as s')
      .innerJoin('auth.public_profiles as p', 'p.id', 's.subscriber_id')
      .select([
        's.subscriber_id',
        's.created_at as followed_at',
        sql<string>`to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'followed_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('s.channel_id', '=', channel_id);

    // Filter out users in a block relation with the caller
    if (caller.userId) {
      query = query.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = s.subscriber_id)
             OR (b.blocker_id = s.subscriber_id AND b.blocked_id = ${caller.userId})
        )`,
      );
    }

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((s.created_at < ${cursorData.created_at}::timestamptz) OR (s.created_at = ${cursorData.created_at}::timestamptz AND s.subscriber_id < ${cursorData.subscriber_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('s.created_at', 'desc')
      .orderBy('s.subscriber_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: FollowItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const followedAtStr =
        (r as { followed_at_cursor?: string }).followed_at_cursor ||
        new Date(r.followed_at).toISOString();

      return {
        user: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        followed_at: followedAtStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { followed_at_cursor?: string }).followed_at_cursor ||
        new Date(last.followed_at).toISOString();
      nextCursor = encodeCursor<FollowersCursor>({
        created_at: cursorCreatedAt,
        subscriber_id: last.subscriber_id,
      });
    }

    const response: FollowPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 6. List channels a user follows (task SOC-1b, Optional auth)
  fastify.get<{
    Params: { channel_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/channels/:channel_id/following', async (request, reply) => {
    const { channel_id } = request.params;
    const { cursor, limit } = request.query;

    if (!isValidUuid(channel_id)) {
      throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: FollowingCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<FollowingCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.channel_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Check target channel
    const channelProfile = await db
      .selectFrom('auth.public_profiles')
      .select(['id', 'is_private'])
      .where('id', '=', channel_id)
      .executeTakeFirst();

    // Unknown channel -> empty page
    if (!channelProfile) {
      const response: FollowPageDto = { items: [], next_cursor: null };
      return reply.status(200).send(response);
    }

    // If channel is private: only owner and approved followers may read
    if (channelProfile.is_private) {
      if (!caller.userId) {
        throw ProblemError.forbidden('Private account', 'PRIVATE_ACCOUNT');
      }

      if (caller.userId !== channel_id) {
        const isFollower = await db
          .selectFrom('social.subscriptions')
          .select(sql`1`.as('one'))
          .where('subscriber_id', '=', caller.userId)
          .where('channel_id', '=', channel_id)
          .executeTakeFirst();

        if (!isFollower) {
          throw ProblemError.forbidden('Private account', 'PRIVATE_ACCOUNT');
        }
      }
    }

    let query = db
      .selectFrom('social.subscriptions as s')
      .innerJoin('auth.public_profiles as p', 'p.id', 's.channel_id')
      .select([
        's.channel_id',
        's.created_at as followed_at',
        sql<string>`to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'followed_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('s.subscriber_id', '=', channel_id);

    // Filter out users in a block relation with the caller
    if (caller.userId) {
      query = query.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = s.channel_id)
             OR (b.blocker_id = s.channel_id AND b.blocked_id = ${caller.userId})
        )`,
      );
    }

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

    const items: FollowItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const followedAtStr =
        (r as { followed_at_cursor?: string }).followed_at_cursor ||
        new Date(r.followed_at).toISOString();

      return {
        user: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        followed_at: followedAtStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { followed_at_cursor?: string }).followed_at_cursor ||
        new Date(last.followed_at).toISOString();
      nextCursor = encodeCursor<FollowingCursor>({
        created_at: cursorCreatedAt,
        channel_id: last.channel_id,
      });
    }

    const response: FollowPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });
};
