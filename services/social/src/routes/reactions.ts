import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type {
  Database,
  ReactionKind,
  ReactionStateDto,
  ReactionPageDto,
  ReactionItemDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildPostReactionRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { canSeePost } from '../utils/visibility.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { shouldSuppressNotification } from '../utils/blocks.js';

export interface ReactionsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

const setReactionSchema = z.object({
  reaction: z.enum(['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY']),
});

interface ReactionCursor {
  created_at: string;
  user_id: string;
}

async function fetchReactionState(
  db: Kysely<Database>,
  postId: string,
  callerUserId: string | null,
): Promise<ReactionStateDto> {
  const post = await db
    .selectFrom('social.posts')
    .select('reaction_count')
    .where('id', '=', postId)
    .executeTakeFirst();

  const topRows = await sql<{ reaction: ReactionKind; count: number }>`
    SELECT reaction, count(*)::int AS count
    FROM social.post_reactions
    WHERE post_id = ${postId}::uuid
    GROUP BY reaction
    ORDER BY count DESC, reaction ASC
    LIMIT 3
  `.execute(db);

  let myReaction: ReactionKind | null = null;
  if (callerUserId) {
    const myRow = await db
      .selectFrom('social.post_reactions')
      .select('reaction')
      .where('post_id', '=', postId)
      .where('user_id', '=', callerUserId)
      .executeTakeFirst();
    if (myRow) {
      myReaction = myRow.reaction;
    }
  }

  return {
    post_id: postId,
    my_reaction: myReaction,
    reaction_count: Number(post?.reaction_count ?? 0),
    top_reactions: topRows.rows.map((r) => ({
      reaction: r.reaction,
      count: Number(r.count),
    })),
  };
}

export const reactionsRoute: FastifyPluginAsync<ReactionsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Set reaction
  fastify.put<{ Params: { post_id: string } }>(
    '/v1/posts/:post_id/reaction',
    async (request, reply) => {
      const { post_id } = request.params;
      if (!isValidUuid(post_id)) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const caller = requireAuth(request);

      // Rate limit: 300 changes per hour per user
      await rateLimiter.consume({
        key: buildPostReactionRateLimitKey(caller.userId),
        limit: 300,
        windowSeconds: 3600,
      });

      const parseResult = setReactionSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw ProblemError.badRequest('Invalid reaction kind', undefined, 'INVALID_BODY');
      }

      const { reaction } = parseResult.data;

      const post = await db
        .selectFrom('social.posts')
        .select(['id', 'author_id', 'visibility', 'status'])
        .where('id', '=', post_id)
        .executeTakeFirst();

      if (!post) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const canSee = await canSeePost(
        db,
        caller,
        {
          id: post.id,
          author_id: post.author_id,
          visibility: post.visibility,
          status: post.status,
        },
        { allowHiddenForMods: true },
      );

      if (!canSee) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('social.post_reactions')
          .values({
            post_id,
            user_id: caller.userId,
            reaction,
            created_at: sql`now()`,
          })
          .onConflict((oc) =>
            oc.columns(['post_id', 'user_id']).doUpdateSet({
              reaction,
            }),
          )
          .execute();

        // Notify author if not self
        if (post.author_id !== caller.userId) {
          const suppressed = await shouldSuppressNotification(trx, caller.userId, post.author_id);
          if (!suppressed) {
            await sql`
              INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, created_at)
              VALUES (${uuidv7()}::uuid, ${post.author_id}::uuid, 'POST_REACTION', ${caller.userId}::uuid, ${post_id}::uuid, now())
              ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
              DO NOTHING
            `.execute(trx);
          }
        }
      });

      const state = await fetchReactionState(db, post_id, caller.userId);
      return reply.status(200).send(state);
    },
  );

  // 2. Remove reaction
  fastify.delete<{ Params: { post_id: string } }>(
    '/v1/posts/:post_id/reaction',
    async (request, reply) => {
      const { post_id } = request.params;
      if (!isValidUuid(post_id)) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const caller = requireAuth(request);

      const post = await db
        .selectFrom('social.posts')
        .select(['id', 'author_id', 'visibility', 'status'])
        .where('id', '=', post_id)
        .executeTakeFirst();

      if (!post) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const canSee = await canSeePost(
        db,
        caller,
        {
          id: post.id,
          author_id: post.author_id,
          visibility: post.visibility,
          status: post.status,
        },
        { allowHiddenForMods: true },
      );

      if (!canSee) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      await db
        .deleteFrom('social.post_reactions')
        .where('post_id', '=', post_id)
        .where('user_id', '=', caller.userId)
        .execute();

      const state = await fetchReactionState(db, post_id, caller.userId);
      return reply.status(200).send(state);
    },
  );

  // 3. List reactions
  fastify.get<{
    Params: { post_id: string };
    Querystring: { cursor?: string; limit?: string; reaction?: string };
  }>('/v1/posts/:post_id/reactions', async (request, reply) => {
    const { post_id } = request.params;
    const { cursor, limit, reaction } = request.query;

    if (!isValidUuid(post_id)) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const caller = getCaller(request);

    const post = await db
      .selectFrom('social.posts')
      .select(['id', 'author_id', 'visibility', 'status'])
      .where('id', '=', post_id)
      .executeTakeFirst();

    if (!post) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const canSee = await canSeePost(
      db,
      caller,
      {
        id: post.id,
        author_id: post.author_id,
        visibility: post.visibility,
        status: post.status,
      },
      { allowHiddenForMods: true },
    );

    if (!canSee) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: ReactionCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<ReactionCursor>(cursor);
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
      .selectFrom('social.post_reactions as pr')
      .innerJoin('auth.public_profiles as p', 'p.id', 'pr.user_id')
      .select([
        'pr.user_id',
        'pr.reaction',
        'pr.created_at',
        sql<string>`to_char(pr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('pr.post_id', '=', post_id);

    if (reaction) {
      const validKinds = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'];
      if (!validKinds.includes(reaction)) {
        throw ProblemError.badRequest('Invalid reaction filter', undefined, 'INVALID_QUERY');
      }
      query = query.where('pr.reaction', '=', reaction as ReactionKind);
    }

    // Exclude users in block relations with caller
    if (caller.userId) {
      query = query.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = pr.user_id)
             OR (b.blocker_id = pr.user_id AND b.blocked_id = ${caller.userId})
        )`,
      );
    }

    // Keyset pagination (newest first)
    if (cursorData) {
      query = query.where(
        sql<boolean>`(((pr.created_at < ${cursorData.created_at}::timestamptz) OR (pr.created_at = ${cursorData.created_at}::timestamptz AND pr.user_id < ${cursorData.user_id}::uuid)))`,
      );
    }

    query = query
      .orderBy('pr.created_at', 'desc')
      .orderBy('pr.user_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: ReactionItemDto[] = pageRows.map((r) => {
      const profile = {
        id: r.profile_id,
        handle: r.profile_handle,
        display_name: r.profile_display_name,
        avatar_key: r.profile_avatar_key,
      };

      const createdAtStr =
        (r as { created_at_cursor?: string }).created_at_cursor ||
        new Date(r.created_at).toISOString();

      return {
        user: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        reaction: r.reaction,
        created_at: createdAtStr,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<ReactionCursor>({
        created_at: cursorCreatedAt,
        user_id: last.user_id,
      });
    }

    const response: ReactionPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });
};
