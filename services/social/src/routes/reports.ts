import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type {
  Database,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  ModerationCaseDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildReportRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';

export interface ReportsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

const createReportSchema = z.object({
  target_type: z.enum(['VIDEO', 'COMMENT', 'USER']),
  target_id: z.string().uuid(),
  reason: z.enum([
    'SPAM',
    'HARASSMENT',
    'HATE',
    'SEXUAL',
    'VIOLENCE',
    'COPYRIGHT',
    'MISINFORMATION',
    'OTHER',
  ]),
  note: z.string().max(500).optional().default(''),
});

const resolveCaseSchema = z.object({
  status: z.enum(['ACTIONED', 'DISMISSED']),
  note: z.string().max(500).optional(),
});

interface CaseCursorPayload {
  time: string;
  id: string;
}

export const reportsRoute: FastifyPluginAsync<ReportsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. Create report (any signed-in user)
  fastify.post('/v1/reports', async (request, reply) => {
    const caller = requireAuth(request);

    // Rate limit: 20 per hour per user
    await rateLimiter.consume({
      key: buildReportRateLimitKey(caller.userId),
      limit: 20,
      windowSeconds: 3600,
    });

    const parseResult = createReportSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'INVALID_BODY');
    }

    const { target_type, target_id, reason, note } = parseResult.data;

    // Validate target existence and visibility
    if (target_type === 'VIDEO') {
      const video = await db
        .selectFrom('social.videos')
        .select(['id', 'owner_id', 'hidden'])
        .where('id', '=', target_id)
        .executeTakeFirst();

      if (!video || (video.hidden && !caller.isModeratorOrAdmin)) {
        throw ProblemError.notFound('Video not found or not visible', 'TARGET_NOT_FOUND');
      }
      if (video.owner_id === caller.userId) {
        throw ProblemError.badRequest(
          'Cannot report your own video',
          undefined,
          'CANNOT_REPORT_OWN_CONTENT',
        );
      }
    } else if (target_type === 'COMMENT') {
      const comment = await db
        .selectFrom('social.comments as c')
        .innerJoin('social.videos as v', 'v.id', 'c.video_id')
        .select(['c.id', 'c.author_id', 'c.status', 'v.hidden as video_hidden'])
        .where('c.id', '=', target_id)
        .executeTakeFirst();

      if (
        !comment ||
        comment.status !== 'VISIBLE' ||
        (comment.video_hidden && !caller.isModeratorOrAdmin)
      ) {
        throw ProblemError.notFound('Comment not found or not visible', 'TARGET_NOT_FOUND');
      }
      if (comment.author_id === caller.userId) {
        throw ProblemError.badRequest(
          'Cannot report your own comment',
          undefined,
          'CANNOT_REPORT_OWN_CONTENT',
        );
      }
    } else if (target_type === 'USER') {
      const user = await db
        .selectFrom('auth.public_profiles')
        .select('id')
        .where('id', '=', target_id)
        .executeTakeFirst();

      if (!user) {
        throw ProblemError.notFound('User not found', 'TARGET_NOT_FOUND');
      }
      if (target_id === caller.userId) {
        throw ProblemError.badRequest('Cannot report yourself', undefined, 'CANNOT_REPORT_SELF');
      }
    }

    // Insert with partial unique index (reporter_id, target_type, target_id) WHERE status = 'OPEN'
    const reportId = uuidv7();
    const insertRes = await db
      .insertInto('social.reports')
      .values({
        id: reportId,
        reporter_id: caller.userId,
        target_type,
        target_id,
        reason,
        note: note || '',
        status: 'OPEN',
      })
      .onConflict((oc) =>
        oc
          .columns(['reporter_id', 'target_type', 'target_id'])
          .where('status', '=', 'OPEN')
          .doNothing(),
      )
      .returning([
        'id',
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
      ])
      .executeTakeFirst();

    if (insertRes) {
      return reply.status(201).send({
        id: insertRes.id,
        created_at: insertRes.created_at_iso,
      });
    }

    // Duplicate OPEN report: retrieve existing and return 200
    const existing = await db
      .selectFrom('social.reports')
      .select([
        'id',
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
      ])
      .where('reporter_id', '=', caller.userId)
      .where('target_type', '=', target_type)
      .where('target_id', '=', target_id)
      .where('status', '=', 'OPEN')
      .executeTakeFirstOrThrow();

    return reply.status(200).send({
      id: existing.id,
      created_at: existing.created_at_iso,
    });
  });

  // 2. Moderation queue (moderator or admin)
  fastify.get<{
    Querystring: {
      status?: ReportStatus;
      target_type?: ReportTargetType;
      cursor?: string;
      limit?: string;
    };
  }>('/v1/moderation/reports', async (request, reply) => {
    const caller = requireAuth(request);
    if (!caller.isModeratorOrAdmin) {
      throw ProblemError.forbidden('Requires moderator or admin role');
    }

    const { cursor, limit } = request.query;
    const status: ReportStatus = request.query.status || 'OPEN';
    const targetType = request.query.target_type;

    if (request.query.status && !['OPEN', 'ACTIONED', 'DISMISSED'].includes(request.query.status)) {
      throw ProblemError.badRequest('Invalid status filter', undefined, 'INVALID_STATUS');
    }
    if (targetType && !['VIDEO', 'COMMENT', 'USER'].includes(targetType)) {
      throw ProblemError.badRequest('Invalid target_type filter', undefined, 'INVALID_TARGET_TYPE');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CaseCursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CaseCursorPayload>(cursor);
      if (!cursorData || !cursorData.time || !cursorData.id || !isValidUuid(cursorData.id)) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let groupQuery = db
      .selectFrom('social.reports')
      .select([
        'target_type',
        'target_id',
        'status',
        sql<number>`count(*) filter (where status = 'OPEN')::int`.as('open_count'),
        sql<string>`to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'first_reported_at_iso',
        ),
        sql<
          string | null
        >`to_char(max(resolved_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'resolved_at_iso',
        ),
        sql<string | null>`max(resolved_by::text)`.as('resolved_by'),
        sql<string | null>`max(resolution_note)`.as('resolution_note'),
      ])
      .where('status', '=', status)
      .groupBy(['target_type', 'target_id', 'status']);

    if (targetType) {
      groupQuery = groupQuery.where('target_type', '=', targetType);
    }

    if (status === 'OPEN') {
      if (cursorData) {
        groupQuery = groupQuery.having((eb) =>
          eb.or([
            sql<boolean>`min(created_at) > ${cursorData.time}::timestamptz`,
            sql<boolean>`(min(created_at) = ${cursorData.time}::timestamptz AND target_id > ${cursorData.id}::uuid)`,
          ]),
        );
      }
      groupQuery = groupQuery
        .orderBy(sql`min(created_at)`, 'asc')
        .orderBy('target_id', 'asc')
        .limit(limitNum + 1);
    } else {
      if (cursorData) {
        groupQuery = groupQuery.having((eb) =>
          eb.or([
            sql<boolean>`max(resolved_at) < ${cursorData.time}::timestamptz`,
            sql<boolean>`(max(resolved_at) = ${cursorData.time}::timestamptz AND target_id < ${cursorData.id}::uuid)`,
          ]),
        );
      }
      groupQuery = groupQuery
        .orderBy(sql`max(resolved_at)`, 'desc')
        .orderBy('target_id', 'desc')
        .limit(limitNum + 1);
    }

    const groupRows = await groupQuery.execute();
    const hasMore = groupRows.length > limitNum;
    const pageGroups = hasMore ? groupRows.slice(0, limitNum) : groupRows;

    const items: ModerationCaseDto[] = [];

    for (const g of pageGroups) {
      // 1. Fetch reasons histogram for this target and status
      const reasonsRows = await db
        .selectFrom('social.reports')
        .select(['reason', sql<number>`count(*)::int`.as('count')])
        .where('target_type', '=', g.target_type)
        .where('target_id', '=', g.target_id)
        .where('status', '=', g.status)
        .groupBy('reason')
        .execute();

      const reasons: Record<string, number> = {};
      for (const r of reasonsRows) {
        reasons[r.reason] = Number(r.count);
      }

      // 2. Fetch the 5 most recent reports with reporter profiles
      const recentReports = await db
        .selectFrom('social.reports as r')
        .leftJoin('auth.public_profiles as p', 'p.id', 'r.reporter_id')
        .select([
          'r.id',
          'r.reason',
          'r.note',
          'r.status',
          sql<string>`to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'created_at_iso',
          ),
          'p.id as profile_id',
          'p.handle as profile_handle',
          'p.display_name as profile_display_name',
          'p.avatar_key as profile_avatar_key',
        ])
        .where('r.target_type', '=', g.target_type)
        .where('r.target_id', '=', g.target_id)
        .where('r.status', '=', g.status)
        .orderBy('r.created_at', 'desc')
        .limit(5)
        .execute();

      const reportsList = recentReports.map((rep) => ({
        id: rep.id,
        reporter: rep.profile_id
          ? formatPublicProfile(
              {
                id: rep.profile_id,
                handle: rep.profile_handle!,
                display_name: rep.profile_display_name!,
                avatar_key: rep.profile_avatar_key,
              },
              env.MEDIA_BASE_URL,
            )
          : null,
        reason: rep.reason as ReportReason,
        note: rep.note,
        status: rep.status as ReportStatus,
        created_at: rep.created_at_iso,
      }));

      const resolution =
        g.status === 'OPEN' || !g.resolved_by || !g.resolved_at_iso
          ? null
          : {
              resolved_by: g.resolved_by,
              note: g.resolution_note,
              resolved_at: g.resolved_at_iso,
            };

      items.push({
        target_type: g.target_type as ReportTargetType,
        target_id: g.target_id,
        status: g.status as ReportStatus,
        open_count: Number(g.open_count),
        first_reported_at: g.first_reported_at_iso,
        reasons,
        reports: reportsList,
        resolution,
      });
    }

    let nextCursor: string | null = null;
    if (hasMore && pageGroups.length > 0) {
      const last = pageGroups[pageGroups.length - 1];
      const timeVal = status === 'OPEN' ? last.first_reported_at_iso : last.resolved_at_iso;
      if (timeVal) {
        nextCursor = encodeCursor<CaseCursorPayload>({
          time: timeVal,
          id: last.target_id,
        });
      }
    }

    return reply.status(200).send({
      items,
      next_cursor: nextCursor,
    });
  });

  // 3. Resolve moderation case (moderator or admin)
  fastify.put<{
    Params: { target_type: string; target_id: string };
  }>('/v1/moderation/cases/:target_type/:target_id/resolution', async (request, reply) => {
    const caller = requireAuth(request);
    if (!caller.isModeratorOrAdmin) {
      throw ProblemError.forbidden('Requires moderator or admin role');
    }

    const { target_type, target_id } = request.params;
    if (!['VIDEO', 'COMMENT', 'USER'].includes(target_type)) {
      throw ProblemError.badRequest('Invalid target_type', undefined, 'INVALID_TARGET_TYPE');
    }
    if (!isValidUuid(target_id)) {
      throw ProblemError.badRequest('Invalid target_id', undefined, 'INVALID_ID');
    }

    const parseResult = resolveCaseSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'INVALID_BODY');
    }

    const { status, note } = parseResult.data;
    const now = new Date();

    const updateResult = await db
      .updateTable('social.reports')
      .set({
        status,
        resolved_by: caller.userId,
        resolution_note: note ?? null,
        resolved_at: now,
      })
      .where('target_type', '=', target_type as ReportTargetType)
      .where('target_id', '=', target_id)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();

    const resolvedCount = Number(updateResult.numUpdatedRows);
    if (resolvedCount === 0) {
      throw ProblemError.notFound('No open reports found for target', 'CASE_NOT_FOUND');
    }

    return reply.status(200).send({
      resolved_count: resolvedCount,
    });
  });
};
