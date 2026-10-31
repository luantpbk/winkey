import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { enqueue } from '@winkey/outbox';
import type {
  Database,
  FollowRequestPageDto,
  FollowRequestDto,
  RelationshipDto,
  RelationPageDto,
  RelationItemDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildRelationshipChangeRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { shouldSuppressNotification } from '../utils/blocks.js';
import { v7 as uuidv7 } from 'uuid';
import { notificationsCreatedCounter } from '../metrics.js';
import { onNewFollow } from '../utils/friends.js';

export interface RelationshipsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

interface FollowRequestCursor {
  created_at: string;
  requester_id: string;
}

interface RelationCursor {
  created_at: string;
  user_id: string;
}

export const relationshipsRoute: FastifyPluginAsync<RelationshipsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Get caller's relationship to another user
  fastify.get<{ Params: { channel_id: string } }>(
    '/v1/channels/:channel_id/relationship',
    async (request, reply) => {
      const { channel_id } = request.params;

      if (!isValidUuid(channel_id)) {
        throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
      }

      const caller = requireAuth(request);

      if (caller.userId === channel_id) {
        throw ProblemError.badRequest(
          'Cannot query relationship with yourself',
          undefined,
          'CANNOT_QUERY_SELF',
        );
      }

      // Check following
      const followingRow = await db
        .selectFrom('social.subscriptions')
        .select(sql`1`.as('one'))
        .where('subscriber_id', '=', caller.userId)
        .where('channel_id', '=', channel_id)
        .executeTakeFirst();

      // Check follow_requested
      const requestedRow = await db
        .selectFrom('social.follow_requests')
        .select(sql`1`.as('one'))
        .where('requester_id', '=', caller.userId)
        .where('target_id', '=', channel_id)
        .executeTakeFirst();

      // Check followed_by
      const followedByRow = await db
        .selectFrom('social.subscriptions')
        .select(sql`1`.as('one'))
        .where('subscriber_id', '=', channel_id)
        .where('channel_id', '=', caller.userId)
        .executeTakeFirst();

      // Check blocking (caller blocks target only; NEVER reveal if target blocks caller!)
      const blockingRow = await db
        .selectFrom('social.blocks')
        .select(sql`1`.as('one'))
        .where('blocker_id', '=', caller.userId)
        .where('blocked_id', '=', channel_id)
        .executeTakeFirst();

      // Check muting
      const mutingRow = await db
        .selectFrom('social.mutes')
        .select(sql`1`.as('one'))
        .where('muter_id', '=', caller.userId)
        .where('muted_id', '=', channel_id)
        .executeTakeFirst();

      const response: RelationshipDto = {
        user_id: channel_id,
        following: !!followingRow,
        follow_requested: !!requestedRow,
        followed_by: !!followedByRow,
        blocking: !!blockingRow,
        muting: !!mutingRow,
      };

      return reply.status(200).send(response);
    },
  );

  // 2. List pending follow requests to the caller
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/me/follow-requests', async (request, reply) => {
    const caller = requireAuth(request);
    const { cursor, limit } = request.query;

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: FollowRequestCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<FollowRequestCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.requester_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Pending count: all pending requests to the caller (excluding inactive profiles and blocked users)
    const countRes = await db
      .selectFrom('social.follow_requests as fr')
      .innerJoin('auth.public_profiles as p', 'p.id', 'fr.requester_id')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('fr.target_id', '=', caller.userId)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = fr.requester_id)
             OR (b.blocker_id = fr.requester_id AND b.blocked_id = ${caller.userId})
        )`,
      )
      .executeTakeFirst();

    const pendingCount = Number(countRes?.count ?? 0);

    let query = db
      .selectFrom('social.follow_requests as fr')
      .innerJoin('auth.public_profiles as p', 'p.id', 'fr.requester_id')
      .select([
        'fr.requester_id',
        'fr.created_at as requested_at',
        sql<string>`to_char(fr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'requested_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('fr.target_id', '=', caller.userId)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = fr.requester_id)
             OR (b.blocker_id = fr.requester_id AND b.blocked_id = ${caller.userId})
        )`,
      );

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((fr.created_at < ${cursorData.created_at}::timestamptz) OR (fr.created_at = ${cursorData.created_at}::timestamptz AND fr.requester_id < ${cursorData.requester_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('fr.created_at', 'desc')
      .orderBy('fr.requester_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: FollowRequestDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const requestedAtStr =
        (r as { requested_at_cursor?: string }).requested_at_cursor ||
        new Date(r.requested_at).toISOString();

      return {
        requester: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        requested_at: requestedAtStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { requested_at_cursor?: string }).requested_at_cursor ||
        new Date(last.requested_at).toISOString();
      nextCursor = encodeCursor<FollowRequestCursor>({
        created_at: cursorCreatedAt,
        requester_id: last.requester_id,
      });
    }

    const response: FollowRequestPageDto = {
      items,
      next_cursor: nextCursor,
      pending_count: pendingCount,
    };

    return reply.status(200).send(response);
  });

  // 3. Approve or reject a follow request
  fastify.post<{
    Params: { requester_id: string };
    Body: { decision?: string };
  }>('/v1/me/follow-requests/:requester_id/decision', async (request, reply) => {
    const { requester_id } = request.params;
    const { decision } = request.body || {};

    if (!isValidUuid(requester_id)) {
      throw ProblemError.badRequest('Invalid requester ID', undefined, 'INVALID_ID');
    }

    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw ProblemError.badRequest(
        'Decision must be APPROVE or REJECT',
        undefined,
        'INVALID_DECISION',
      );
    }

    const caller = requireAuth(request);

    await db.transaction().execute(async (trx) => {
      // Find and delete the request
      const deleted = await trx
        .deleteFrom('social.follow_requests')
        .where('requester_id', '=', requester_id)
        .where('target_id', '=', caller.userId)
        .returning('requester_id')
        .execute();

      if (deleted.length === 0) {
        throw ProblemError.notFound('Follow request not found', 'REQUEST_NOT_FOUND');
      }

      if (decision === 'APPROVE') {
        const insertResult = await sql<{ inserted: number }>`
          INSERT INTO social.subscriptions (subscriber_id, channel_id)
          VALUES (${requester_id}, ${caller.userId})
          ON CONFLICT (subscriber_id, channel_id) DO NOTHING
          RETURNING 1 as inserted
        `.execute(trx);

        const wasInserted = insertResult.rows.length > 0;

        const channelRow = await trx
          .selectFrom('social.channels')
          .select('subscriber_count')
          .where('id', '=', caller.userId)
          .executeTakeFirst();
        const currentSubscriberCount = channelRow ? Number(channelRow.subscriber_count) : 0;

        if (wasInserted) {
          // Outbox event
          await enqueue(
            trx,
            'social',
            'social.subscription.changed',
            {
              subscriber_id: requester_id,
              channel_id: caller.userId,
              subscribed: true,
              subscriber_count: currentSubscriberCount,
            },
            { producer: 'social-svc', version: 1 },
          );

          // In-app notification to caller: NEW_SUBSCRIBER
          const suppressedCallerNotif = await shouldSuppressNotification(
            trx,
            requester_id,
            caller.userId,
          );
          if (!suppressedCallerNotif) {
            const notifId = uuidv7();
            const inserted = await trx
              .insertInto('social.notifications')
              .values({
                id: notifId,
                user_id: caller.userId,
                kind: 'NEW_SUBSCRIBER',
                actor_id: requester_id,
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

          // In-app notification to requester: FOLLOW_REQUEST_APPROVED
          const suppressedReqNotif = await shouldSuppressNotification(
            trx,
            caller.userId,
            requester_id,
          );
          if (!suppressedReqNotif) {
            const notifId = uuidv7();
            const inserted = await trx
              .insertInto('social.notifications')
              .values({
                id: notifId,
                user_id: requester_id,
                kind: 'FOLLOW_REQUEST_APPROVED',
                actor_id: caller.userId,
                video_id: null,
                comment_id: null,
              })
              .onConflict((oc) => oc.doNothing())
              .returning('id')
              .execute();

            if (inserted.length > 0) {
              notificationsCreatedCounter.inc({ kind: 'FOLLOW_REQUEST_APPROVED' });
            }
          }

          // SOC-6b: the requester now follows the caller, which clears a dismissal of the caller's request.
          // An approval creates only FOLLOW_REQUEST_APPROVED, even when it makes the pair mutual (contract).
          await onNewFollow(trx, requester_id, caller.userId, { notifyFriendAccepted: false });
        }
      }
    });

    return reply.status(204).send();
  });

  // 4. List users caller blocks
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/me/blocks', async (request, reply) => {
    const caller = requireAuth(request);
    const { cursor, limit } = request.query;

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: RelationCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<RelationCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.user_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.blocks as b')
      .innerJoin('auth.public_profiles as p', 'p.id', 'b.blocked_id')
      .select([
        'b.blocked_id',
        'b.created_at as since',
        sql<string>`to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'since_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('b.blocker_id', '=', caller.userId);

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((b.created_at < ${cursorData.created_at}::timestamptz) OR (b.created_at = ${cursorData.created_at}::timestamptz AND b.blocked_id < ${cursorData.user_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('b.created_at', 'desc')
      .orderBy('b.blocked_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: RelationItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const sinceStr =
        (r as { since_cursor?: string }).since_cursor || new Date(r.since).toISOString();

      return {
        user: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        since: sinceStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { since_cursor?: string }).since_cursor || new Date(last.since).toISOString();
      nextCursor = encodeCursor<RelationCursor>({
        created_at: cursorCreatedAt,
        user_id: last.blocked_id,
      });
    }

    const response: RelationPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 5. Block a user (idempotent PUT)
  fastify.put<{ Params: { user_id: string } }>('/v1/me/blocks/:user_id', async (request, reply) => {
    const { user_id } = request.params;

    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID', undefined, 'INVALID_ID');
    }

    const caller = requireAuth(request);

    if (caller.userId === user_id) {
      throw ProblemError.badRequest('Cannot block yourself', undefined, 'CANNOT_BLOCK_SELF');
    }

    // Rate limit: 60 block/mute changes per hour
    await rateLimiter.consume({
      key: buildRelationshipChangeRateLimitKey(caller.userId),
      limit: 60,
      windowSeconds: 3600,
    });

    // Target must be an active profile
    const target = await db
      .selectFrom('auth.public_profiles')
      .select('id')
      .where('id', '=', user_id)
      .executeTakeFirst();

    if (!target) {
      throw ProblemError.notFound('User not found', 'USER_NOT_FOUND');
    }

    // Check if already blocking
    const alreadyBlocking = await db
      .selectFrom('social.blocks')
      .select(sql`1`.as('one'))
      .where('blocker_id', '=', caller.userId)
      .where('blocked_id', '=', user_id)
      .executeTakeFirst();

    if (!alreadyBlocking) {
      // Enforce limit: 1000 blocks per user
      const countRes = await sql<{ count: number }>`
          SELECT count(*)::int AS count
          FROM social.blocks
          WHERE blocker_id = ${caller.userId}::uuid
        `.execute(db);
      const count = Number(countRes.rows[0]?.count ?? 0);
      if (count >= 1000) {
        throw ProblemError.conflict('Block limit reached (maximum 1000)', 'LIMIT_REACHED');
      }
    }

    await db.transaction().execute(async (trx) => {
      // Delete subscriptions both ways
      const deletedSubs = await sql<{ subscriber_id: string; channel_id: string }>`
          DELETE FROM social.subscriptions
          WHERE (subscriber_id = ${caller.userId} AND channel_id = ${user_id})
             OR (subscriber_id = ${user_id} AND channel_id = ${caller.userId})
          RETURNING subscriber_id, channel_id
        `.execute(trx);

      // For each removed subscription, write outbox event so video feed stays synced
      for (const sub of deletedSubs.rows) {
        const channelRow = await trx
          .selectFrom('social.channels')
          .select('subscriber_count')
          .where('id', '=', sub.channel_id)
          .executeTakeFirst();
        const subscriberCount = channelRow ? Number(channelRow.subscriber_count) : 0;

        await enqueue(
          trx,
          'social',
          'social.subscription.changed',
          {
            subscriber_id: sub.subscriber_id,
            channel_id: sub.channel_id,
            subscribed: false,
            subscriber_count: subscriberCount,
          },
          { producer: 'social-svc', version: 1 },
        );
      }

      // SOC-6b: a block deletes friend-request dismissals both ways
      await trx
        .deleteFrom('social.friend_request_dismissals')
        .where((eb) =>
          eb.or([
            eb.and([eb('user_id', '=', caller.userId), eb('follower_id', '=', user_id)]),
            eb.and([eb('user_id', '=', user_id), eb('follower_id', '=', caller.userId)]),
          ]),
        )
        .execute();

      // Delete follow requests both ways
      await trx
        .deleteFrom('social.follow_requests')
        .where((eb) =>
          eb.or([
            eb.and([eb('requester_id', '=', caller.userId), eb('target_id', '=', user_id)]),
            eb.and([eb('requester_id', '=', user_id), eb('target_id', '=', caller.userId)]),
          ]),
        )
        .execute();

      // Insert block
      await trx
        .insertInto('social.blocks')
        .values({
          blocker_id: caller.userId,
          blocked_id: user_id,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });

    return reply.status(204).send();
  });

  // 6. Unblock a user (idempotent DELETE)
  fastify.delete<{ Params: { user_id: string } }>(
    '/v1/me/blocks/:user_id',
    async (request, reply) => {
      const { user_id } = request.params;

      if (!isValidUuid(user_id)) {
        throw ProblemError.badRequest('Invalid user ID', undefined, 'INVALID_ID');
      }

      const caller = requireAuth(request);

      // Rate limit: 60 block/mute changes per hour
      await rateLimiter.consume({
        key: buildRelationshipChangeRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 3600,
      });

      await db
        .deleteFrom('social.blocks')
        .where('blocker_id', '=', caller.userId)
        .where('blocked_id', '=', user_id)
        .execute();

      return reply.status(204).send();
    },
  );

  // 7. List users caller mutes
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/me/mutes', async (request, reply) => {
    const caller = requireAuth(request);
    const { cursor, limit } = request.query;

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: RelationCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<RelationCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.user_id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.mutes as m')
      .innerJoin('auth.public_profiles as p', 'p.id', 'm.muted_id')
      .select([
        'm.muted_id',
        'm.created_at as since',
        sql<string>`to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'since_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('m.muter_id', '=', caller.userId);

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((m.created_at < ${cursorData.created_at}::timestamptz) OR (m.created_at = ${cursorData.created_at}::timestamptz AND m.muted_id < ${cursorData.user_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('m.created_at', 'desc')
      .orderBy('m.muted_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: RelationItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const sinceStr =
        (r as { since_cursor?: string }).since_cursor || new Date(r.since).toISOString();

      return {
        user: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        since: sinceStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { since_cursor?: string }).since_cursor || new Date(last.since).toISOString();
      nextCursor = encodeCursor<RelationCursor>({
        created_at: cursorCreatedAt,
        user_id: last.muted_id,
      });
    }

    const response: RelationPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 8. Mute a user (idempotent PUT)
  fastify.put<{ Params: { user_id: string } }>('/v1/me/mutes/:user_id', async (request, reply) => {
    const { user_id } = request.params;

    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID', undefined, 'INVALID_ID');
    }

    const caller = requireAuth(request);

    if (caller.userId === user_id) {
      throw ProblemError.badRequest('Cannot mute yourself', undefined, 'CANNOT_MUTE_SELF');
    }

    // Rate limit: 60 block/mute changes per hour
    await rateLimiter.consume({
      key: buildRelationshipChangeRateLimitKey(caller.userId),
      limit: 60,
      windowSeconds: 3600,
    });

    // Target must be an active profile
    const target = await db
      .selectFrom('auth.public_profiles')
      .select('id')
      .where('id', '=', user_id)
      .executeTakeFirst();

    if (!target) {
      throw ProblemError.notFound('User not found', 'USER_NOT_FOUND');
    }

    // Check if already muting
    const alreadyMuting = await db
      .selectFrom('social.mutes')
      .select(sql`1`.as('one'))
      .where('muter_id', '=', caller.userId)
      .where('muted_id', '=', user_id)
      .executeTakeFirst();

    if (!alreadyMuting) {
      // Enforce limit: 1000 mutes per user
      const countRes = await sql<{ count: number }>`
        SELECT count(*)::int AS count
        FROM social.mutes
        WHERE muter_id = ${caller.userId}::uuid
      `.execute(db);
      const count = Number(countRes.rows[0]?.count ?? 0);
      if (count >= 1000) {
        throw ProblemError.conflict('Mute limit reached (maximum 1000)', 'LIMIT_REACHED');
      }
    }

    await db
      .insertInto('social.mutes')
      .values({
        muter_id: caller.userId,
        muted_id: user_id,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    return reply.status(204).send();
  });

  // 9. Unmute a user (idempotent DELETE)
  fastify.delete<{ Params: { user_id: string } }>(
    '/v1/me/mutes/:user_id',
    async (request, reply) => {
      const { user_id } = request.params;

      if (!isValidUuid(user_id)) {
        throw ProblemError.badRequest('Invalid user ID', undefined, 'INVALID_ID');
      }

      const caller = requireAuth(request);

      // Rate limit: 60 block/mute changes per hour
      await rateLimiter.consume({
        key: buildRelationshipChangeRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 3600,
      });

      await db
        .deleteFrom('social.mutes')
        .where('muter_id', '=', caller.userId)
        .where('muted_id', '=', user_id)
        .execute();

      return reply.status(204).send();
    },
  );
};
