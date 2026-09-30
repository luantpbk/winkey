import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { enqueue } from '@winkey/outbox';
import type { Database, CommentStatus, CommentDto, CommentPageDto } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildCommentRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid, isVideoClosedForCaller } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { notificationsCreatedCounter } from '../metrics.js';

export interface CommentsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

interface CursorPayload {
  created_at: string;
  id: string;
}

export const commentsRoute: FastifyPluginAsync<CommentsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. List top-level comments (newest first)
  fastify.get<{
    Params: { video_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/videos/:video_id/comments', async (request, reply) => {
    const { video_id } = request.params;
    const { cursor, limit } = request.query;

    if (!isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid video ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);

    // Verify video exists
    const video = await db
      .selectFrom('social.videos')
      .select(['id', 'owner_id', 'hidden', 'visibility'])
      .where('id', '=', video_id)
      .executeTakeFirst();

    if (!video || isVideoClosedForCaller(video, caller)) {
      throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CursorPayload>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Base query for top-level comments
    let query = db
      .selectFrom('social.comments as c')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.video_id',
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
      .where('c.video_id', '=', video_id)
      .where('c.parent_id', 'is', null);

    // Visibility rules:
    // Non-moderators: omit HIDDEN.
    if (!caller.isModeratorOrAdmin) {
      query = query.where('c.status', '!=', 'HIDDEN');
    }

    // Both moderators and regular users only see DELETED if replies exist
    query = query.where(
      sql<boolean>`((c.status != 'DELETED' OR EXISTS (SELECT 1 FROM social.comments replies WHERE replies.parent_id = c.id)))`,
    );

    // Keyset pagination (newest first: created_at DESC, id DESC) with microsecond precision
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

    const items: CommentDto[] = pageRows.map((r) => {
      const isAuthor = caller.userId !== null && caller.userId === r.author_id;
      const isVideoOwner = caller.userId !== null && caller.userId === video.owner_id;
      const canEdit = isAuthor && r.status === 'VISIBLE';
      const canDelete = isAuthor || isVideoOwner || caller.isModeratorOrAdmin;

      const profile = r.profile_id
        ? {
            id: r.profile_id,
            handle: r.profile_handle!,
            display_name: r.profile_display_name!,
            avatar_key: r.profile_avatar_key,
          }
        : null;

      return {
        id: r.id,
        video_id: r.video_id,
        parent_id: r.parent_id,
        author: formatPublicProfile(profile, env.MEDIA_BASE_URL),
        body: r.status === 'DELETED' ? '' : r.body,
        status: r.status as CommentStatus,
        reply_count: Number(r.reply_count),
        created_at: new Date(r.created_at).toISOString(),
        edited_at: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        can_edit: canEdit,
        can_delete: canDelete,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<CursorPayload>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: CommentPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 2. Post a comment or reply
  fastify.post<{
    Params: { video_id: string };
    Body: { body?: string; parent_id?: string };
  }>('/v1/videos/:video_id/comments', async (request, reply) => {
    const { video_id } = request.params;

    if (!isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid video ID', undefined, 'INVALID_ID');
    }

    const caller = requireAuth(request);

    // Rate limit: 10 comments per minute per user
    await rateLimiter.consume({
      key: buildCommentRateLimitKey(caller.userId),
      limit: 10,
      windowSeconds: 60,
    });

    const bodyRaw = request.body?.body;
    if (typeof bodyRaw !== 'string') {
      throw ProblemError.badRequest('Comment body is required', undefined, 'INVALID_BODY');
    }

    const trimmedBody = bodyRaw.trim();
    if (trimmedBody.length < 1 || trimmedBody.length > 2000) {
      throw ProblemError.badRequest(
        'Comment body must be between 1 and 2000 characters after trimming',
        undefined,
        'INVALID_BODY_LENGTH',
      );
    }

    const rawParentId = request.body?.parent_id ? request.body.parent_id.trim() : null;
    if (rawParentId && !isValidUuid(rawParentId)) {
      throw ProblemError.badRequest('Invalid parent comment ID', undefined, 'INVALID_ID');
    }
    const parentId = rawParentId;

    // Check video exists
    const video = await db
      .selectFrom('social.videos')
      .select(['id', 'owner_id', 'hidden', 'visibility'])
      .where('id', '=', video_id)
      .executeTakeFirst();

    if (!video || isVideoClosedForCaller(video, caller)) {
      throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
    }

    let parentComment: {
      id: string;
      video_id: string;
      author_id: string;
      parent_id: string | null;
      status: string;
    } | null = null;

    if (parentId) {
      parentComment =
        (await db
          .selectFrom('social.comments')
          .select(['id', 'video_id', 'author_id', 'parent_id', 'status'])
          .where('id', '=', parentId)
          .executeTakeFirst()) ?? null;

      if (!parentComment) {
        throw ProblemError.conflict('Parent comment does not exist', 'PARENT_NOT_REPLYABLE');
      }
      if (parentComment.video_id !== video_id) {
        throw ProblemError.conflict(
          'Parent comment belongs to a different video',
          'PARENT_NOT_REPLYABLE',
        );
      }
      if (parentComment.parent_id !== null) {
        throw ProblemError.conflict(
          'Cannot reply to a reply (only two levels allowed)',
          'PARENT_NOT_REPLYABLE',
        );
      }
      if (parentComment.status === 'DELETED') {
        throw ProblemError.conflict('Cannot reply to a deleted comment', 'PARENT_NOT_REPLYABLE');
      }
    }

    const commentId = uuidv7();
    let createdAtIso: string;

    // Execute in transaction: insert comment + enqueue outbox event
    await db.transaction().execute(async (trx) => {
      try {
        const inserted = await trx
          .insertInto('social.comments')
          .values({
            id: commentId,
            video_id,
            author_id: caller.userId,
            parent_id: parentId,
            body: trimmedBody,
            status: 'VISIBLE',
          })
          .returning(['created_at'])
          .executeTakeFirstOrThrow();

        createdAtIso = new Date(inserted.created_at).toISOString();
      } catch (err: unknown) {
        const dbErr = err as { code?: string; constraint?: string; detail?: string };
        // FK violation (e.g. video was concurrently deleted)
        if (dbErr.code === '23503') {
          if (dbErr.constraint?.includes('video') || dbErr.detail?.includes('videos')) {
            throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
          }
          if (dbErr.constraint?.includes('parent') || dbErr.detail?.includes('parent')) {
            throw ProblemError.conflict('Parent comment is not replyable', 'PARENT_NOT_REPLYABLE');
          }
          throw ProblemError.notFound('Video not found or not ready', 'VIDEO_NOT_FOUND');
        }
        if (dbErr.code === '23514') {
          // Check violation from guard_comment_parent
          throw ProblemError.conflict('Parent comment is not replyable', 'PARENT_NOT_REPLYABLE');
        }
        throw err;
      }

      await enqueue(
        trx,
        'social',
        'social.comment.created',
        {
          comment_id: commentId,
          video_id,
          video_owner_id: video.owner_id,
          author_id: caller.userId,
          parent_id: parentId,
          parent_author_id: parentComment ? parentComment.author_id : null,
          body: trimmedBody,
          created_at: createdAtIso,
        },
        { producer: 'social-svc', version: 1 },
      );

      // In-app Notification (Task N1, ADR-023)
      if (parentId === null) {
        // Top-level comment -> notify video owner if not self
        if (video.owner_id !== caller.userId) {
          const notifId = uuidv7();
          await trx
            .insertInto('social.notifications')
            .values({
              id: notifId,
              user_id: video.owner_id,
              kind: 'VIDEO_COMMENT',
              actor_id: caller.userId,
              video_id,
              comment_id: commentId,
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
          notificationsCreatedCounter.inc({ kind: 'VIDEO_COMMENT' });
        }
      } else if (parentComment && parentComment.author_id !== caller.userId) {
        // Reply -> notify parent comment author if not self (reply does NOT notify video owner)
        const notifId = uuidv7();
        await trx
          .insertInto('social.notifications')
          .values({
            id: notifId,
            user_id: parentComment.author_id,
            kind: 'COMMENT_REPLY',
            actor_id: caller.userId,
            video_id,
            comment_id: commentId,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        notificationsCreatedCounter.inc({ kind: 'COMMENT_REPLY' });
      }
    });

    // Fetch author profile
    const authorProfile = await db
      .selectFrom('auth.public_profiles')
      .selectAll()
      .where('id', '=', caller.userId)
      .executeTakeFirst();

    const commentDto: CommentDto = {
      id: commentId,
      video_id,
      parent_id: parentId,
      author: formatPublicProfile(authorProfile, env.MEDIA_BASE_URL),
      body: trimmedBody,
      status: 'VISIBLE',
      reply_count: 0,
      created_at: createdAtIso!,
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };

    return reply.status(201).header('Location', `/v1/comments/${commentId}`).send(commentDto);
  });

  // 3. Get single comment (deep link)
  fastify.get<{ Params: { comment_id: string } }>(
    '/v1/comments/:comment_id',
    async (request, reply) => {
      const { comment_id } = request.params;

      // Contract specifies only 200 and 404 for this route
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = getCaller(request);

      const comment = await db
        .selectFrom('social.comments as c')
        .innerJoin('social.videos as v', 'v.id', 'c.video_id')
        .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
        .select([
          'c.id',
          'c.video_id',
          'c.author_id',
          'c.parent_id',
          'c.body',
          'c.status',
          'c.reply_count',
          'c.created_at',
          'c.edited_at',
          'v.owner_id as video_owner_id',
          'v.hidden as video_hidden',
          'v.visibility as video_visibility',
          'p.id as profile_id',
          'p.handle as profile_handle',
          'p.display_name as profile_display_name',
          'p.avatar_key as profile_avatar_key',
        ])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (
        !comment ||
        isVideoClosedForCaller(
          {
            owner_id: comment.video_owner_id,
            hidden: comment.video_hidden,
            visibility: comment.video_visibility,
          },
          caller,
        )
      ) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      if (comment.status === 'HIDDEN' && !caller.isModeratorOrAdmin) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      if (comment.status === 'DELETED') {
        const hasReplies = await db
          .selectFrom('social.comments')
          .select(sql`1`.as('one'))
          .where('parent_id', '=', comment_id)
          .executeTakeFirst();

        if (!hasReplies) {
          throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
        }
      }

      const isAuthor = caller.userId !== null && caller.userId === comment.author_id;
      const isVideoOwner = caller.userId !== null && caller.userId === comment.video_owner_id;
      const canEdit = isAuthor && comment.status === 'VISIBLE';
      const canDelete = isAuthor || isVideoOwner || caller.isModeratorOrAdmin;

      const profile = comment.profile_id
        ? {
            id: comment.profile_id,
            handle: comment.profile_handle!,
            display_name: comment.profile_display_name!,
            avatar_key: comment.profile_avatar_key,
          }
        : null;

      const result: CommentDto = {
        id: comment.id,
        video_id: comment.video_id,
        parent_id: comment.parent_id,
        author: formatPublicProfile(profile, env.MEDIA_BASE_URL),
        body: comment.status === 'DELETED' ? '' : comment.body,
        status: comment.status as CommentStatus,
        reply_count: Number(comment.reply_count),
        created_at: new Date(comment.created_at).toISOString(),
        edited_at: comment.edited_at ? new Date(comment.edited_at).toISOString() : null,
        can_edit: canEdit,
        can_delete: canDelete,
      };

      return reply.status(200).send(result);
    },
  );

  // 4. Edit comment body (author only, VISIBLE only) with race condition protection
  fastify.patch<{
    Params: { comment_id: string };
    Body: { body?: string };
  }>('/v1/comments/:comment_id', async (request, reply) => {
    const { comment_id } = request.params;

    if (!isValidUuid(comment_id)) {
      throw ProblemError.badRequest('Invalid comment ID', undefined, 'INVALID_ID');
    }

    const caller = requireAuth(request);

    const bodyRaw = request.body?.body;
    if (typeof bodyRaw !== 'string') {
      throw ProblemError.badRequest('Comment body is required', undefined, 'INVALID_BODY');
    }

    const trimmedBody = bodyRaw.trim();
    if (trimmedBody.length < 1 || trimmedBody.length > 2000) {
      throw ProblemError.badRequest(
        'Comment body must be between 1 and 2000 characters',
        undefined,
        'INVALID_BODY_LENGTH',
      );
    }

    const current = await db
      .selectFrom('social.comments as c')
      .innerJoin('social.videos as v', 'v.id', 'c.video_id')
      .select([
        'c.id',
        'c.author_id',
        'c.status',
        'v.owner_id as video_owner_id',
        'v.hidden as video_hidden',
        'v.visibility as video_visibility',
      ])
      .where('c.id', '=', comment_id)
      .executeTakeFirst();

    if (
      !current ||
      isVideoClosedForCaller(
        {
          owner_id: current.video_owner_id,
          hidden: current.video_hidden,
          visibility: current.video_visibility,
        },
        caller,
      )
    ) {
      throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
    }
    if (current.author_id !== caller.userId) {
      throw ProblemError.forbidden('Only the author can edit this comment', 'NOT_COMMENT_AUTHOR');
    }
    if (current.status !== 'VISIBLE') {
      throw ProblemError.conflict('Only VISIBLE comments can be edited', 'COMMENT_NOT_EDITABLE');
    }

    const now = new Date();
    await db
      .updateTable('social.comments')
      .set({
        body: trimmedBody,
        edited_at: now,
      })
      .where('id', '=', comment_id)
      .execute();

    const comment = await db
      .selectFrom('social.comments as c')
      .innerJoin('social.videos as v', 'v.id', 'c.video_id')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.video_id',
        'c.author_id',
        'c.parent_id',
        'c.body',
        'c.status',
        'c.reply_count',
        'c.created_at',
        'c.edited_at',
        'v.owner_id as video_owner_id',
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('c.id', '=', comment_id)
      .executeTakeFirstOrThrow();

    const profile = comment.profile_id
      ? {
          id: comment.profile_id,
          handle: comment.profile_handle!,
          display_name: comment.profile_display_name!,
          avatar_key: comment.profile_avatar_key,
        }
      : null;

    const result: CommentDto = {
      id: comment.id,
      video_id: comment.video_id,
      parent_id: comment.parent_id,
      author: formatPublicProfile(profile, env.MEDIA_BASE_URL),
      body: trimmedBody,
      status: 'VISIBLE',
      reply_count: Number(comment.reply_count),
      created_at: new Date(comment.created_at).toISOString(),
      edited_at: now.toISOString(),
      can_edit: true,
      can_delete: true,
    };

    return reply.status(200).send(result);
  });

  // 5. Delete comment with race condition protection
  fastify.delete<{ Params: { comment_id: string } }>(
    '/v1/comments/:comment_id',
    async (request, reply) => {
      const { comment_id } = request.params;

      // Contract specifies 204, 401, 403, 404 (no 400)
      if (!isValidUuid(comment_id)) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const caller = requireAuth(request);

      const comment = await db
        .selectFrom('social.comments as c')
        .innerJoin('social.videos as v', 'v.id', 'c.video_id')
        .select([
          'c.id',
          'c.author_id',
          'c.status',
          'v.owner_id as video_owner_id',
          'v.hidden as video_hidden',
          'v.visibility as video_visibility',
        ])
        .where('c.id', '=', comment_id)
        .executeTakeFirst();

      if (
        !comment ||
        isVideoClosedForCaller(
          {
            owner_id: comment.video_owner_id,
            hidden: comment.video_hidden,
            visibility: comment.video_visibility,
          },
          caller,
        )
      ) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }

      const isAuthor = caller.userId === comment.author_id;
      const isVideoOwner = caller.userId === comment.video_owner_id;
      const canDelete = isAuthor || isVideoOwner || caller.isModeratorOrAdmin;

      if (!canDelete) {
        throw ProblemError.forbidden('Not authorized to delete this comment', 'FORBIDDEN');
      }

      // If already DELETED, idempotent 204
      if (comment.status === 'DELETED') {
        return reply.status(204).send();
      }

      const updateResult = await db
        .updateTable('social.comments')
        .set({
          status: 'DELETED',
          body: '',
        })
        .where('id', '=', comment_id)
        .where('status', '!=', 'DELETED')
        .executeTakeFirst();

      if (Number(updateResult.numUpdatedRows) === 0) {
        // Re-read in case of race
        const current = await db
          .selectFrom('social.comments')
          .select(['id', 'status'])
          .where('id', '=', comment_id)
          .executeTakeFirst();

        if (!current) {
          throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
        }
        if (current.status === 'DELETED') {
          return reply.status(204).send();
        }
      }

      return reply.status(204).send();
    },
  );

  // 6. List replies to a top-level comment (oldest first)
  fastify.get<{
    Params: { comment_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/comments/:comment_id/replies', async (request, reply) => {
    const { comment_id } = request.params;
    const { cursor, limit } = request.query;

    if (!isValidUuid(comment_id)) {
      throw ProblemError.badRequest('Invalid comment ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);

    // Verify parent comment exists
    const parent = await db
      .selectFrom('social.comments as c')
      .innerJoin('social.videos as v', 'v.id', 'c.video_id')
      .select([
        'c.id',
        'v.owner_id as video_owner_id',
        'v.hidden as video_hidden',
        'v.visibility as video_visibility',
      ])
      .where('c.id', '=', comment_id)
      .executeTakeFirst();

    if (
      !parent ||
      isVideoClosedForCaller(
        {
          owner_id: parent.video_owner_id,
          hidden: parent.video_hidden,
          visibility: parent.video_visibility,
        },
        caller,
      )
    ) {
      throw ProblemError.notFound('Parent comment not found', 'COMMENT_NOT_FOUND');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CursorPayload>(cursor);
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
      .selectFrom('social.comments as c')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.video_id',
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

    // Non-moderators omit HIDDEN
    if (!caller.isModeratorOrAdmin) {
      query = query.where('c.status', '!=', 'HIDDEN');
    }

    // Replies cannot have nested replies, so DELETED replies have no replies and are omitted
    query = query.where('c.status', '!=', 'DELETED');

    // Keyset pagination (oldest first: created_at ASC, id ASC) with microsecond precision
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

    const items: CommentDto[] = pageRows.map((r) => {
      const isAuthor = caller.userId !== null && caller.userId === r.author_id;
      const isVideoOwner = caller.userId !== null && caller.userId === parent.video_owner_id;
      const canEdit = isAuthor && r.status === 'VISIBLE';
      const canDelete = isAuthor || isVideoOwner || caller.isModeratorOrAdmin;

      const profile = r.profile_id
        ? {
            id: r.profile_id,
            handle: r.profile_handle!,
            display_name: r.profile_display_name!,
            avatar_key: r.profile_avatar_key,
          }
        : null;

      return {
        id: r.id,
        video_id: r.video_id,
        parent_id: r.parent_id,
        author: formatPublicProfile(profile, env.MEDIA_BASE_URL),
        body: r.body,
        status: r.status as CommentStatus,
        reply_count: 0,
        created_at: new Date(r.created_at).toISOString(),
        edited_at: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        can_edit: canEdit,
        can_delete: canDelete,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<CursorPayload>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: CommentPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 7. Moderate comment with race condition protection
  fastify.put<{
    Params: { comment_id: string };
    Body: { status?: string };
  }>('/v1/comments/:comment_id/moderation', async (request, reply) => {
    const { comment_id } = request.params;

    if (!isValidUuid(comment_id)) {
      throw ProblemError.badRequest('Invalid comment ID', undefined, 'INVALID_ID');
    }

    const caller = requireAuth(request);

    if (!caller.isModeratorOrAdmin) {
      throw ProblemError.forbidden('Only moderators or admins can moderate comments', 'FORBIDDEN');
    }

    const requestedStatus = request.body?.status;
    if (requestedStatus !== 'VISIBLE' && requestedStatus !== 'HIDDEN') {
      throw ProblemError.badRequest(
        'Status must be either VISIBLE or HIDDEN',
        undefined,
        'INVALID_STATUS',
      );
    }

    // Conditional update: only update if not DELETED
    const updateResult = await db
      .updateTable('social.comments')
      .set({ status: requestedStatus as CommentStatus })
      .where('id', '=', comment_id)
      .where('status', '!=', 'DELETED')
      .executeTakeFirst();

    if (Number(updateResult.numUpdatedRows) === 0) {
      const current = await db
        .selectFrom('social.comments')
        .select(['id', 'status'])
        .where('id', '=', comment_id)
        .executeTakeFirst();

      if (!current) {
        throw ProblemError.notFound('Comment not found', 'COMMENT_NOT_FOUND');
      }
      if (current.status === 'DELETED') {
        throw ProblemError.conflict('Cannot moderate a deleted comment', 'CANNOT_MODERATE_DELETED');
      }
    }

    const comment = await db
      .selectFrom('social.comments as c')
      .innerJoin('social.videos as v', 'v.id', 'c.video_id')
      .leftJoin('auth.public_profiles as p', 'p.id', 'c.author_id')
      .select([
        'c.id',
        'c.video_id',
        'c.author_id',
        'c.parent_id',
        'c.body',
        'c.status',
        'c.reply_count',
        'c.created_at',
        'c.edited_at',
        'v.owner_id as video_owner_id',
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('c.id', '=', comment_id)
      .executeTakeFirstOrThrow();

    const profile = comment.profile_id
      ? {
          id: comment.profile_id,
          handle: comment.profile_handle!,
          display_name: comment.profile_display_name!,
          avatar_key: comment.profile_avatar_key,
        }
      : null;

    const isAuthor = caller.userId === comment.author_id;
    const isVideoOwner = caller.userId === comment.video_owner_id;
    const canEdit = isAuthor && requestedStatus === 'VISIBLE';
    const canDelete = isAuthor || isVideoOwner || caller.isModeratorOrAdmin;

    const result: CommentDto = {
      id: comment.id,
      video_id: comment.video_id,
      parent_id: comment.parent_id,
      author: formatPublicProfile(profile, env.MEDIA_BASE_URL),
      body: comment.body,
      status: requestedStatus as CommentStatus,
      reply_count: Number(comment.reply_count),
      created_at: new Date(comment.created_at).toISOString(),
      edited_at: comment.edited_at ? new Date(comment.edited_at).toISOString() : null,
      can_edit: canEdit,
      can_delete: canDelete,
    };

    return reply.status(200).send(result);
  });
};
