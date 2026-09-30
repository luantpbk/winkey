import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { enqueue } from '@winkey/outbox';
import type { Database, LikeStateDto } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildLikeRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';

export interface LikesRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

export const likesRoute: FastifyPluginAsync<LikesRouteOptions> = async (
  fastify,
  { db, rateLimiter },
) => {
  // 1. Get like status
  fastify.get<{ Params: { video_id: string } }>(
    '/v1/videos/:video_id/like',
    async (request, reply) => {
      const { video_id } = request.params;

      // Contract specifies only 200 and 404
      if (!isValidUuid(video_id)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      const caller = getCaller(request);

      const video = await db
        .selectFrom('social.videos')
        .select(['id', 'like_count', 'hidden'])
        .where('id', '=', video_id)
        .executeTakeFirst();

      if (!video || (video.hidden && !caller.isModeratorOrAdmin)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      let liked = false;
      if (caller.userId) {
        const likeRecord = await db
          .selectFrom('social.video_likes')
          .select(sql`1`.as('one'))
          .where('video_id', '=', video_id)
          .where('user_id', '=', caller.userId)
          .executeTakeFirst();
        liked = !!likeRecord;
      }

      const response: LikeStateDto = {
        video_id,
        liked,
        like_count: Number(video.like_count),
      };

      return reply.status(200).send(response);
    },
  );

  // 2. Like a video (idempotent PUT)
  fastify.put<{ Params: { video_id: string } }>(
    '/v1/videos/:video_id/like',
    async (request, reply) => {
      const { video_id } = request.params;

      // Contract specifies only 200, 401, 404, 429
      if (!isValidUuid(video_id)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      const caller = requireAuth(request);

      // Rate limit: 60/min per user
      await rateLimiter.consume({
        key: buildLikeRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 60,
      });

      const video = await db
        .selectFrom('social.videos')
        .select(['id', 'like_count', 'hidden'])
        .where('id', '=', video_id)
        .executeTakeFirst();

      if (!video || (video.hidden && !caller.isModeratorOrAdmin)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      let currentLikeCount = Number(video.like_count);

      try {
        await db.transaction().execute(async (trx) => {
          const insertResult = await sql<{ inserted: number }>`
          INSERT INTO social.video_likes (video_id, user_id)
          VALUES (${video_id}, ${caller.userId})
          ON CONFLICT (video_id, user_id) DO NOTHING
          RETURNING 1 as inserted
        `.execute(trx);

          const wasInserted = insertResult.rows.length > 0;

          const updatedVideo = await trx
            .selectFrom('social.videos')
            .select('like_count')
            .where('id', '=', video_id)
            .executeTakeFirstOrThrow();

          currentLikeCount = Number(updatedVideo.like_count);

          if (wasInserted) {
            await enqueue(
              trx,
              'social',
              'social.video.like_changed',
              {
                video_id,
                user_id: caller.userId,
                liked: true,
                like_count: currentLikeCount,
              },
              { producer: 'social-svc', version: 1 },
            );
          }
        });
      } catch (err: unknown) {
        const dbErr = err as { code?: string; name?: string };
        if (dbErr.code === '23503' || dbErr.name === 'NoResultError') {
          throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
        }
        throw err;
      }

      const response: LikeStateDto = {
        video_id,
        liked: true,
        like_count: currentLikeCount,
      };

      return reply.status(200).send(response);
    },
  );

  // 3. Unlike a video (idempotent DELETE)
  fastify.delete<{ Params: { video_id: string } }>(
    '/v1/videos/:video_id/like',
    async (request, reply) => {
      const { video_id } = request.params;

      // Contract specifies only 200, 401, 404, 429
      if (!isValidUuid(video_id)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      const caller = requireAuth(request);

      // Rate limit: 60/min per user
      await rateLimiter.consume({
        key: buildLikeRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 60,
      });

      const video = await db
        .selectFrom('social.videos')
        .select(['id', 'like_count', 'hidden'])
        .where('id', '=', video_id)
        .executeTakeFirst();

      if (!video || (video.hidden && !caller.isModeratorOrAdmin)) {
        throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
      }

      let currentLikeCount = Number(video.like_count);

      try {
        await db.transaction().execute(async (trx) => {
          const deleteResult = await sql<{ deleted: number }>`
          DELETE FROM social.video_likes
          WHERE video_id = ${video_id} AND user_id = ${caller.userId}
          RETURNING 1 as deleted
        `.execute(trx);

          const wasDeleted = deleteResult.rows.length > 0;

          const updatedVideo = await trx
            .selectFrom('social.videos')
            .select('like_count')
            .where('id', '=', video_id)
            .executeTakeFirstOrThrow();

          currentLikeCount = Number(updatedVideo.like_count);

          if (wasDeleted) {
            await enqueue(
              trx,
              'social',
              'social.video.like_changed',
              {
                video_id,
                user_id: caller.userId,
                liked: false,
                like_count: currentLikeCount,
              },
              { producer: 'social-svc', version: 1 },
            );
          }
        });
      } catch (err: unknown) {
        const dbErr = err as { code?: string; name?: string };
        if (dbErr.code === '23503' || dbErr.name === 'NoResultError') {
          throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
        }
        throw err;
      }

      const response: LikeStateDto = {
        video_id,
        liked: false,
        like_count: currentLikeCount,
      };

      return reply.status(200).send(response);
    },
  );
};
