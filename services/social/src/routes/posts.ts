import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, PostStatus, PostVisibility } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildPostCreateRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { enqueue } from '@winkey/outbox';
import { getCaller, requireAuth, isValidUuid, isVideoClosedForCaller } from '../utils/auth.js';
import { canSeePost } from '../utils/visibility.js';
import { extractCandidates, resolveHashtags, resolveMentions } from '../utils/text-parser.js';
import { hydratePostsBatch, type RawPostRow } from '../utils/post-builder.js';
import { shouldSuppressNotification } from '../utils/blocks.js';
import type { Redis } from 'ioredis';

export interface PostsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
  redis?: Redis | null;
}

const createPostSchema = z.object({
  body: z.string().optional().default(''),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS']).optional().default('PUBLIC'),
  image_ids: z.array(z.string().uuid()).max(10).optional(),
  video_id: z.string().uuid().optional(),
  reshare_of: z.string().uuid().optional(),
});

const editPostSchema = z.object({
  body: z.string().optional(),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS']).optional(),
});

const moderatePostSchema = z.object({
  status: z.enum(['HIDDEN', 'VISIBLE']),
});

export const postsRoute: FastifyPluginAsync<PostsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter, redis },
) => {
  // 1. Create Post
  fastify.post('/v1/posts', async (request, reply) => {
    const caller = requireAuth(request);

    // Rate limit: 30 posts per hour per user
    await rateLimiter.consume({
      key: buildPostCreateRateLimitKey(caller.userId),
      limit: 30,
      windowSeconds: 3600,
    });

    const parseResult = createPostSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
    }

    const { body, visibility, image_ids, video_id, reshare_of } = parseResult.data;
    const trimmedBody = body.trim();

    // Mutual exclusivity
    const hasImages = Boolean(image_ids && image_ids.length > 0);
    const hasVideo = Boolean(video_id);
    const hasReshare = Boolean(reshare_of);

    const attachmentCount = (hasImages ? 1 : 0) + (hasVideo ? 1 : 0) + (hasReshare ? 1 : 0);
    if (attachmentCount > 1) {
      throw ProblemError.badRequest(
        'image_ids, video_id and reshare_of are mutually exclusive',
        undefined,
        'VALIDATION_ERROR',
      );
    }

    if (trimmedBody.length === 0 && attachmentCount === 0) {
      throw ProblemError.badRequest(
        'Post body cannot be empty without an attachment',
        undefined,
        'VALIDATION_ERROR',
      );
    }

    if (trimmedBody.length > 2000) {
      throw ProblemError.badRequest(
        'Post body cannot exceed 2000 characters',
        undefined,
        'VALIDATION_ERROR',
      );
    }

    // Check caller's profile
    const callerProfile = await db
      .selectFrom('auth.public_profiles')
      .select(['id', 'is_private'])
      .where('id', '=', caller.userId)
      .executeTakeFirst();

    if (!callerProfile) {
      throw ProblemError.forbidden('Caller profile not found', 'FORBIDDEN');
    }

    const isCallerPrivate = Boolean(callerProfile.is_private);
    let effectiveVisibility: PostVisibility = visibility;

    if (hasReshare) {
      if (visibility === 'FOLLOWERS') {
        throw ProblemError.badRequest('A reshare must be PUBLIC', undefined, 'VALIDATION_ERROR');
      }
      if (isCallerPrivate) {
        throw ProblemError.conflict('Private accounts cannot create reshares', 'NOT_RESHAREABLE');
      }
      effectiveVisibility = 'PUBLIC';
    } else if (isCallerPrivate) {
      effectiveVisibility = 'FOLLOWERS';
    }

    // Validate Images
    let readyImages: Array<{
      id: string;
      image_key: string;
      thumb_key: string;
      width: number;
      height: number;
    }> = [];

    if (hasImages && image_ids) {
      if (new Set(image_ids).size !== image_ids.length) {
        throw ProblemError.badRequest('Duplicate image_ids in request', undefined, 'IMAGE_INVALID');
      }

      readyImages = await db
        .selectFrom('media.ready_images')
        .select(['id', 'image_key', 'thumb_key', 'width', 'height'])
        .where('id', 'in', image_ids)
        .where('owner_id', '=', caller.userId)
        .where('purpose', '=', 'POST')
        .execute();

      if (readyImages.length !== image_ids.length) {
        throw ProblemError.badRequest(
          'One or more images are invalid, not ready, or not owned by caller',
          undefined,
          'IMAGE_INVALID',
        );
      }

      const alreadyUsed = await db
        .selectFrom('social.post_media')
        .select('image_id')
        .where('image_id', 'in', image_ids)
        .execute();

      if (alreadyUsed.length > 0) {
        throw ProblemError.badRequest(
          'One or more images are already used in a post',
          undefined,
          'IMAGE_INVALID',
        );
      }
    }

    // Validate Video
    let isVideoSocial = false;
    if (hasVideo && video_id) {
      const video = await db
        .selectFrom('social.videos')
        .select(['id', 'owner_id', 'hidden', 'visibility', 'purpose'])
        .where('id', '=', video_id)
        .executeTakeFirst();

      if (!video || video.hidden) {
        throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
      }

      if (video.purpose === 'SOCIAL') {
        // Security: Check ownership FIRST before checking in-use (404 instead of 403/409 to prevent enumeration)
        if (video.owner_id !== caller.userId) {
          throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
        }

        if (video.visibility === 'PRIVATE') {
          throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
        }

        // Pre-check if this social video is already attached to an active post
        const activeAttachment = await db
          .selectFrom('social.posts')
          .select('id')
          .where('video_id', '=', video.id)
          .where('video_social', '=', true)
          .where('status', '<>', 'DELETED')
          .executeTakeFirst();

        if (activeAttachment) {
          throw ProblemError.conflict(
            'This social video is already attached to an active post',
            'VIDEO_IN_USE',
          );
        }

        isVideoSocial = true;
      } else {
        if (isVideoClosedForCaller(video, caller)) {
          throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
        }
        isVideoSocial = false;
      }
    }

    // Validate Reshare
    let targetOriginalId: string | null = null;
    let targetOriginalAuthorId: string | null = null;

    if (hasReshare && reshare_of) {
      const target = await db
        .selectFrom('social.posts')
        .selectAll()
        .where('id', '=', reshare_of)
        .executeTakeFirst();

      if (!target) {
        throw ProblemError.notFound('Target post not found', 'POST_NOT_FOUND');
      }

      const originalId = target.reshare_of || target.id;
      const original =
        target.reshare_of && target.reshare_of !== target.id
          ? await db
              .selectFrom('social.posts')
              .selectAll()
              .where('id', '=', originalId)
              .executeTakeFirst()
          : target;

      if (!original) {
        throw ProblemError.notFound('Target post not found', 'POST_NOT_FOUND');
      }

      const canSee = await canSeePost(
        db,
        caller,
        {
          id: original.id,
          author_id: original.author_id,
          visibility: original.visibility,
          status: original.status,
        },
        { allowHiddenForMods: false },
      );

      if (!canSee) {
        throw ProblemError.notFound('Target post not found', 'POST_NOT_FOUND');
      }

      const origAuthorProfile = await db
        .selectFrom('auth.public_profiles')
        .select(['id', 'is_private'])
        .where('id', '=', original.author_id)
        .executeTakeFirst();

      if (
        !origAuthorProfile ||
        origAuthorProfile.is_private ||
        original.status !== 'VISIBLE' ||
        original.visibility !== 'PUBLIC'
      ) {
        throw ProblemError.conflict(
          'Only public posts by public accounts can be reshared',
          'NOT_RESHAREABLE',
        );
      }

      targetOriginalId = original.id;
      targetOriginalAuthorId = original.author_id;

      // Check plain reshare duplicate
      const isPlainReshare = trimmedBody === '' && !hasImages && !hasVideo;
      if (isPlainReshare) {
        const existingPlain = await db
          .selectFrom('social.posts')
          .select('id')
          .where('author_id', '=', caller.userId)
          .where('reshare_of', '=', targetOriginalId)
          .where('status', '=', 'VISIBLE')
          .where('body', '=', '')
          .where('media_count', '=', 0)
          .where('video_id', 'is', null)
          .executeTakeFirst();

        if (existingPlain) {
          throw ProblemError.conflict(
            'You have already reshared this post without text',
            'ALREADY_RESHARED',
          );
        }
      }
    }

    // Parse mentions and candidate hashtags
    const { rawHandles, rawTags } = extractCandidates(trimmedBody);
    const resolvedMentions = await resolveMentions(db, caller.userId, rawHandles);
    const resolvedHashtags = await resolveHashtags(db, rawTags);

    const postId = uuidv7();

    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('social.posts')
          .values({
            id: postId,
            author_id: caller.userId,
            body: trimmedBody,
            visibility: effectiveVisibility,
            status: 'VISIBLE',
            video_id: video_id ?? null,
            video_social: isVideoSocial,
            reshare_of: targetOriginalId,
            media_count: readyImages.length,
            created_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .execute();

        if (isVideoSocial && video_id) {
          await enqueue(
            trx,
            'social',
            'social.post.video_attached',
            {
              post_id: postId,
              video_id: video_id,
              author_id: caller.userId,
            },
            { producer: 'social-svc', version: 1 },
          );
        }

        if (readyImages.length > 0 && image_ids) {
          const imageMap = new Map(readyImages.map((img) => [img.id, img]));
          const mediaRows = image_ids.map((id, index) => {
            const img = imageMap.get(id)!;
            return {
              post_id: postId,
              position: index,
              image_id: img.id,
              image_key: img.image_key,
              thumb_key: img.thumb_key,
              width: img.width,
              height: img.height,
            };
          });

          await trx.insertInto('social.post_media').values(mediaRows).execute();
        }

        if (resolvedMentions.length > 0) {
          await trx
            .insertInto('social.post_mentions')
            .values(
              resolvedMentions.map((m) => ({
                post_id: postId,
                user_id: m.userId,
              })),
            )
            .execute();
        }

        if (resolvedHashtags.length > 0) {
          await trx
            .insertInto('social.post_hashtags')
            .values(
              resolvedHashtags.map((h) => ({
                post_id: postId,
                tag: h.tag,
                created_at: sql`now()`,
              })),
            )
            .execute();
        }

        // Reshare notification to original author
        if (targetOriginalAuthorId && targetOriginalAuthorId !== caller.userId) {
          const suppressed = await shouldSuppressNotification(
            trx,
            caller.userId,
            targetOriginalAuthorId,
          );
          if (!suppressed) {
            await sql`
              INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, created_at)
              VALUES (${uuidv7()}::uuid, ${targetOriginalAuthorId}::uuid, 'POST_RESHARE', ${caller.userId}::uuid, ${postId}::uuid, now())
              ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
              DO NOTHING
            `.execute(trx);
          }
        }

        // Mention notifications
        for (const m of resolvedMentions) {
          const canSee = await canSeePost(
            trx,
            { userId: m.userId, roles: [], isModeratorOrAdmin: false },
            {
              id: postId,
              author_id: caller.userId,
              visibility: effectiveVisibility,
              status: 'VISIBLE',
            },
          );
          if (canSee) {
            const suppressed = await shouldSuppressNotification(trx, caller.userId, m.userId);
            if (!suppressed) {
              await sql`
                INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, created_at)
                VALUES (${uuidv7()}::uuid, ${m.userId}::uuid, 'POST_MENTION', ${caller.userId}::uuid, ${postId}::uuid, now())
                ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
                DO NOTHING
              `.execute(trx);
            }
          }
        }
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string; message?: string };
      if (pgErr.code === '23505') {
        if (
          pgErr.constraint === 'posts_one_per_social_video' ||
          pgErr.message?.includes('posts_one_per_social_video')
        ) {
          throw ProblemError.conflict(
            'This social video is already attached to an active post',
            'VIDEO_IN_USE',
          );
        }
        if (hasImages) {
          throw ProblemError.badRequest('Image already used in a post', undefined, 'IMAGE_INVALID');
        }
        if (hasReshare) {
          throw ProblemError.conflict(
            'You have already reshared this post without text',
            'ALREADY_RESHARED',
          );
        }
      }
      throw err;
    }

    // Invalidate following feed cache for author
    if (redis) {
      await redis.del(`social:feed:following:${caller.userId}:first_page`).catch(() => {});
    }

    // Fetch and hydrate newly created post
    const rawPost = await db
      .selectFrom('social.posts')
      .selectAll()
      .where('id', '=', postId)
      .executeTakeFirstOrThrow();

    const [postDto] = await hydratePostsBatch(db, [rawPost as RawPostRow], caller, env);

    reply.header('Location', `/v1/posts/${postId}`);
    return reply.status(201).send(postDto);
  });

  // 2. Get Post
  fastify.get<{ Params: { post_id: string } }>('/v1/posts/:post_id', async (request, reply) => {
    const { post_id } = request.params;
    if (!isValidUuid(post_id)) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const caller = getCaller(request);

    const post = await db
      .selectFrom('social.posts')
      .selectAll()
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

    const [postDto] = await hydratePostsBatch(db, [post as RawPostRow], caller, env);
    if (!postDto) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    return reply.status(200).send(postDto);
  });

  // 3. Edit Post
  fastify.patch<{ Params: { post_id: string } }>('/v1/posts/:post_id', async (request, reply) => {
    const { post_id } = request.params;
    if (!isValidUuid(post_id)) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const caller = requireAuth(request);

    const parseResult = editPostSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
    }

    const post = await db
      .selectFrom('social.posts')
      .selectAll()
      .where('id', '=', post_id)
      .executeTakeFirst();

    if (!post) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    if (post.author_id !== caller.userId) {
      throw ProblemError.forbidden('Only the author can edit this post', 'FORBIDDEN');
    }

    if (post.status !== 'VISIBLE') {
      throw ProblemError.conflict('Post is not editable in current status', 'INVALID_STATE');
    }

    const { body, visibility } = parseResult.data;

    if (post.reshare_of && visibility === 'FOLLOWERS') {
      throw ProblemError.conflict(
        'A reshare cannot have FOLLOWERS visibility',
        'RESHARE_VISIBILITY',
      );
    }

    let nextBody = post.body;
    let bodyChanged = false;

    if (body !== undefined) {
      const trimmed = body.trim();
      if (trimmed.length === 0 && post.media_count === 0 && !post.video_id && !post.reshare_of) {
        throw ProblemError.badRequest(
          'Post body cannot be empty without an attachment',
          undefined,
          'VALIDATION_ERROR',
        );
      }
      if (trimmed.length > 2000) {
        throw ProblemError.badRequest(
          'Post body cannot exceed 2000 characters',
          undefined,
          'VALIDATION_ERROR',
        );
      }
      if (post.reshare_of && trimmed === '' && post.media_count === 0 && !post.video_id) {
        // Editing to plain reshare: ensure no other plain reshare exists
        const existingPlain = await db
          .selectFrom('social.posts')
          .select('id')
          .where('author_id', '=', caller.userId)
          .where('reshare_of', '=', post.reshare_of)
          .where('status', '=', 'VISIBLE')
          .where('body', '=', '')
          .where('media_count', '=', 0)
          .where('video_id', 'is', null)
          .where('id', '!=', post.id)
          .executeTakeFirst();

        if (existingPlain) {
          throw ProblemError.conflict(
            'You already have a plain reshare of this post',
            'ALREADY_RESHARED',
          );
        }
      }

      nextBody = trimmed;
      bodyChanged = nextBody !== post.body;
    }

    const nextVisibility = visibility !== undefined ? visibility : post.visibility;

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('social.posts')
        .set({
          body: nextBody,
          visibility: nextVisibility,
          edited_at: bodyChanged ? sql`now()` : post.edited_at,
          updated_at: sql`now()`,
        })
        .where('id', '=', post_id)
        .execute();

      if (bodyChanged) {
        // Re-parse mentions & hashtags
        const oldMentions = await trx
          .selectFrom('social.post_mentions')
          .select('user_id')
          .where('post_id', '=', post_id)
          .execute();

        const oldMentionSet = new Set(oldMentions.map((m) => m.user_id));

        await trx.deleteFrom('social.post_mentions').where('post_id', '=', post_id).execute();
        await trx.deleteFrom('social.post_hashtags').where('post_id', '=', post_id).execute();

        const { rawHandles, rawTags } = extractCandidates(nextBody);
        const resolvedMentions = await resolveMentions(trx, caller.userId, rawHandles);
        const resolvedHashtags = await resolveHashtags(trx, rawTags);

        if (resolvedMentions.length > 0) {
          await trx
            .insertInto('social.post_mentions')
            .values(
              resolvedMentions.map((m) => ({
                post_id: post_id,
                user_id: m.userId,
              })),
            )
            .execute();
        }

        if (resolvedHashtags.length > 0) {
          await trx
            .insertInto('social.post_hashtags')
            .values(
              resolvedHashtags.map((h) => ({
                post_id: post_id,
                tag: h.tag,
                created_at: post.created_at,
              })),
            )
            .execute();
        }

        // Notify only newly mentioned users
        for (const m of resolvedMentions) {
          if (!oldMentionSet.has(m.userId)) {
            const canSee = await canSeePost(
              trx,
              { userId: m.userId, roles: [], isModeratorOrAdmin: false },
              {
                id: post_id,
                author_id: caller.userId,
                visibility: nextVisibility,
                status: 'VISIBLE',
              },
            );
            if (canSee) {
              const suppressed = await shouldSuppressNotification(trx, caller.userId, m.userId);
              if (!suppressed) {
                await sql`
                  INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, created_at)
                  VALUES (${uuidv7()}::uuid, ${m.userId}::uuid, 'POST_MENTION', ${caller.userId}::uuid, ${post_id}::uuid, now())
                  ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
                  DO NOTHING
                `.execute(trx);
              }
            }
          }
        }
      }
    });

    const updatedPost = await db
      .selectFrom('social.posts')
      .selectAll()
      .where('id', '=', post_id)
      .executeTakeFirstOrThrow();

    const [postDto] = await hydratePostsBatch(db, [updatedPost as RawPostRow], caller, env);
    return reply.status(200).send(postDto);
  });

  // 4. Delete Post
  fastify.delete<{ Params: { post_id: string } }>('/v1/posts/:post_id', async (request, reply) => {
    const { post_id } = request.params;
    if (!isValidUuid(post_id)) {
      throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
    }

    const caller = requireAuth(request);

    const post = await db
      .selectFrom('social.posts')
      .select(['id', 'author_id', 'status', 'video_id', 'video_social'])
      .where('id', '=', post_id)
      .executeTakeFirst();

    if (!post) {
      return reply.status(204).send();
    }

    const canDelete = caller.userId === post.author_id || caller.isModeratorOrAdmin;
    if (!canDelete) {
      throw ProblemError.forbidden('Forbidden', 'FORBIDDEN');
    }

    if (post.status === 'DELETED') {
      return reply.status(204).send();
    }

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('social.posts')
        .set({
          status: 'DELETED',
          body: '',
          updated_at: sql`now()`,
        })
        .where('id', '=', post_id)
        .execute();

      await trx.deleteFrom('social.post_media').where('post_id', '=', post_id).execute();
      await trx.deleteFrom('social.post_reactions').where('post_id', '=', post_id).execute();
      await trx.deleteFrom('social.post_hashtags').where('post_id', '=', post_id).execute();
      await trx.deleteFrom('social.post_mentions').where('post_id', '=', post_id).execute();
      await trx.deleteFrom('social.post_scores').where('post_id', '=', post_id).execute();
      // Keep social.post_comments intact!

      if (post.video_social && post.video_id) {
        await enqueue(
          trx,
          'social',
          'social.post.video_released',
          {
            post_id: post.id,
            video_id: post.video_id,
            author_id: post.author_id,
          },
          { producer: 'social-svc', version: 1 },
        );
      }
    });

    if (redis) {
      await redis.del(`social:feed:following:${post.author_id}:first_page`).catch(() => {});
    }

    return reply.status(204).send();
  });

  // 5. Moderate Post
  fastify.put<{ Params: { post_id: string } }>(
    '/v1/posts/:post_id/moderation',
    async (request, reply) => {
      const { post_id } = request.params;
      if (!isValidUuid(post_id)) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const caller = requireAuth(request);
      if (!caller.isModeratorOrAdmin) {
        throw ProblemError.forbidden('Forbidden', 'FORBIDDEN');
      }

      const parseResult = moderatePostSchema.safeParse(request.body);
      if (!parseResult.success) {
        const fieldErrors = parseResult.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        throw ProblemError.badRequest('Validation failed', fieldErrors, 'INVALID_BODY');
      }

      const post = await db
        .selectFrom('social.posts')
        .selectAll()
        .where('id', '=', post_id)
        .executeTakeFirst();

      if (!post) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      if (post.status === 'DELETED') {
        throw ProblemError.conflict('Cannot moderate a deleted post', 'POST_DELETED');
      }

      const newStatus: PostStatus = parseResult.data.status;

      if (post.status !== newStatus) {
        await db
          .updateTable('social.posts')
          .set({
            status: newStatus,
            updated_at: sql`now()`,
          })
          .where('id', '=', post_id)
          .execute();

        if (newStatus === 'HIDDEN') {
          await db.deleteFrom('social.post_scores').where('post_id', '=', post_id).execute();
          if (redis) {
            await redis.del(`social:feed:following:${post.author_id}:first_page`).catch(() => {});
          }
        }
      }

      const updated = await db
        .selectFrom('social.posts')
        .selectAll()
        .where('id', '=', post_id)
        .executeTakeFirstOrThrow();

      const [postDto] = await hydratePostsBatch(db, [updated as RawPostRow], caller, env);
      return reply.status(200).send(postDto);
    },
  );
};
