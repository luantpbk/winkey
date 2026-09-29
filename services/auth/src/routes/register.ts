import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { enqueue } from '@winkey/outbox';
import { hashPassword } from '../crypto/passwords.js';
import { issueAccessToken } from '../crypto/jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { ProblemError } from '../errors/problem.js';
import { buildRegisterRateLimitKey } from '../rate-limit/valkey-limiter.js';
import type { Env } from '../config/env.js';
import type { Database, Role } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';

const registerBodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  handle: z.string().regex(/^[A-Za-z0-9_.]{3,30}$/),
  display_name: z.string().min(1).max(50),
});

export const registerRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}> = async (fastify, { db, env, rateLimiter }) => {
  fastify.post('/v1/auth/register', async (request, reply) => {
    // 1. Rate limiting: 5/hour per IP
    const clientIp = request.ip || '127.0.0.1';
    await rateLimiter.consume({
      key: buildRegisterRateLimitKey(clientIp),
      limit: 5,
      windowSeconds: 3600,
    });

    // 2. Validate input matching RegisterRequest schema
    const parseResult = registerBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { email, password, handle, display_name } = parseResult.data;

    // 3. Pre-check email & handle uniqueness for clear error responses
    const existingEmail = await db
      .selectFrom('auth.users')
      .select('id')
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();
    if (existingEmail) {
      throw ProblemError.conflict('Email is already registered', 'EMAIL_TAKEN');
    }

    const existingHandle = await db
      .selectFrom('auth.users')
      .select('id')
      .where('handle', '=', handle)
      .executeTakeFirst();
    if (existingHandle) {
      throw ProblemError.conflict('Handle is already in use', 'HANDLE_TAKEN');
    }

    // 4. Hash password with argon2id (OWASP baseline)
    const passwordHash = await hashPassword(password);
    const userId = uuidv7();
    const familyId = uuidv7();
    const defaultRoles: Role[] = ['viewer', 'creator'];

    const opaqueRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(opaqueRefreshToken);
    const tokenId = uuidv7();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 5. In ONE transaction, insert auth.users, auth.outbox and auth.refresh_tokens
    let createdUser: {
      id: string;
      email: string;
      email_verified: boolean;
      handle: string;
      display_name: string;
      avatar_url: string | null;
      roles: Role[];
      created_at: string;
    };

    try {
      createdUser = await db.transaction().execute(async (trx) => {
        const userRow = await trx
          .insertInto('auth.users')
          .values({
            id: userId,
            email: email.trim().toLowerCase(),
            password_hash: passwordHash,
            handle,
            display_name,
            avatar_key: null,
            roles: defaultRoles,
            status: 'ACTIVE',
          })
          .returning(['id', 'email', 'email_verified_at', 'handle', 'display_name', 'avatar_key', 'roles', 'created_at'])
          .executeTakeFirstOrThrow();

        // Atomic outbox insertion for domain event
        await enqueue(
          trx,
          'auth',
          'user.registered',
          {
            user_id: userRow.id,
            handle: userRow.handle,
            method: 'password',
          },
          { producer: 'auth-svc', version: 1 }
        );

        // Insert initial refresh token in family
        await trx
          .insertInto('auth.refresh_tokens')
          .values({
            id: tokenId,
            user_id: userRow.id,
            family_id: familyId,
            token_hash: tokenHash,
            parent_id: null,
            expires_at: expiresAt,
            user_agent: request.headers['user-agent'] || null,
            ip: clientIp,
          })
          .execute();

        return {
          id: userRow.id,
          email: userRow.email,
          email_verified: userRow.email_verified_at != null,
          handle: userRow.handle,
          display_name: userRow.display_name,
          avatar_url: userRow.avatar_key ? `${env.MEDIA_BASE_URL}/${userRow.avatar_key}` : null,
          roles: userRow.roles,
          created_at: new Date(userRow.created_at).toISOString(),
        };
      });
    } catch (err: any) {
      if (err.code === '23505') {
        // Unique constraint violation in PostgreSQL
        if (err.constraint?.includes('email')) {
          throw ProblemError.conflict('Email is already registered', 'EMAIL_TAKEN');
        }
        if (err.constraint?.includes('handle')) {
          throw ProblemError.conflict('Handle is already in use', 'HANDLE_TAKEN');
        }
      }
      throw err;
    }

    // 6. Generate access token (RS256, 15 min)
    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: createdUser.id, roles: createdUser.roles },
      familyId,
      env
    );

    // 7. Set wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, opaqueRefreshToken, getRefreshCookieOptions(env));

    // 8. 201 Response with TokenResponse
    return reply.status(201).send({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: createdUser,
    });
  });
};
