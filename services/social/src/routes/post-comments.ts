import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, PostCommentDto, PostCommentPageDto, CommentStatus } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildPostCommentRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { canSeePost } from '../utils/visibility.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { isBlockedEitherWay, shouldSuppressNotification } from '../utils/blocks.js';

export interface PostCommentsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

const createPostCommentSchema = z.object({
  body: z.string().min(1).max(2000),
  parent_id: z.string().uuid().optional(),
});

const editPostCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});

const moderatePostCommentSchema = z.object({
  action: z.enum(['HIDE', 'RESTORE']),
});

interface CommentCursor {
  created_at: string;
  id: string;
}

function formatProfileFromRow(
  r: {
    profile_id?: string | null;
    profile_handle?: string | null;
    profile_display_name?: string | null;
    profile_avatar_key?: string | null;
  },
  mediaBaseUrl: string,
) {
  if (!r.profile_id || !r.profile_handle || !r.profile_display_name) return null;
  return formatPublicProfile(
    {
      id: r.profile_id,
      handle: r.profile_handle,
      display_name: r.profile_display_name,
      avatar_key: r.profile_avatar_key ?? null,
    },
    mediaBaseUrl,
  );
}

export const postCommentsRoute: FastifyPluginAsync<PostCommentsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Create Post Comment or Reply
  fastify.post<{ Params: { post_id: string } }>(
    '/v1/posts/:post_id/comments',
    async (request, reply) => {
      const { post_id } = request.params;
      if (!isValidUuid(post_id)) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      const caller = requireAuth(request);

      // Rate limit: 10 comments per minute per user
      await rateLimiter.consume({
        key: buildPostCommentRateLimitKey(caller.userId),
        limit: 10,
        windowSeconds: 60,
      });

      const parseResult = createPostCommentSchema.safeParse(request.body);
      if (!parseResult.success) {
        const fieldErrors = parseResult.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
      }

      const { body, parent_id } = parseResult.data;
      const trimmedBody = body.trim();
      if (trimmedBody.length === 0) {
        throw ProblemError.badRequest(
          'Comment body cannot be empty',
          undefined,
          'VALIDATION_ERROR',
        );
      }

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
        { allowHiddenForMods: false },
      );

      if (!canSee) {
        throw ProblemError.notFound('Post not found', 'POST_NOT_FOUND');
      }

      // Check block with post author
      const blockedWithPostAuthor = await isBlockedEitherWay(db, caller.userId, post.author_id);
      if (blockedWithPostAuthor) {
        throw ProblemError.forbidden('Interaction blocked with post author', 'INTERACTION_BLOCKED');
      }

      let parentAuthorId: string | null = null;
      if (parent_id) {
        const parent = await db
          .selectFrom('social.post_comments')
          .select(['id', 'post_id', 'parent_id', 'author_id', 'status'])
          .where('id', '=', parent_id)
          .executeTakeFirst();

        if (!parent || parent.post_id !== post_id) {
          throw ProblemError.notFound('Parent comment not found', 'COMMENT_NOT_FOUND');
        }

        if (parent.parent_id !== null) {
          throw ProblemError.badRequest(
            'Replies can only be made to top-level comments',
            undefined,
            'INVALID_PARENT',
          );
        }

        if (parent.status === 'DELETED') {
          throw ProblemError.badRequest(
            'Cannot reply to a deleted comment',
            undefined,
            'PARENT_DELETED',
          );
        }

        // Check block with parent author
        const blockedWithParentAuthor = await isBlockedEitherWay(
          db,
          caller.userId,
          parent.author_id,
        );
        if (blockedWithParentAuthor) {
          throw ProblemError.forbidden(
            'Interaction blocked with comment author',
            'INTERACTION_BLOCKED',
          );
        }

        parentAuthorId = parent.author_id;
      }

      const commentId = uuidv7();

      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('social.post_comments')
          .values({
            id: commentId,
            post_id,
            author_id: caller.userId,
            parent_id: parent_id ?? null,
            body: trimmedBody,
            status: 'VISIBLE',
            created_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .execute();

        // Notifications
        if (!parent_id) {
          // Top-level comment -> notify post author
          if (post.author_id !== caller.userId) {
            const suppressed = await shouldSuppressNotification(trx, caller.userId, post.author_id);
            if (!suppressed) {
              await sql`
                INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, post_comment_id, created_at)
                VALUES (${uuidv7()}::uuid, ${post.author_id}::uuid, 'POST_COMMENT', ${caller.userId}::uuid, ${post_id}::uuid, ${commentId}::uuid, now())
                ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
                DO NOTHING
              `.execute(trx);
            }
          }
        } else if (parentAuthorId && parentAuthorId !== caller.userId) {
          // Reply -> notify parent author
          const suppressed = await shouldSuppressNotification(trx, caller.userId, parentAuthorId);
          if (!suppressed) {
            await sql`
              INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, post_comment_id, created_at)
              VALUES (${uuidv7()}::uuid, ${parentAuthorId}::uuid, 'POST_COMMENT_REPLY', ${caller.userId}::uuid, ${post_id}::uuid, ${commentId}::uuid, now())
              ON CONFLICT (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id)
              DO NOTHING
            `.execute(trx);
          }
        }
      });

      // Fetch author profile
      const profile = await db
        .selectFrom('auth.public_profiles')
        .select(['id', 'handle', 'display_name', 'avatar_key'])
        .where('id', '=', caller.userId)
        .executeTakeFirst();

      const commentDto: PostCommentDto = {
        id: commentId,
        post_id,
        parent_id: parent_id ?? null,
        author: profile ? formatPublicProfile(profile, env.MEDIA_BASE_URL) : null,
        body: trimmedBody,
        status: 'VISIBLE',
        reply_count: 0,
        created_at: new Date().toISOString(),
        edited_at: null,
        can_edit: true,
        can_delete: true,
      };

      reply.header('Location', `/v1/post-comments/${commentId}`);
      return reply.status(201).send(commentDto);
    },
  );

  // 2. List top-level post comments (newest first)
  fastify.get<{
    Params: { post_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/posts/:post_id/comments', async (request, reply) => {
    const { post_id } = request.params;
    const { cursor, limit } = request.query;

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

    let cursorData: CommentCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<CommentCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.post_comments as c')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.post_id',
        'c.author_id',
        'c.parent_id',
        'c.body',
        'c.status',
        'c.reply_count',
        'c.created_at',
        'c.edited_at',
        sql<string>`to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('c.post_id', '=', post_id)
      .where('c.parent_id', 'is', null);

    if (!caller.isModeratorOrAdmin) {
      query = query.where('c.status', '!=', 'HIDDEN');
    }

    // Tombstones: show DELETED only if replies exist
    query = query.where(
      sql<boolean>`(c.status != 'DELETED' OR EXISTS (SELECT 1 FROM social.post_comments replies WHERE replies.parent_id = c.id))`,
    );

    // Filter blocked authors
    if (caller.userId) {
      query = query.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = c.author_id)
             OR (b.blocker_id = c.author_id AND b.blocked_id = ${caller.userId})
        )`,
      );
    }

    // Keyset pagination (newest first: created_at DESC, id DESC)
    if (cursorData) {
      query = query.where(
        sql<boolean>`(((c.created_at < ${cursorData.created_at}::timestamptz) OR (c.created_at = ${cursorData.created_at}::timestamptz AND c.id < ${cursorData.id}::uuid)))`,
      );
    }

    query = query
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: PostCommentDto[] = pageRows.map((r) => {
      const isDeleted = r.status === 'DELETED';
      const isAuthor = Boolean(caller.userId && caller.userId === r.author_id);
      const isPostAuthor = Boolean(caller.userId && caller.userId === post.author_id);

      const createdAtStr =
        (r as { created_at_cursor?: string }).created_at_cursor ||
        new Date(r.created_at).toISOString();

      return {
        id: r.id,
        post_id: r.post_id,
        parent_id: r.parent_id,
        author: formatProfileFromRow(r, env.MEDIA_BASE_URL),
        body: isDeleted ? '' : r.body,
        status: r.status as CommentStatus,
        reply_count: Number(r.reply_count || 0),
        created_at: createdAtStr,
        edited_at: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        can_edit: isAuthor && r.status === 'VISIBLE',
        can_delete: isAuthor || isPostAuthor || Boolean(caller.isModeratorOrAdmin),
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<CommentCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: PostCommentPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 3. Get single Post Comment
  fastify.get<{ Params: { comment_id: string } }>(
    '/v1/post-comments/:comment_id',
    async (request, reply) => {
      const { comment_id } = request.params;
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = getCaller(request);

      const comment = await db
        .selectFrom('social.post_comments as c')
        .innerJoin('social.posts as p', 'p.id', 'c.post_id')
        .leftJoin('auth.public_profiles as prof', 'prof.id', 'c.author_id')
        .select([
          'c.id',
          'c.post_id',
          'c.author_id',
          'c.parent_id',
          'c.body',
          'c.status',
          'c.reply_count',
          'c.created_at',
          'c.edited_at',
          'p.author_id as post_author_id',
          'p.visibility as post_visibility',
          'p.status as post_status',
          'prof.id as profile_id',
          'prof.handle as profile_handle',
          'prof.display_name as profile_display_name',
          'prof.avatar_key as profile_avatar_key',
        ])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (!comment) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const canSee = await canSeePost(
        db,
        caller,
        {
          id: comment.post_id,
          author_id: comment.post_author_id,
          visibility: comment.post_visibility,
          status: comment.post_status,
        },
        { allowHiddenForMods: true },
      );

      if (!canSee) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      if (comment.status === 'HIDDEN' && !caller.isModeratorOrAdmin) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const isDeleted = comment.status === 'DELETED';
      const isAuthor = Boolean(caller.userId && caller.userId === comment.author_id);
      const isPostAuthor = Boolean(caller.userId && caller.userId === comment.post_author_id);

      const commentDto: PostCommentDto = {
        id: comment.id,
        post_id: comment.post_id,
        parent_id: comment.parent_id,
        author: formatProfileFromRow(comment, env.MEDIA_BASE_URL),
        body: isDeleted ? '' : comment.body,
        status: comment.status as CommentStatus,
        reply_count: Number(comment.reply_count || 0),
        created_at: new Date(comment.created_at).toISOString(),
        edited_at: comment.edited_at ? new Date(comment.edited_at).toISOString() : null,
        can_edit: isAuthor && comment.status === 'VISIBLE',
        can_delete: isAuthor || isPostAuthor || Boolean(caller.isModeratorOrAdmin),
      };

      return reply.status(200).send(commentDto);
    },
  );

  // 4. Edit Post Comment
  fastify.patch<{ Params: { comment_id: string } }>(
    '/v1/post-comments/:comment_id',
    async (request, reply) => {
      const { comment_id } = request.params;
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = requireAuth(request);

      const parseResult = editPostCommentSchema.safeParse(request.body);
      if (!parseResult.success) {
        const fieldErrors = parseResult.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
      }

      const trimmedBody = parseResult.data.body.trim();
      if (trimmedBody.length === 0) {
        throw ProblemError.badRequest(
          'Comment body cannot be empty',
          undefined,
          'VALIDATION_ERROR',
        );
      }

      const comment = await db
        .selectFrom('social.post_comments as c')
        .innerJoin('social.posts as p', 'p.id', 'c.post_id')
        .select(['c.id', 'c.author_id', 'c.status', 'c.post_id', 'p.author_id as post_author_id'])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (!comment) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      if (comment.author_id !== caller.userId) {
        throw ProblemError.forbidden('Only the author can edit this comment', 'FORBIDDEN');
      }

      if (comment.status !== 'VISIBLE') {
        throw ProblemError.conflict('Comment is not editable in current status', 'INVALID_STATE');
      }

      await db
        .updateTable('social.post_comments')
        .set({
          body: trimmedBody,
          edited_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', comment_id)
        .execute();

      const updated = await db
        .selectFrom('social.post_comments as c')
        .leftJoin('auth.public_profiles as prof', 'prof.id', 'c.author_id')
        .select([
          'c.id',
          'c.post_id',
          'c.parent_id',
          'c.author_id',
          'c.body',
          'c.status',
          'c.reply_count',
          'c.created_at',
          'c.edited_at',
          'prof.id as profile_id',
          'prof.handle as profile_handle',
          'prof.display_name as profile_display_name',
          'prof.avatar_key as profile_avatar_key',
        ])
        .where('c.id', '=', comment_id)
        .executeTakeFirstOrThrow();

      const commentDto: PostCommentDto = {
        id: updated.id,
        post_id: updated.post_id,
        parent_id: updated.parent_id,
        author: formatProfileFromRow(updated, env.MEDIA_BASE_URL),
        body: updated.body,
        status: updated.status as CommentStatus,
        reply_count: Number(updated.reply_count || 0),
        created_at: new Date(updated.created_at).toISOString(),
        edited_at: updated.edited_at ? new Date(updated.edited_at).toISOString() : null,
        can_edit: true,
        can_delete: true,
      };

      return reply.status(200).send(commentDto);
    },
  );

  // 5. Delete Post Comment
  fastify.delete<{ Params: { comment_id: string } }>(
    '/v1/post-comments/:comment_id',
    async (request, reply) => {
      const { comment_id } = request.params;
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = requireAuth(request);

      const comment = await db
        .selectFrom('social.post_comments as c')
        .innerJoin('social.posts as p', 'p.id', 'c.post_id')
        .select(['c.id', 'c.author_id', 'c.status', 'p.author_id as post_author_id'])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (!comment) {
        return reply.status(204).send();
      }

      const canDelete =
        caller.userId === comment.author_id ||
        caller.userId === comment.post_author_id ||
        caller.isModeratorOrAdmin;

      if (!canDelete) {
        throw ProblemError.forbidden('Forbidden', 'FORBIDDEN');
      }

      if (comment.status === 'DELETED') {
        return reply.status(204).send();
      }

      await db
        .updateTable('social.post_comments')
        .set({
          status: 'DELETED',
          body: '',
          updated_at: sql`now()`,
        })
        .where('id', '=', comment_id)
        .execute();

      return reply.status(204).send();
    },
  );

  // 6. List Replies (oldest first)
  fastify.get<{
    Params: { comment_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/post-comments/:comment_id/replies', async (request, reply) => {
    const { comment_id } = request.params;
    const { cursor, limit } = request.query;

    if (!isValidUuid(comment_id)) {
      throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
    }

    const caller = getCaller(request);

    const parent = await db
      .selectFrom('social.post_comments as c')
      .innerJoin('social.posts as p', 'p.id', 'c.post_id')
      .select([
        'c.id',
        'c.post_id',
        'c.parent_id',
        'p.author_id as post_author_id',
        'p.visibility as post_visibility',
        'p.status as post_status',
      ])
      .where('c.id', '=', comment_id)
      .executeTakeFirst();

    if (!parent) {
      throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
    }

    const canSee = await canSeePost(
      db,
      caller,
      {
        id: parent.post_id,
        author_id: parent.post_author_id,
        visibility: parent.post_visibility,
        status: parent.post_status,
      },
      { allowHiddenForMods: true },
    );

    if (!canSee) {
      throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CommentCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<CommentCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.post_comments as c')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.post_id',
        'c.author_id',
        'c.parent_id',
        'c.body',
        'c.status',
        'c.reply_count',
        'c.created_at',
        'c.edited_at',
        sql<string>`to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('c.parent_id', '=', comment_id);

    if (!caller.isModeratorOrAdmin) {
      query = query.where('c.status', '!=', 'HIDDEN');
    }

    // Replies list does not show DELETED replies
    query = query.where('c.status', '!=', 'DELETED');

    if (caller.userId) {
      query = query.where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM social.blocks b
          WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = c.author_id)
             OR (b.blocker_id = c.author_id AND b.blocked_id = ${caller.userId})
        )`,
      );
    }

    // Keyset pagination (oldest first: created_at ASC, id ASC)
    if (cursorData) {
      query = query.where(
        sql<boolean>`(((c.created_at > ${cursorData.created_at}::timestamptz) OR (c.created_at = ${cursorData.created_at}::timestamptz AND c.id > ${cursorData.id}::uuid)))`,
      );
    }

    query = query
      .orderBy('c.created_at', 'asc')
      .orderBy('c.id', 'asc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: PostCommentDto[] = pageRows.map((r) => {
      const isAuthor = Boolean(caller.userId && caller.userId === r.author_id);
      const isPostAuthor = Boolean(caller.userId && caller.userId === parent.post_author_id);

      const createdAtStr =
        (r as { created_at_cursor?: string }).created_at_cursor ||
        new Date(r.created_at).toISOString();

      return {
        id: r.id,
        post_id: r.post_id,
        parent_id: r.parent_id,
        author: formatProfileFromRow(r, env.MEDIA_BASE_URL),
        body: r.body,
        status: r.status as CommentStatus,
        reply_count: Number(r.reply_count || 0),
        created_at: createdAtStr,
        edited_at: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        can_edit: isAuthor && r.status === 'VISIBLE',
        can_delete: isAuthor || isPostAuthor || Boolean(caller.isModeratorOrAdmin),
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<CommentCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: PostCommentPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 7. Moderate Post Comment
  fastify.put<{ Params: { comment_id: string } }>(
    '/v1/post-comments/:comment_id/moderation',
    async (request, reply) => {
      const { comment_id } = request.params;
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = requireAuth(request);
      if (!caller.isModeratorOrAdmin) {
        throw ProblemError.forbidden('Forbidden', 'FORBIDDEN');
      }

      const parseResult = moderatePostCommentSchema.safeParse(request.body);
      if (!parseResult.success) {
        const fieldErrors = parseResult.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        throw ProblemError.badRequest('Validation failed', fieldErrors, 'INVALID_BODY');
      }

      const comment = await db
        .selectFrom('social.post_comments as c')
        .innerJoin('social.posts as p', 'p.id', 'c.post_id')
        .select(['c.id', 'c.author_id', 'c.status', 'c.post_id', 'p.author_id as post_author_id'])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (!comment) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      if (comment.status === 'DELETED') {
        throw ProblemError.conflict('Cannot moderate a deleted comment', 'COMMENT_DELETED');
      }

      const newStatus: CommentStatus = parseResult.data.action === 'HIDE' ? 'HIDDEN' : 'VISIBLE';

      await db
        .updateTable('social.post_comments')
        .set({
          status: newStatus,
          updated_at: sql`now()`,
        })
        .where('id', '=', comment_id)
        .execute();

      const updated = await db
        .selectFrom('social.post_comments as c')
        .leftJoin('auth.public_profiles as prof', 'prof.id', 'c.author_id')
        .select([
          'c.id',
          'c.post_id',
          'c.parent_id',
          'c.author_id',
          'c.body',
          'c.status',
          'c.reply_count',
          'c.created_at',
          'c.edited_at',
          'prof.id as profile_id',
          'prof.handle as profile_handle',
          'prof.display_name as profile_display_name',
          'prof.avatar_key as profile_avatar_key',
        ])
        .where('c.id', '=', comment_id)
        .executeTakeFirstOrThrow();

      const commentDto: PostCommentDto = {
        id: updated.id,
        post_id: updated.post_id,
        parent_id: updated.parent_id,
        author: formatProfileFromRow(updated, env.MEDIA_BASE_URL),
        body: updated.body,
        status: updated.status as CommentStatus,
        reply_count: Number(updated.reply_count || 0),
        created_at: new Date(updated.created_at).toISOString(),
        edited_at: updated.edited_at ? new Date(updated.edited_at).toISOString() : null,
        can_edit: updated.author_id === caller.userId && updated.status === 'VISIBLE',
        can_delete:
          updated.author_id === caller.userId ||
          comment.post_author_id === caller.userId ||
          Boolean(caller.isModeratorOrAdmin),
      };

      return reply.status(200).send(commentDto);
    },
  );
};
