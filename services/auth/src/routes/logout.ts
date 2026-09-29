import type { FastifyPluginAsync } from 'fastify';
import {
  hashRefreshToken,
  getClearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '').toLowerCase();
}

export const logoutRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
}> = async (fastify, { db, env }) => {
  fastify.post('/v1/auth/logout', async (request, reply) => {
    // 1. Reject if Origin is present and != PUBLIC_ORIGIN
    const origin = request.headers.origin;
    if (origin && normalizeOrigin(origin) !== normalizeOrigin(env.PUBLIC_ORIGIN)) {
      throw ProblemError.unauthorized('Invalid request origin');
    }

    // 2. Read wk_rt cookie
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      throw ProblemError.unauthorized('Missing refresh token cookie');
    }

    const tokenHash = hashRefreshToken(refreshToken);

    // 3. Find token and revoke the family
    const token = await db
      .selectFrom('auth.refresh_tokens')
      .select(['id', 'family_id'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (!token) {
      throw ProblemError.unauthorized('Invalid refresh token');
    }

    await db
      .updateTable('auth.refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', token.family_id)
      .where('revoked_at', 'is', null)
      .execute();

    // 4. Clear cookie wk_rt
    reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));

    // 5. 204 No Content
    return reply.status(204).send();
  });
};
