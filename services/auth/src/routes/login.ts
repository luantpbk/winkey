import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { verifyPassword, hashPassword, needsRehash } from '../crypto/passwords.js';
import { issueAccessToken } from '../crypto/jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { ProblemError } from '../errors/problem.js';
import { buildLoginRateLimitKeys } from '../rate-limit/valkey-limiter.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const loginRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}> = async (fastify, { db, env, rateLimiter }) => {
  fastify.post('/v1/auth/login', async (request, reply) => {
    // 1. Validate request body
    const parseResult = loginBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { email, password } = parseResult.data;
    const clientIp = request.ip || '127.0.0.1';

    // 2. Rate limiting: 5/min per IP+email AND 20/min per IP
    const { ipEmailKey, ipKey } = buildLoginRateLimitKeys(clientIp, email);
    await rateLimiter.consume({ key: ipEmailKey, limit: 5, windowSeconds: 60 });
    await rateLimiter.consume({ key: ipKey, limit: 20, windowSeconds: 60 });

    // 3. Look up user by email
    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE' || !user.password_hash) {
      throw ProblemError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // 4. Verify password
    const isValid = await verifyPassword(user.password_hash, password);
    if (!isValid) {
      throw ProblemError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // 5. Rehash on login if parameters changed
    if (needsRehash(user.password_hash)) {
      const newHash = await hashPassword(password);
      await db
        .updateTable('auth.users')
        .set({ password_hash: newHash })
        .where('id', '=', user.id)
        .execute();
    }

    // 6. Generate refresh token & session family
    const familyId = uuidv7();
    const tokenId = uuidv7();
    const opaqueRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(opaqueRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db
      .insertInto('auth.refresh_tokens')
      .values({
        id: tokenId,
        user_id: user.id,
        family_id: familyId,
        token_hash: tokenHash,
        parent_id: null,
        expires_at: expiresAt,
        user_agent: request.headers['user-agent'] || null,
        ip: clientIp,
      })
      .execute();

    // 7. Issue access JWT
    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: user.id, roles: user.roles },
      familyId,
      env
    );

    // 8. Set wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, opaqueRefreshToken, getRefreshCookieOptions(env));

    // 9. Format response
    return reply.status(200).send({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified_at != null,
        handle: user.handle,
        display_name: user.display_name,
        avatar_url: user.avatar_key ? `${env.MEDIA_BASE_URL}/${user.avatar_key}` : null,
        roles: user.roles,
        created_at: new Date(user.created_at).toISOString(),
      },
    });
  });
};
