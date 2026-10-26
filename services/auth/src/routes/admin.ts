import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { ProblemError } from '../errors/problem.js';
import { verifyAccessToken } from '../crypto/jwt.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { enforceRbac } from '../utils/rbac.js';
import type { Env } from '../config/env.js';
import type { Database, Role, UserStatus, CreatorRequestStatus } from '../db/types.js';
import type { RevocationService } from '../revocation/revocation.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id.trim());
}

interface Caller {
  id: string;
  roles: Role[];
}

function parseRoles(raw?: string | string[]): Role[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw.flatMap((r) => r.split(',')) : raw.split(',');
  return list.map((r) => r.trim()).filter(Boolean) as Role[];
}

async function getCaller(request: FastifyRequest, env: Env): Promise<Caller> {
  const xUserId = request.headers['x-user-id'];
  const xUserRoles = request.headers['x-user-roles'];

  if (typeof xUserId === 'string' && xUserId.trim().length > 0 && isValidUuid(xUserId.trim())) {
    return {
      id: xUserId.trim(),
      roles: parseRoles(xUserRoles as string),
    };
  }

  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const claims = await verifyAccessToken(token, env);
      return {
        id: claims.sub,
        roles: (claims.roles || []) as Role[],
      };
    } catch {
      throw ProblemError.unauthorized('Invalid or expired token');
    }
  }

  throw ProblemError.unauthorized('Authentication required');
}

function formatAdminUser(
  user: {
    id: string;
    email: string;
    email_verified_at: Date | string | null;
    handle: string;
    display_name: string;
    avatar_key: string | null;
    roles: Role[];
    status: UserStatus;
    suspended_until: Date | string | null;
    suspension_reason: string | null;
    created_at_iso?: string;
    created_at?: Date | string;
  },
  env: Env,
) {
  return {
    id: user.id,
    email: user.email,
    email_verified: user.email_verified_at != null,
    handle: user.handle,
    display_name: user.display_name,
    avatar_url: user.avatar_key ? `${env.MEDIA_BASE_URL}/${user.avatar_key}` : null,
    roles: user.roles,
    status: user.status,
    suspended_until: user.suspended_until ? new Date(user.suspended_until).toISOString() : null,
    suspension_reason: user.suspension_reason ?? null,
    created_at: user.created_at_iso || new Date(user.created_at!).toISOString(),
  };
}

interface CursorPayload {
  created_at: string;
  id: string;
}

interface CreatorRequestCursorPayload {
  s: 'PENDING' | 'APPROVED' | 'REJECTED';
  t: string;
  id: string;
}

const creatorRequestStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);

const decideCreatorRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.decision === 'REJECT') {
      if (!data.note || data.note.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Note is required when rejecting a creator request',
          path: ['note'],
        });
      }
    }
  });

const setRolesSchema = z.object({
  roles: z
    .array(z.enum(['viewer', 'creator', 'moderator', 'admin']))
    .min(1)
    .refine((roles) => roles.includes('viewer'), {
      message: 'Roles must include viewer',
    })
    .refine((roles) => new Set(roles).size === roles.length, {
      message: 'Roles must be unique',
    }),
});

const suspendUserSchema = z.object({
  reason: z.string().min(1).max(500),
  until: z.string().datetime().nullable().optional(),
});

