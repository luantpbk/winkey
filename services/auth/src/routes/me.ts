import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { verifyAccessToken, type AccessTokenClaims } from '../crypto/jwt.js';
import { verifyPassword, hashPassword } from '../crypto/passwords.js';
import { getClearRefreshCookieOptions, REFRESH_COOKIE_NAME } from '../crypto/refresh.js';
import {
  buildUpdateMeRateLimitKey,
  buildAccountActionRateLimitKeys,
  buildCreatorRequestRateLimitKey,
  type RateLimiter,
} from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database, ProfileLink, Role } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { RevocationService } from '../revocation/revocation.js';
import type { Redis } from 'ioredis';
import { checkUserMfaEnabled, computeEffectiveRoles } from '../security/staff-rules.js';
import { isPasswordBreached } from '../security/hibp.js';
import { recordSecurityEvent } from '../security/events.js';
import {
  normalizeBio,
  validateProfileLinks,
  resolveReadyImageKey,
  areLinksEqual,
} from '../security/profile-validation.js';

const updateMeSchema = z
  .object({
    display_name: z.string().min(1).max(50).optional(),
    handle: z
      .string()
      .regex(/^[A-Za-z0-9_.]{3,30}$/, 'Invalid handle format')
      .optional(),
    bio: z.string().max(300).nullable().optional(),
    links: z.array(z.any()).max(5).optional(),
    avatar_image_id: z.string().nullable().optional(),
    banner_image_id: z.string().nullable().optional(),
    is_private: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.display_name !== undefined ||
      data.handle !== undefined ||
      data.bio !== undefined ||
      data.links !== undefined ||
      data.avatar_image_id !== undefined ||
      data.banner_image_id !== undefined ||
      data.is_private !== undefined,
    {
      message: 'At least one field must be provided',
    },
  );

const changePasswordSchema = z
  .object({
    current_password: z.string().optional(),
    new_password: z.string().min(8).max(128),
  })
  .strict();

const deleteMeSchema = z
  .object({
    confirm_handle: z.string().min(1),
    password: z.string().optional(),
  })
  .strict();

const createCreatorRequestSchema = z
  .object({
    message: z.string().trim().min(10).max(1000),
  })
  .strict();

async function extractBearerClaims(request: FastifyRequest, env: Env): Promise<AccessTokenClaims> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ProblemError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7).trim();
  try {
    return await verifyAccessToken(token, env);
  } catch {
    throw ProblemError.unauthorized('Invalid or expired token');
  }
}

function formatUser(
  user: {
    id: string;
    email: string;
    email_verified_at: Date | string | null;
    handle: string;
    display_name: string;
    avatar_key: string | null;
    bio?: string | null;
    links?: ProfileLink[] | string | null;
    banner_key?: string | null;
    is_private?: boolean | null;
    roles: Role[];
    password_hash?: string | null;
    created_at: Date | string;
  },
  env: Env,
  hasMfa = false,
  staffRolesPendingMfa: Role[] = [],
  effectiveRoles?: Role[],
) {
  let parsedLinks: ProfileLink[] = [];
  if (Array.isArray(user.links)) {
    parsedLinks = user.links;
  } else if (typeof user.links === 'string') {
    try {
      parsedLinks = JSON.parse(user.links);
    } catch {
      parsedLinks = [];
    }
  }

  return {
    id: user.id,
    email: user.email,
    email_verified: user.email_verified_at != null,
    handle: user.handle,
    display_name: user.display_name,
    avatar_url: user.avatar_key ? `${env.MEDIA_BASE_URL}/${user.avatar_key}` : null,
    roles: effectiveRoles ?? user.roles,
    staff_roles_pending_mfa: staffRolesPendingMfa,
    mfa_enabled: hasMfa,
    bio: user.bio ?? null,
    links: parsedLinks,
    banner_url: user.banner_key ? `${env.MEDIA_BASE_URL}/${user.banner_key}` : null,
    is_private: Boolean(user.is_private),
    has_password: user.password_hash != null,
    created_at: new Date(user.created_at).toISOString(),
  };
}

