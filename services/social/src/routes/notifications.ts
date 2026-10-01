import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type {
  Database,
  NotificationDto,
  NotificationPageDto,
  NotificationKind,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';

export interface NotificationsRouteOptions {
  db: Kysely<Database>;
  env: Env;
}

interface NotificationCursor {
  created_at: string;
  id: string;
}

export const notificationsRoute: FastifyPluginAsync<NotificationsRouteOptions> = async (
  fastify,
  { db, env },
) => {
  // 1. List caller's notifications
  fastify.get<{
    Querystring: {
      limit?: string;
      cursor?: string;
      unread?: string | boolean;
    };
  }>('/v1/notifications', async (request, reply) => {
    const caller = requireAuth(request);
    reply.header('Cache-Control', 'private, no-store');

    let limitNum = 24;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw ProblemError.badRequest(
          'Limit must be an integer between 1 and 100',
          undefined,
          'INVALID_LIMIT',
        );
      }
      limitNum = parsed;
    }

    let cursorData: NotificationCursor | null = null;
    if (request.query.cursor) {
      cursorData = decodeCursor<NotificationCursor>(request.query.cursor);
      if (
        !cursorData ||
        typeof cursorData.created_at !== 'string' ||
        typeof cursorData.id !== 'string' ||
        !isValidUuid(cursorData.id)
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    const unreadOnly = request.query.unread === true || request.query.unread === 'true';

    let query = db
      .selectFrom('social.notifications as n')
      .innerJoin('auth.public_profiles as p', 'p.id', 'n.actor_id')
      .leftJoin('social.videos as v', 'v.id', 'n.video_id')
      .leftJoin('social.comments as c', 'c.id', 'n.comment_id')
      .select([
        'n.id',
        'n.kind',
        'n.actor_id',
        'n.video_id',
        'n.comment_id',
        'n.created_at',
        'n.read_at',
        sql<string>`to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
        'p.id as profile_id',
        'p.handle as profile_handle',
        'p.display_name as profile_display_name',
        'p.avatar_key as profile_avatar_key',
      ])
      .where('n.user_id', '=', caller.userId)
      .where(
        sql<boolean>`(n.video_id IS NULL OR (v.id IS NOT NULL AND v.hidden = false AND v.visibility <> 'PRIVATE'))`,
      )
      .where(sql<boolean>`(n.comment_id IS NULL OR (c.id IS NOT NULL AND c.status = 'VISIBLE'))`);

    if (unreadOnly) {
      query = query.where('n.read_at', 'is', null);
    }

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((n.created_at < ${cursorData.created_at}::timestamptz) OR (n.created_at = ${cursorData.created_at}::timestamptz AND n.id < ${cursorData.id}::uuid)))`,
      );
    }

    query = query
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: NotificationDto[] = pageRows.map((r) => {
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
        id: r.id,
        kind: r.kind as NotificationKind,
        actor: formatPublicProfile(profile, env.MEDIA_BASE_URL)!,
        video_id: r.video_id ?? null,
        comment_id: r.comment_id ?? null,
        created_at: createdAtStr,
        read_at: r.read_at ? new Date(r.read_at).toISOString() : null,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<NotificationCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: NotificationPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 2. Unread notification count for badge
  fastify.get('/v1/notifications/unread-count', async (request, reply) => {
    const caller = requireAuth(request);
    reply.header('Cache-Control', 'private, no-store');

    const result = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM (
        SELECT n.id
        FROM social.notifications n
        INNER JOIN auth.public_profiles p ON p.id = n.actor_id
        LEFT JOIN social.videos v ON v.id = n.video_id
        LEFT JOIN social.comments c ON c.id = n.comment_id
        WHERE n.user_id = ${caller.userId}::uuid
          AND n.read_at IS NULL
          AND (n.video_id IS NULL OR (v.id IS NOT NULL AND v.hidden = false AND v.visibility <> 'PRIVATE'))
          AND (n.comment_id IS NULL OR (c.id IS NOT NULL AND c.status = 'VISIBLE'))
        LIMIT 101
      ) sub
    `.execute(db);

    const n = Number(result.rows[0]?.count ?? 0);
    const count = Math.min(n, 100);
    const capped = n > 100;

    return reply.status(200).send({ count, capped });
  });

  // 3. Mark notifications as read
  fastify.post('/v1/notifications/read', async (request, reply) => {
    const caller = requireAuth(request);
    const body = request.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ProblemError.badRequest('Request body must be an object', undefined, 'INVALID_BODY');
    }

    const keys = Object.keys(body);
    const hasIds = 'ids' in body;
    const hasUpTo = 'up_to' in body;

    if (keys.length !== 1 || (!hasIds && !hasUpTo)) {
      throw ProblemError.badRequest(
        'Request body must specify exactly one of "ids" or "up_to", and no additional properties',
        undefined,
        'INVALID_BODY',
      );
    }

    if (hasIds) {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
        throw ProblemError.badRequest(
          '"ids" must be an array of 1 to 100 UUIDs',
          undefined,
          'INVALID_IDS',
        );
      }

      const seen = new Set<string>();
      for (const id of ids) {
        if (typeof id !== 'string' || !isValidUuid(id)) {
          throw ProblemError.badRequest(`Invalid UUID in "ids": ${id}`, undefined, 'INVALID_ID');
        }
        if (seen.has(id)) {
          throw ProblemError.badRequest('Duplicate UUID in "ids"', undefined, 'DUPLICATE_ID');
        }
        seen.add(id);
      }

      await sql`
        UPDATE social.notifications
        SET read_at = now()
        WHERE user_id = ${caller.userId}::uuid
          AND read_at IS NULL
          AND id = ANY(${sql.val(ids)}::uuid[])
      `.execute(db);

      return reply.status(204).send();
    }

    if (hasUpTo) {
      const upTo = body.up_to;
      const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
      if (typeof upTo !== 'string' || !RFC3339_REGEX.test(upTo) || isNaN(Date.parse(upTo))) {
        throw ProblemError.badRequest(
          '"up_to" must be a valid RFC 3339 date-time string',
          undefined,
          'INVALID_DATE',
        );
      }

      await sql`
        UPDATE social.notifications
        SET read_at = now()
        WHERE user_id = ${caller.userId}::uuid
          AND read_at IS NULL
          AND created_at < ${upTo}::timestamptz + interval '1 millisecond'
      `.execute(db);

      return reply.status(204).send();
    }

    return reply.status(204).send();
  });
};
