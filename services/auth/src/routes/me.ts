import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { verifyAccessToken } from '../crypto/jwt.js';
import { verifyPassword, hashPassword } from '../crypto/passwords.js';
import {
  hashRefreshToken,
  getClearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import {
  buildUpdateMeRateLimitKey,
  buildAccountActionRateLimitKeys,
  type RateLimiter,
} from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database, Role } from '../db/types.js';
import type { Kysely } from 'kysely';

const updateMeSchema = z
  .object({
    display_name: z.string().min(1).max(50).optional(),
    handle: z
      .string()
      .regex(/^[A-Za-z0-9_.]{3,30}$/, 'Invalid handle format')
      .optional(),
  })
  .strict()
  .refine((data) => data.display_name !== undefined || data.handle !== undefined, {
    message: 'At least one field must be provided',
  });

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

async function extractBearerUserId(request: FastifyRequest, env: Env): Promise<string> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ProblemError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7).trim();
  try {
    const claims = await verifyAccessToken(token, env);
    return claims.sub;
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
    roles: Role[];
    password_hash?: string | null;
    created_at: Date | string;
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
    has_password: user.password_hash != null,
    created_at: new Date(user.created_at).toISOString(),
  };
}

export const meRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}> = async (fastify, { db, env, rateLimiter }) => {
  // 1. GET /v1/auth/me
  fastify.get('/v1/auth/me', async (request, reply) => {
    const userId = await extractBearerUserId(request, env);

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    return reply.status(200).send(formatUser(user, env));
  });

  // 2. PATCH /v1/auth/me (updateMe)
  fastify.patch('/v1/auth/me', async (request, reply) => {
    const userId = await extractBearerUserId(request, env);

    const parseResult = updateMeSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { display_name, handle } = parseResult.data;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    // No-op check: if provided values match current values, return 200 without DB write or rate limit hit
    const isDisplayNameUnchanged = display_name === undefined || display_name === user.display_name;
    const isHandleUnchanged = handle === undefined || handle === user.handle;

    if (isDisplayNameUnchanged && isHandleUnchanged) {
      return reply.status(200).send(formatUser(user, env));
    }

    // Rate limit: 10 changes per hour per user ID
    await rateLimiter.consume({
      key: buildUpdateMeRateLimitKey(userId),
      limit: 10,
      windowSeconds: 3600,
    });

    try {
      const updated = await db
        .updateTable('auth.users')
        .set({
          ...(display_name !== undefined ? { display_name } : {}),
          ...(handle !== undefined ? { handle } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();

      request.log.info({ userId, op: 'updateMe' }, 'User updated profile');
      return reply.status(200).send(formatUser(updated, env));
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
    const userId = await extractBearerUserId(request, env);

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

    const newHash = await hashPassword(new_password);

    await db.transaction().execute(async (trx) => {
      // Find current refresh token family from wk_rt cookie if present
      let currentFamilyId: string | null = null;
      const rawCookie = request.cookies[REFRESH_COOKIE_NAME];
      if (rawCookie) {
        const tokenHash = hashRefreshToken(rawCookie);
        const currentToken = await trx
          .selectFrom('auth.refresh_tokens')
          .select('family_id')
          .where('token_hash', '=', tokenHash)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (currentToken) {
          currentFamilyId = currentToken.family_id;
        }
      }

      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          password_hash: newHash,
          updated_at: now,
        })
        .where('id', '=', userId)
        .execute();

      // Revoke all refresh families except the current one
      let revokeQuery = trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null);

      if (currentFamilyId) {
        revokeQuery = revokeQuery.where('family_id', '!=', currentFamilyId);
      }

      await revokeQuery.execute();
    });

    request.log.info({ userId, op: 'changePassword' }, 'User changed password');
    return reply.status(204).send();
  });

  // 4. DELETE /v1/auth/me (deleteMe)
  fastify.delete('/v1/auth/me', async (request, reply) => {
    const userId = await extractBearerUserId(request, env);

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
          status: 'DELETED',
          suspended_until: null,
          suspension_reason: null,
          updated_at: now,
        })
        .where('id', '=', user.id)
        .execute();

      // Delete all OAuth identities
      await trx.deleteFrom('auth.oauth_identities').where('user_id', '=', user.id).execute();

      // Revoke all refresh tokens
      await trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .execute();
    });

    // Clear refresh cookie
    reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));
    request.log.info({ userId, op: 'deleteMe' }, 'User deleted account');
    return reply.status(204).send();
  });
};