export const meRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
  revocationService: RevocationService;
  redis?: Redis | null;
}> = async (fastify, { db, env, rateLimiter, revocationService, redis }) => {
  // 1. GET /v1/auth/me
  fastify.get('/v1/auth/me', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    const hasMfa = await checkUserMfaEnabled(db, user.id, user.totp_enabled_at);
    const { effectiveRoles, staffRolesPendingMfa } = computeEffectiveRoles(
      user.roles,
      hasMfa,
      env.STAFF_MFA_REQUIRED,
    );

    return reply
      .status(200)
      .send(formatUser(user, env, hasMfa, staffRolesPendingMfa, effectiveRoles));
  });

  // 2. PATCH /v1/auth/me (updateMe)
  fastify.patch('/v1/auth/me', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const parseResult = updateMeSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { display_name, handle, bio, links, avatar_image_id, banner_image_id, is_private } =
      parseResult.data;

    // Validate links with WHATWG URL parser if provided -> throws 400 LINK_INVALID on error
    const validatedLinks = links !== undefined ? validateProfileLinks(links) : undefined;
    const normalizedBio = normalizeBio(bio);

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    const hasMfa = await checkUserMfaEnabled(db, user.id, user.totp_enabled_at);
    const { effectiveRoles, staffRolesPendingMfa } = computeEffectiveRoles(
      user.roles,
      hasMfa,
      env.STAFF_MFA_REQUIRED,
    );

    // Resolve avatar and banner keys from media.ready_images if provided -> throws 400 IMAGE_INVALID on error
    const resolvedAvatarKey = await resolveReadyImageKey(db, avatar_image_id, userId, 'AVATAR');
    const resolvedBannerKey = await resolveReadyImageKey(db, banner_image_id, userId, 'BANNER');

    // Parse current user links for accurate comparison
    let currentLinks: ProfileLink[] = [];
    if (Array.isArray(user.links)) {
      currentLinks = user.links;
    } else if (typeof user.links === 'string') {
      try {
        currentLinks = JSON.parse(user.links);
      } catch {
        currentLinks = [];
      }
    }

    // No-op check: if provided values match current values, return 200 without DB write or rate limit hit
    const isDisplayNameUnchanged = display_name === undefined || display_name === user.display_name;
    const isHandleUnchanged = handle === undefined || handle === user.handle;
    const isBioUnchanged = normalizedBio === undefined || normalizedBio === (user.bio ?? null);
    const isLinksUnchanged =
      validatedLinks === undefined || areLinksEqual(validatedLinks, currentLinks);
    const isAvatarUnchanged =
      resolvedAvatarKey === undefined || resolvedAvatarKey === user.avatar_key;
    const isBannerUnchanged =
      resolvedBannerKey === undefined || resolvedBannerKey === user.banner_key;
    const isPrivateUnchanged = is_private === undefined || is_private === Boolean(user.is_private);

    if (
      isDisplayNameUnchanged &&
      isHandleUnchanged &&
      isBioUnchanged &&
      isLinksUnchanged &&
      isAvatarUnchanged &&
      isBannerUnchanged &&
      isPrivateUnchanged
    ) {
      return reply
        .status(200)
        .send(formatUser(user, env, hasMfa, staffRolesPendingMfa, effectiveRoles));
    }

    // Rate limit: 10 changes per hour per user ID
    await rateLimiter.consume({
      key: buildUpdateMeRateLimitKey(userId),
      limit: 10,
      windowSeconds: 3600,
    });

    try {
      const updateFields: Record<string, unknown> = {
        updated_at: new Date(),
      };
      if (display_name !== undefined) updateFields.display_name = display_name;
      if (handle !== undefined) updateFields.handle = handle;
      if (normalizedBio !== undefined) updateFields.bio = normalizedBio;
      if (validatedLinks !== undefined) updateFields.links = JSON.stringify(validatedLinks);
      if (resolvedAvatarKey !== undefined) updateFields.avatar_key = resolvedAvatarKey;
      if (resolvedBannerKey !== undefined) updateFields.banner_key = resolvedBannerKey;
      if (is_private !== undefined) updateFields.is_private = is_private;

      const updated = await db
        .updateTable('auth.users')
        .set(updateFields)
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();

      request.log.info({ userId, op: 'updateMe' }, 'User updated profile');
      return reply
        .status(200)
        .send(formatUser(updated, env, hasMfa, staffRolesPendingMfa, effectiveRoles));
    } catch (err: unknown) {
      const dbErr = err as { code?: string; constraint?: string };
      if (dbErr.code === '23505' || dbErr.constraint === 'users_handle_key') {
        throw ProblemError.conflict('Handle already taken', 'HANDLE_TAKEN');
      }
      throw err;
    }
  });

  // 3. PUT /v1/auth/me/password (changePassword)
  fastify.put('/v1/auth/me/password', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const currentFamilyId = claims.sid;

    const parseResult = changePasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { current_password, new_password } = parseResult.data;
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit like login: 5/min per user ID, 20/min per IP
    const { userKey, ipKey } = buildAccountActionRateLimitKeys('password', userId, clientIp);
    await rateLimiter.consume({ key: userKey, limit: 5, windowSeconds: 60 });
    await rateLimiter.consume({ key: ipKey, limit: 20, windowSeconds: 60 });

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    if (user.password_hash !== null) {
      if (!current_password) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
      const isValid = await verifyPassword(user.password_hash, current_password);
      if (!isValid) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
    } else {
      // OAuth-only account: current_password must be omitted
      if (current_password !== undefined) {
        throw ProblemError.badRequest(
          'Current password must be omitted for OAuth-only accounts',
          undefined,
          'INVALID_REQUEST',
        );
      }
    }

    if (env.PASSWORD_BREACH_CHECK) {
      const breached = await isPasswordBreached(new_password, redis, true);
      if (breached) {
        throw ProblemError.badRequest(
          'This password was found in a data breach. Please choose a different password.',
          undefined,
          'PASSWORD_BREACHED',
        );
      }
    }

    const newHash = await hashPassword(new_password);

    const revokedFamilyIds = await db.transaction().execute(async (trx) => {
      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          password_hash: newHash,
          updated_at: now,
        })
        .where('id', '=', userId)
        .execute();

      // Revoke all other refresh families in one atomic statement
      const revokedRows = await trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('family_id', '!=', currentFamilyId)
        .returning('family_id')
        .execute();

      await trx
        .updateTable('auth.sessions')
        .set({ revoked_at: now, revoke_reason: 'PASSWORD_CHANGED' })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('id', '!=', currentFamilyId)
        .execute();

      await recordSecurityEvent(trx, {
        userId,
        kind: 'PASSWORD_CHANGED',
        sessionId: currentFamilyId,
      });

      return Array.from(new Set(revokedRows.map((r) => r.family_id)));
    });

    // Revoke sessions in Valkey AFTER DB commit (fail-safe)
    for (const famId of revokedFamilyIds) {
      await revocationService.revokeSession(famId);
    }

    request.log.info({ userId, op: 'changePassword' }, 'User changed password');
    return reply.status(204).send();
  });

  // 4. DELETE /v1/auth/me (deleteMe)
  fastify.delete('/v1/auth/me', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const parseResult = deleteMeSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { confirm_handle, password } = parseResult.data;
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit like login: 5/min per user ID, 20/min per IP
    const { userKey, ipKey } = buildAccountActionRateLimitKeys('delete', userId, clientIp);
    await rateLimiter.consume({ key: userKey, limit: 5, windowSeconds: 60 });
    await rateLimiter.consume({ key: ipKey, limit: 20, windowSeconds: 60 });

    await db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();

      if (!user || user.status !== 'ACTIVE') {
        throw ProblemError.unauthorized('User not found or inactive');
      }

      // Confirm handle (case-insensitive)
      if (user.handle.toLowerCase() !== confirm_handle.trim().toLowerCase()) {
        throw ProblemError.badRequest(
          'Handle confirmation does not match',
          undefined,
          'CONFIRMATION_MISMATCH',
        );
      }

      // Password verification if account has a password
      if (user.password_hash !== null) {
        if (!password) {
          throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
        }
        const isValid = await verifyPassword(user.password_hash, password);
        if (!isValid) {
          throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
        }
      }

      // Last admin safeguard
      if (user.roles.includes('admin')) {
        await sql`SELECT pg_advisory_xact_lock(hashtext('auth.last_admin'))`.execute(trx);
        const adminCountRes = await trx
          .selectFrom('auth.users')
          .select(sql<number>`count(*)::int`.as('cnt'))
          .where(sql<boolean>`'admin' = ANY(roles)`)
          .where('status', '!=', 'DELETED')
          .executeTakeFirst();
        if (Number(adminCountRes?.cnt ?? 0) <= 1) {
          throw ProblemError.conflict('Cannot delete the last admin account', 'LAST_ADMIN');
        }
      }

      // Scrub user row
      const hex = user.id.replace(/-/g, '');
      const scrubbedHandle = `d_${hex.slice(0, 28)}`;
      const scrubbedEmail = `deleted+${user.id}@invalid.winkey.vn`;
      const now = new Date();

      await trx
        .updateTable('auth.users')
        .set({
          email: scrubbedEmail,
          handle: scrubbedHandle,
          display_name: 'Deleted user',
          password_hash: null,
          email_verified_at: null,
          avatar_key: null,
          bio: null,
          links: JSON.stringify([]),
          banner_key: null,
          is_private: false,
          status: 'DELETED',
          suspended_until: null,
          suspension_reason: null,
          updated_at: now,
        })
        .where('id', '=', user.id)
        .execute();

      // Delete all OAuth identities
      await trx.deleteFrom('auth.oauth_identities').where('user_id', '=', user.id).execute();

      // Delete pending mail_queue rows and live tokens (task A6, ADR-026)
      await trx
        .deleteFrom('auth.mail_queue')
        .where('user_id', '=', user.id)
        .where('sent_at', 'is', null)
        .where('dead_at', 'is', null)
        .execute();

      await trx
        .deleteFrom('auth.email_tokens')
        .where('user_id', '=', user.id)
        .where('used_at', 'is', null)
        .execute();

      // Revoke all refresh tokens
      await trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .execute();

      // Revoke all sessions
      await trx
        .updateTable('auth.sessions')
        .set({ revoked_at: now, revoke_reason: 'DELETED' })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .execute();
    });

    // Revoke user in Valkey AFTER DB commit (fail-safe)
    await revocationService.revokeUser(userId);

    // Clear refresh cookie
    reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));
    request.log.info({ userId, op: 'deleteMe' }, 'User deleted account');
    return reply.status(204).send();
  });

  // 5. GET /v1/auth/me/creator-request (task ROLE1, ADR-046)
  fastify.get('/v1/auth/me/creator-request', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const requestRow = await db
      .selectFrom('auth.creator_requests')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!requestRow) {
      throw ProblemError.notFound('No creator request found');
    }

    return reply.status(200).send({
      id: requestRow.id,
      status: requestRow.status,
      message: requestRow.message,
      decision_note: requestRow.decision_note ?? null,
      created_at: new Date(requestRow.created_at).toISOString(),
      decided_at: requestRow.decided_at ? new Date(requestRow.decided_at).toISOString() : null,
    });
  });

  // 6. POST /v1/auth/me/creator-request (task ROLE1, ADR-046)
  fastify.post('/v1/auth/me/creator-request', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const parseResult = createCreatorRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_ERROR');
    }
    const { message } = parseResult.data;

    // Rate limit: 5 per user per day
    await rateLimiter.consume({
      key: buildCreatorRequestRateLimitKey(userId),
      limit: 5,
      windowSeconds: 86400,
    });

    const createdRequest = await db.transaction().execute(async (trx) => {
      // Lock caller user row to prevent race conditions on submission
      const user = await trx
        .selectFrom('auth.users')
        .select(['id', 'roles'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw ProblemError.unauthorized('User not found');
      }

      // Conflict check 1: Already has creator role
      if (user.roles.includes('creator')) {
        throw ProblemError.conflict('User already has creator role', 'ALREADY_CREATOR');
      }

      // Latest request of caller
      const latestRequest = await trx
        .selectFrom('auth.creator_requests')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

      // Conflict check 2: PENDING request exists
      if (latestRequest && latestRequest.status === 'PENDING') {
        throw ProblemError.conflict('A creator request is already pending', 'REQUEST_PENDING');
      }

      // Conflict check 3: REJECTED less than 24h ago
      if (latestRequest && latestRequest.status === 'REJECTED' && latestRequest.decided_at) {
        const decidedAtMs = new Date(latestRequest.decided_at).getTime();
        const cooldownExpiresAtMs = decidedAtMs + 24 * 60 * 60 * 1000;
        if (Date.now() < cooldownExpiresAtMs) {
          const expiresAtIso = new Date(cooldownExpiresAtMs).toISOString();
          throw new ProblemError({
            status: 409,
            title: 'Conflict',
            code: 'REQUEST_COOLDOWN',
            detail: `A new request can be submitted after ${expiresAtIso}`,
          });
        }
      }

      // Create PENDING request
      const newId = uuidv7();
      try {
        const inserted = await trx
          .insertInto('auth.creator_requests')
          .values({
            id: newId,
            user_id: userId,
            status: 'PENDING',
            message,
            decision_note: null,
            decided_by: null,
            decided_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return inserted;
      } catch (err: unknown) {
        const dbErr = err as { code?: string; constraint?: string };
        if (dbErr.code === '23505' && dbErr.constraint === 'creator_requests_one_pending') {
          throw ProblemError.conflict('A creator request is already pending', 'REQUEST_PENDING');
        }
        throw err;
      }
    });

    // Logging: request id and user id, NEVER message!
    request.log.info({ request_id: createdRequest.id, user_id: userId }, 'Creator request created');

    return reply.status(201).send({
      id: createdRequest.id,
      status: createdRequest.status,
      message: createdRequest.message,
      decision_note: createdRequest.decision_note ?? null,
      created_at: new Date(createdRequest.created_at).toISOString(),
      decided_at: createdRequest.decided_at
        ? new Date(createdRequest.decided_at).toISOString()
        : null,
    });
  });
};
