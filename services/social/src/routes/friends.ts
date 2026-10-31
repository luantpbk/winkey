import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database, FriendPageDto, FriendRequestPageDto } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildRelationshipChangeRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';

export interface FriendsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

interface FriendsCursor {
  at: string;
  user_id: string;
}

/** `limit` 1–100 (default 24) and an optional opaque cursor; anything else is a 400 (common.yaml Limit/Cursor). */
function parsePage(query: { cursor?: string; limit?: string }) {
  const limitNum = query.limit === undefined ? 24 : Number(query.limit);
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
    throw ProblemError.badRequest(
      'limit must be an integer from 1 to 100',
      undefined,
      'INVALID_LIMIT',
    );
  }
  let after: FriendsCursor | null = null;
  if (query.cursor !== undefined) {
    after = query.cursor.length <= 512 ? decodeCursor<FriendsCursor>(query.cursor) : null;
    if (
      !after ||
      typeof after.at !== 'string' ||
      Number.isNaN(Date.parse(after.at)) ||
      typeof after.user_id !== 'string' ||
      !isValidUuid(after.user_id)
    ) {
      throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
    }
  }
  return { limitNum, after };
}

const usec = (column: string) =>
  sql<string>`to_char(${sql.raw(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** SOC-6b friends: mutual follows (social.subscriptions both ways), friend requests and their dismissals. */
export const friendsRoute: FastifyPluginAsync<FriendsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // listMyFriends: newest friendship first; friends_since = the later of the two follows.
  fastify.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/v1/me/friends',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { limitNum, after } = parsePage(request.query);

      const rows = await sql<{
        user_id: string;
        since: string;
        handle: string;
        display_name: string;
        avatar_key: string | null;
      }>`
        SELECT s1.channel_id AS user_id,
               ${usec('greatest(s1.created_at, s2.created_at)')} AS since,
               p.handle, p.display_name, p.avatar_key
        FROM social.subscriptions s1
        JOIN social.subscriptions s2
          ON s2.subscriber_id = s1.channel_id AND s2.channel_id = s1.subscriber_id
        JOIN auth.public_profiles p ON p.id = s1.channel_id
        WHERE s1.subscriber_id = ${caller.userId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM social.blocks b
            WHERE (b.blocker_id = ${caller.userId}::uuid AND b.blocked_id = s1.channel_id)
               OR (b.blocker_id = s1.channel_id AND b.blocked_id = ${caller.userId}::uuid)
          )
          ${
            after
              ? sql`AND (greatest(s1.created_at, s2.created_at), s1.channel_id)
                      < (${after.at}::timestamptz, ${after.user_id}::uuid)`
              : sql``
          }
        ORDER BY greatest(s1.created_at, s2.created_at) DESC, s1.channel_id DESC
        LIMIT ${limitNum + 1}
      `.execute(db);

      const page = rows.rows.slice(0, limitNum);
      const last = page[page.length - 1];
      const response: FriendPageDto = {
        items: page.map((r) => ({
          user: formatPublicProfile(
            {
              id: r.user_id,
              handle: r.handle,
              display_name: r.display_name,
              avatar_key: r.avatar_key,
            },
            env.MEDIA_BASE_URL,
          )!,
          friends_since: r.since,
        })),
        next_cursor:
          rows.rows.length > limitNum && last
            ? encodeCursor<FriendsCursor>({ at: last.since, user_id: last.user_id })
            : null,
      };
      return reply.status(200).send(response);
    },
  );

  // listFriendRequests: followers the caller does not follow back, without dismissed ones, newest follow first.
  fastify.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/v1/me/friend-requests',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { limitNum, after } = parsePage(request.query);

      const pending = sql`
        FROM social.subscriptions s
        JOIN auth.public_profiles p ON p.id = s.subscriber_id
        WHERE s.channel_id = ${caller.userId}::uuid
          AND NOT EXISTS (SELECT 1 FROM social.subscriptions b
                          WHERE b.subscriber_id = ${caller.userId}::uuid AND b.channel_id = s.subscriber_id)
          AND NOT EXISTS (SELECT 1 FROM social.friend_request_dismissals d
                          WHERE d.user_id = ${caller.userId}::uuid AND d.follower_id = s.subscriber_id)
          AND NOT EXISTS (
            SELECT 1 FROM social.blocks k
            WHERE (k.blocker_id = ${caller.userId}::uuid AND k.blocked_id = s.subscriber_id)
               OR (k.blocker_id = s.subscriber_id AND k.blocked_id = ${caller.userId}::uuid)
          )
      `;

      const [rows, count] = await Promise.all([
        sql<{
          user_id: string;
          followed_at: string;
          handle: string;
          display_name: string;
          avatar_key: string | null;
        }>`
          SELECT s.subscriber_id AS user_id, ${usec('s.created_at')} AS followed_at,
                 p.handle, p.display_name, p.avatar_key
          ${pending}
          ${after ? sql`AND (s.created_at, s.subscriber_id) < (${after.at}::timestamptz, ${after.user_id}::uuid)` : sql``}
          ORDER BY s.created_at DESC, s.subscriber_id DESC
          LIMIT ${limitNum + 1}
        `.execute(db),
        sql<{ count: number }>`SELECT count(*)::int AS count ${pending}`.execute(db),
      ]);

      const page = rows.rows.slice(0, limitNum);
      const last = page[page.length - 1];
      const response: FriendRequestPageDto = {
        items: page.map((r) => ({
          user: formatPublicProfile(
            {
              id: r.user_id,
              handle: r.handle,
              display_name: r.display_name,
              avatar_key: r.avatar_key,
            },
            env.MEDIA_BASE_URL,
          )!,
          followed_at: r.followed_at,
        })),
        next_cursor:
          rows.rows.length > limitNum && last
            ? encodeCursor<FriendsCursor>({ at: last.followed_at, user_id: last.user_id })
            : null,
        pending_count: Number(count.rows[0]?.count ?? 0),
      };
      return reply.status(200).send(response);
    },
  );

  // dismissFriendRequest: hide it; the follower is not told and keeps following. Idempotent.
  fastify.post<{ Params: { user_id: string } }>(
    '/v1/me/friend-requests/:user_id/dismiss',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { user_id } = request.params;

      // Counts toward the 60 relationship changes per hour of blocks and mutes.
      await rateLimiter.consume({
        key: buildRelationshipChangeRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 3600,
      });

      if (!isValidUuid(user_id) || user_id === caller.userId) {
        throw ProblemError.notFound('Friend request not found', 'FRIEND_REQUEST_NOT_FOUND');
      }

      const request_ = await sql<{ one: number }>`
        SELECT 1 AS one
        FROM social.subscriptions s
        WHERE s.subscriber_id = ${user_id}::uuid AND s.channel_id = ${caller.userId}::uuid
          AND NOT EXISTS (SELECT 1 FROM social.subscriptions b
                          WHERE b.subscriber_id = ${caller.userId}::uuid AND b.channel_id = ${user_id}::uuid)
      `.execute(db);
      if (request_.rows.length === 0) {
        throw ProblemError.notFound('Friend request not found', 'FRIEND_REQUEST_NOT_FOUND');
      }

      await db
        .insertInto('social.friend_request_dismissals')
        .values({ user_id: caller.userId, follower_id: user_id })
        .onConflict((oc) => oc.doNothing())
        .execute();

      return reply.status(204).send();
    },
  );
};