export const adminRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  revocationService: RevocationService;
}> = async (fastify, { db, env, revocationService }) => {
  // 1. List users (moderator or admin)
  fastify.get<{
    Querystring: {
      q?: string;
      role?: Role;
      status?: UserStatus;
      cursor?: string;
      limit?: string;
    };
  }>('/v1/admin/users', async (request, reply) => {
    const caller = await getCaller(request, env);
    enforceRbac({ actorRoles: caller.roles, action: 'LIST_USERS' });

    const { q, role, status, cursor, limit } = request.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CursorPayload>(cursor);
      if (!cursorData || !cursorData.created_at || !cursorData.id) {
        throw ProblemError.badRequest('Invalid cursor');
      }
    }

    let query = db
      .selectFrom('auth.users')
      .select([
        'id',
        'email',
        'email_verified_at',
        'handle',
        'display_name',
        'avatar_key',
        'roles',
        'status',
        'suspended_until',
        'suspension_reason',
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
      ]);

    if (q && q.trim()) {
      const term = q.trim();
      const escapedTerm = term.replace(/[\\%_]/g, '\\$&');
      query = query.where((eb) =>
        eb.or([
          sql<boolean>`email ILIKE ${escapedTerm + '%'}`,
          sql<boolean>`handle ILIKE ${escapedTerm + '%'}`,
          sql<boolean>`display_name % ${term}`,
        ]),
      );
    }

    if (role) {
      query = query.where(sql<boolean>`${role} = ANY(roles)`);
    }

    if (status) {
      query = query.where('status', '=', status);
    }

    if (cursorData) {
      query = query.where(
        sql<boolean>`(created_at < ${cursorData.created_at}::timestamptz OR (created_at = ${cursorData.created_at}::timestamptz AND id < ${cursorData.id}::uuid))`,
      );
    }

    query = query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasNext = rows.length > limitNum;
    const items = hasNext ? rows.slice(0, limitNum) : rows;

    let nextCursor: string | null = null;
    if (hasNext && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor<CursorPayload>({
        created_at: last.created_at_iso,
        id: last.id,
      });
    }

    return reply.status(200).send({
      items: items.map((u) => formatAdminUser(u, env)),
      next_cursor: nextCursor,
    });
  });

  // 2. Get user (moderator or admin)
  fastify.get<{
    Params: { user_id: string };
  }>('/v1/admin/users/:user_id', async (request, reply) => {
    const caller = await getCaller(request, env);
    enforceRbac({ actorRoles: caller.roles, action: 'GET_USER' });

    const { user_id } = request.params;
    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID');
    }

    const user = await db
      .selectFrom('auth.users')
      .select([
        'id',
        'email',
        'email_verified_at',
        'handle',
        'display_name',
        'avatar_key',
        'roles',
        'status',
        'suspended_until',
        'suspension_reason',
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
      ])
      .where('id', '=', user_id)
      .executeTakeFirst();

    if (!user) {
      throw ProblemError.notFound('User not found');
    }

    return reply.status(200).send(formatAdminUser(user, env));
  });

  // 3. Set user roles (admin only)
  fastify.put<{
    Params: { user_id: string };
  }>('/v1/admin/users/:user_id/roles', async (request, reply) => {
    const caller = await getCaller(request, env);

    const { user_id } = request.params;
    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID');
    }

    enforceRbac({
      actorRoles: caller.roles,
      action: 'CHANGE_ROLES',
      isSelf: caller.id === user_id,
    });

    const parseResult = setRolesSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors);
    }

    const newRoles = parseResult.data.roles as Role[];
    const result = await db.transaction().execute(async (trx) => {
      const lockedTarget = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .forUpdate()
        .executeTakeFirst();

      if (!lockedTarget) {
        throw ProblemError.notFound('User not found');
      }
      if (lockedTarget.status === 'DELETED') {
        throw ProblemError.conflict('User is deleted');
      }

      enforceRbac({
        actorRoles: caller.roles,
        action: 'CHANGE_ROLES',
        targetRoles: lockedTarget.roles,
        isSelf: caller.id === user_id,
      });

      const currentSorted = [...lockedTarget.roles].sort();
      const newSorted = [...newRoles].sort();
      const isSame =
        currentSorted.length === newSorted.length &&
        currentSorted.every((r, idx) => r === newSorted[idx]);

      if (isSame) {
        // Idempotent: return without audit row
        return { user: lockedTarget, changed: false };
      }

      // Safeguard: cannot remove the last admin
      if (lockedTarget.roles.includes('admin') && !newRoles.includes('admin')) {
        await sql`SELECT pg_advisory_xact_lock(hashtext('auth.last_admin'))`.execute(trx);
        const adminCountRes = await trx
          .selectFrom('auth.users')
          .select(sql<number>`count(*)::int`.as('cnt'))
          .where(sql<boolean>`'admin' = ANY(roles)`)
          .where('status', '!=', 'DELETED')
          .executeTakeFirst();
        if (Number(adminCountRes?.cnt ?? 0) <= 1) {
          throw ProblemError.conflict('Cannot remove the last admin', 'LAST_ADMIN');
        }
      }

      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          roles: newRoles,
          updated_at: now,
        })
        .where('id', '=', user_id)
        .execute();

      await trx
        .insertInto('auth.audit_log')
        .values({
          id: uuidv7(),
          actor_id: caller.id,
          action: 'USER_ROLES_CHANGED',
          target_user_id: user_id,
          details: JSON.stringify({
            from: lockedTarget.roles,
            to: newRoles,
          }),
        })
        .execute();

      const updated = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .executeTakeFirstOrThrow();

      return { user: updated, changed: true };
    });

    if (result.changed) {
      // Revoke user in Valkey AFTER DB commit (fail-safe)
      await revocationService.revokeUser(user_id);
    }

    return reply.status(200).send(formatAdminUser(result.user, env));
  });

  // 4. Suspend user (moderator or admin)
  fastify.put<{
    Params: { user_id: string };
  }>('/v1/admin/users/:user_id/suspension', async (request, reply) => {
    const caller = await getCaller(request, env);

    const { user_id } = request.params;
    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID');
    }

    enforceRbac({
      actorRoles: caller.roles,
      action: 'SUSPEND_USER',
      isSelf: caller.id === user_id,
    });

    const parseResult = suspendUserSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors);
    }

    const { reason, until } = parseResult.data;
    let untilDate: Date | null = null;
    if (until) {
      untilDate = new Date(until);
      if (untilDate <= new Date()) {
        throw ProblemError.badRequest('Suspension expiry must be in the future');
      }
    }

    const result = await db.transaction().execute(async (trx) => {
      const lockedTarget = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .forUpdate()
        .executeTakeFirst();

      if (!lockedTarget) {
        throw ProblemError.notFound('User not found');
      }
      if (lockedTarget.status === 'DELETED') {
        throw ProblemError.conflict('User is deleted');
      }

      enforceRbac({
        actorRoles: caller.roles,
        action: 'SUSPEND_USER',
        targetRoles: lockedTarget.roles,
        isSelf: caller.id === user_id,
      });

      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          status: 'SUSPENDED',
          suspension_reason: reason,
          suspended_until: untilDate,
          updated_at: now,
        })
        .where('id', '=', user_id)
        .execute();

      // Revoke all active refresh-token families for user
      await trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', user_id)
        .where('revoked_at', 'is', null)
        .execute();

      await trx
        .insertInto('auth.audit_log')
        .values({
          id: uuidv7(),
          actor_id: caller.id,
          action: 'USER_SUSPENDED',
          target_user_id: user_id,
          details: JSON.stringify({
            reason,
            until: untilDate ? untilDate.toISOString() : null,
          }),
        })
        .execute();

      return await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .executeTakeFirstOrThrow();
    });

    // Revoke user in Valkey AFTER DB commit (fail-safe)
    await revocationService.revokeUser(user_id);

    return reply.status(200).send(formatAdminUser(result, env));
  });

  // 5. Unsuspend user (moderator or admin)
  fastify.delete<{
    Params: { user_id: string };
  }>('/v1/admin/users/:user_id/suspension', async (request, reply) => {
    const caller = await getCaller(request, env);

    const { user_id } = request.params;
    if (!isValidUuid(user_id)) {
      throw ProblemError.badRequest('Invalid user ID');
    }

    const result = await db.transaction().execute(async (trx) => {
      const lockedTarget = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .forUpdate()
        .executeTakeFirst();

      if (!lockedTarget) {
        throw ProblemError.notFound('User not found');
      }
      if (lockedTarget.status === 'DELETED') {
        throw ProblemError.conflict('User is deleted');
      }

      enforceRbac({
        actorRoles: caller.roles,
        action: 'UNSUSPEND_USER',
        targetRoles: lockedTarget.roles,
        isSelf: caller.id === user_id,
      });

      if (lockedTarget.status === 'ACTIVE') {
        // Idempotent: return 200 without audit row
        return lockedTarget;
      }

      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          status: 'ACTIVE',
          suspension_reason: null,
          suspended_until: null,
          updated_at: now,
        })
        .where('id', '=', user_id)
        .execute();

      await trx
        .insertInto('auth.audit_log')
        .values({
          id: uuidv7(),
          actor_id: caller.id,
          action: 'USER_UNSUSPENDED',
          target_user_id: user_id,
          details: JSON.stringify({}),
        })
        .execute();

      return await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', user_id)
        .executeTakeFirstOrThrow();
    });

    return reply.status(200).send(formatAdminUser(result, env));
  });

  // 6. List audit log (admin only)
  fastify.get<{
    Querystring: {
      target_user_id?: string;
      cursor?: string;
      limit?: string;
    };
  }>('/v1/admin/audit-log', async (request, reply) => {
    const caller = await getCaller(request, env);
    enforceRbac({ actorRoles: caller.roles, action: 'VIEW_AUDIT_LOG' });

    const { target_user_id, cursor, limit } = request.query;
    if (target_user_id && !isValidUuid(target_user_id)) {
      throw ProblemError.badRequest('Invalid target_user_id');
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CursorPayload>(cursor);
      if (!cursorData || !cursorData.created_at || !cursorData.id) {
        throw ProblemError.badRequest('Invalid cursor');
      }
    }

    let query = db
      .selectFrom('auth.audit_log')
      .leftJoin('auth.public_profiles', 'auth.audit_log.actor_id', 'auth.public_profiles.id')
      .select([
        'auth.audit_log.id',
        'auth.audit_log.actor_id',
        'auth.audit_log.action',
        'auth.audit_log.target_user_id',
        'auth.audit_log.details',
        sql<string>`to_char(auth.audit_log.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
        'auth.public_profiles.handle as actor_handle',
        'auth.public_profiles.display_name as actor_display_name',
        'auth.public_profiles.avatar_key as actor_avatar_key',
      ]);

    if (target_user_id) {
      query = query.where('auth.audit_log.target_user_id', '=', target_user_id);
    }

    if (cursorData) {
      query = query.where(
        sql<boolean>`(auth.audit_log.created_at < ${cursorData.created_at}::timestamptz OR (auth.audit_log.created_at = ${cursorData.created_at}::timestamptz AND auth.audit_log.id < ${cursorData.id}::uuid))`,
      );
    }

    query = query
      .orderBy('auth.audit_log.created_at', 'desc')
      .orderBy('auth.audit_log.id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasNext = rows.length > limitNum;
    const items = hasNext ? rows.slice(0, limitNum) : rows;

    let nextCursor: string | null = null;
    if (hasNext && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor<CursorPayload>({
        created_at: last.created_at_iso,
        id: last.id,
      });
    }

    const formattedItems = items.map((row) => ({
      id: row.id,
      actor: {
        id: row.actor_id,
        handle: row.actor_handle || 'unknown',
        display_name: row.actor_display_name || 'Unknown User',
        avatar_url: row.actor_avatar_key ? `${env.MEDIA_BASE_URL}/${row.actor_avatar_key}` : null,
      },
      action: row.action,
      target_user_id: row.target_user_id,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      created_at: row.created_at_iso,
    }));

    return reply.status(200).send({
      items: formattedItems,
      next_cursor: nextCursor,
    });
  });

  // 7. List creator requests (admin only, task ROLE1, ADR-046)
  fastify.get<{
    Querystring: {
      status?: string;
      cursor?: string;
      limit?: string;
    };
  }>('/v1/admin/creator-requests', async (request, reply) => {
    const caller = await getCaller(request, env);
    enforceRbac({ actorRoles: caller.roles, action: 'LIST_CREATOR_REQUESTS' });

    const { status, cursor, limit } = request.query;
    let targetStatus: CreatorRequestStatus = 'PENDING';
    if (status !== undefined) {
      const parsedStatus = creatorRequestStatusSchema.safeParse(status);
      if (!parsedStatus.success) {
        throw ProblemError.badRequest('Invalid status parameter');
      }
      targetStatus = parsedStatus.data;
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '24', 10) || 24));

    let cursorData: CreatorRequestCursorPayload | null = null;
    if (cursor) {
      cursorData = decodeCursor<CreatorRequestCursorPayload>(cursor);
      if (
        !cursorData ||
        cursorData.s !== targetStatus ||
        !cursorData.t ||
        !cursorData.id ||
        !isValidUuid(cursorData.id)
      ) {
        throw ProblemError.badRequest('Invalid cursor');
      }
    }

    let query = db
      .selectFrom('auth.creator_requests as cr')
      .innerJoin('auth.users as u', 'u.id', 'cr.user_id')
      .leftJoin('auth.public_profiles as decider', 'decider.id', 'cr.decided_by')
      .select([
        'cr.id',
        'cr.status',
        'cr.message',
        'cr.decision_note',
        sql<string>`to_char(cr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_iso',
        ),
        sql<string>`to_char(cr.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'decided_at_iso',
        ),
        'u.id as user_id',
        'u.email as user_email',
        'u.email_verified_at as user_email_verified_at',
        'u.handle as user_handle',
        'u.display_name as user_display_name',
        'u.avatar_key as user_avatar_key',
        'u.roles as user_roles',
        'u.status as user_status',
        'u.suspended_until as user_suspended_until',
        'u.suspension_reason as user_suspension_reason',
        sql<string>`to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'user_created_at_iso',
        ),
        'decider.id as decider_id',
        'decider.handle as decider_handle',
        'decider.display_name as decider_display_name',
        'decider.avatar_key as decider_avatar_key',
      ])
      .where('cr.status', '=', targetStatus);

    if (targetStatus === 'PENDING') {
      if (cursorData) {
        query = query.where(
          sql<boolean>`(cr.created_at > ${cursorData.t}::timestamptz OR (cr.created_at = ${cursorData.t}::timestamptz AND cr.id > ${cursorData.id}::uuid))`,
        );
      }
      query = query
        .orderBy('cr.created_at', 'asc')
        .orderBy('cr.id', 'asc')
        .limit(limitNum + 1);
    } else {
      if (cursorData) {
        query = query.where(
          sql<boolean>`(cr.decided_at < ${cursorData.t}::timestamptz OR (cr.decided_at = ${cursorData.t}::timestamptz AND cr.id < ${cursorData.id}::uuid))`,
        );
      }
      query = query
        .orderBy('cr.decided_at', 'desc')
        .orderBy('cr.id', 'desc')
        .limit(limitNum + 1);
    }

    const [rows, pendingCountResult] = await Promise.all([
      query.execute(),
      db
        .selectFrom('auth.creator_requests')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('status', '=', 'PENDING')
        .executeTakeFirst(),
    ]);

    const pendingCount = Number(pendingCountResult?.count ?? 0);
    const hasNext = rows.length > limitNum;
    const items = hasNext ? rows.slice(0, limitNum) : rows;

    let nextCursor: string | null = null;
    if (hasNext && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor<CreatorRequestCursorPayload>({
        s: targetStatus,
        t: targetStatus === 'PENDING' ? last.created_at_iso : last.decided_at_iso!,
        id: last.id,
      });
    }

    const formattedItems = items.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      decision_note: row.decision_note ?? null,
      created_at: row.created_at_iso,
      decided_at: row.decided_at_iso ?? null,
      user: formatAdminUser(
        {
          id: row.user_id,
          email: row.user_email,
          email_verified_at: row.user_email_verified_at,
          handle: row.user_handle,
          display_name: row.user_display_name,
          avatar_key: row.user_avatar_key,
          roles: row.user_roles,
          status: row.user_status,
          suspended_until: row.user_suspended_until,
          suspension_reason: row.user_suspension_reason,
          created_at_iso: row.user_created_at_iso,
        },
        env,
      ),
      decided_by: row.decider_id
        ? {
            id: row.decider_id,
            handle: row.decider_handle || 'unknown',
            display_name: row.decider_display_name || 'Unknown User',
            avatar_url: row.decider_avatar_key
              ? `${env.MEDIA_BASE_URL}/${row.decider_avatar_key}`
              : null,
          }
        : null,
    }));

    return reply.status(200).send({
      items: formattedItems,
      next_cursor: nextCursor,
      pending_count: pendingCount,
    });
  });

  // 8. Decide creator request (admin only, task ROLE1, ADR-046)
  fastify.post<{
    Params: { request_id: string };
  }>('/v1/admin/creator-requests/:request_id/decision', async (request, reply) => {
    const caller = await getCaller(request, env);
    enforceRbac({ actorRoles: caller.roles, action: 'DECIDE_CREATOR_REQUEST' });

    const { request_id } = request.params;
    if (!isValidUuid(request_id)) {
      throw ProblemError.badRequest('Invalid request ID');
    }

    const parseResult = decideCreatorRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
    }
    const { decision, note } = parseResult.data;

    const result = await db.transaction().execute(async (trx) => {
      // Lock request row
      const requestRow = await trx
        .selectFrom('auth.creator_requests')
        .selectAll()
        .where('id', '=', request_id)
        .forUpdate()
        .executeTakeFirst();

      if (!requestRow) {
        throw ProblemError.notFound('Creator request not found');
      }

      if (requestRow.status !== 'PENDING') {
        throw ProblemError.conflict('Request has already been decided', 'REQUEST_ALREADY_DECIDED');
      }

      if (requestRow.user_id === caller.id) {
        throw ProblemError.cannotModerateTarget('Cannot moderate own creator request');
      }

      const now = new Date();

      if (decision === 'REJECT') {
        await trx
          .updateTable('auth.creator_requests')
          .set({
            status: 'REJECTED',
            decision_note: note!,
            decided_by: caller.id,
            decided_at: now,
          })
          .where('id', '=', request_id)
          .execute();
      } else {
        // APPROVE: lock target user
        const targetUser = await trx
          .selectFrom('auth.users')
          .selectAll()
          .where('id', '=', requestRow.user_id)
          .forUpdate()
          .executeTakeFirst();

        if (!targetUser) {
          throw ProblemError.notFound('Target user not found');
        }

        if (targetUser.status !== 'ACTIVE') {
          throw ProblemError.conflict('Target user is not active', 'USER_NOT_ACTIVE');
        }

        const currentRoles = [...targetUser.roles];
        const rolesChanged = !currentRoles.includes('creator');
        if (rolesChanged) {
          const newRoles = [...currentRoles, 'creator' as Role];
          await trx
            .updateTable('auth.users')
            .set({
              roles: newRoles,
              updated_at: now,
            })
            .where('id', '=', requestRow.user_id)
            .execute();

          await trx
            .insertInto('auth.audit_log')
            .values({
              id: uuidv7(),
              actor_id: caller.id,
              action: 'USER_ROLES_CHANGED',
              target_user_id: requestRow.user_id,
              details: JSON.stringify({
                from: currentRoles,
                to: newRoles,
                creator_request_id: request_id,
              }),
            })
            .execute();
        }

        await trx
          .updateTable('auth.creator_requests')
          .set({
            status: 'APPROVED',
            decision_note: note ?? null,
            decided_by: caller.id,
            decided_at: now,
          })
          .where('id', '=', request_id)
          .execute();
      }

      const decided = await trx
        .selectFrom('auth.creator_requests as cr')
        .innerJoin('auth.users as u', 'u.id', 'cr.user_id')
        .leftJoin('auth.public_profiles as decider', 'decider.id', 'cr.decided_by')
        .select([
          'cr.id',
          'cr.status',
          'cr.message',
          'cr.decision_note',
          sql<string>`to_char(cr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'created_at_iso',
          ),
          sql<string>`to_char(cr.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'decided_at_iso',
          ),
          'u.id as user_id',
          'u.email as user_email',
          'u.email_verified_at as user_email_verified_at',
          'u.handle as user_handle',
          'u.display_name as user_display_name',
          'u.avatar_key as user_avatar_key',
          'u.roles as user_roles',
          'u.status as user_status',
          'u.suspended_until as user_suspended_until',
          'u.suspension_reason as user_suspension_reason',
          sql<string>`to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'user_created_at_iso',
          ),
          'decider.id as decider_id',
          'decider.handle as decider_handle',
          'decider.display_name as decider_display_name',
          'decider.avatar_key as decider_avatar_key',
        ])
        .where('cr.id', '=', request_id)
        .executeTakeFirstOrThrow();

      return decided;
    });

    return reply.status(200).send({
      id: result.id,
      status: result.status,
      message: result.message,
      decision_note: result.decision_note ?? null,
      created_at: result.created_at_iso,
      decided_at: result.decided_at_iso ?? null,
      user: formatAdminUser(
        {
          id: result.user_id,
          email: result.user_email,
          email_verified_at: result.user_email_verified_at,
          handle: result.user_handle,
          display_name: result.user_display_name,
          avatar_key: result.user_avatar_key,
          roles: result.user_roles,
          status: result.user_status,
          suspended_until: result.user_suspended_until,
          suspension_reason: result.user_suspension_reason,
          created_at_iso: result.user_created_at_iso,
        },
        env,
      ),
      decided_by: result.decider_id
        ? {
            id: result.decider_id,
            handle: result.decider_handle || 'unknown',
            display_name: result.decider_display_name || 'Unknown User',
            avatar_url: result.decider_avatar_key
              ? `${env.MEDIA_BASE_URL}/${result.decider_avatar_key}`
              : null,
          }
        : null,
    });
  });
};
