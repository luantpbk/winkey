import type { FastifyPluginAsync } from 'fastify';
import { verifyAccessToken } from '../crypto/jwt.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';

export const meRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
}> = async (fastify, { db, env }) => {
  fastify.get('/v1/auth/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw ProblemError.unauthorized('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7).trim();
    let claims;
    try {
      claims = await verifyAccessToken(token, env);
    } catch {
      throw ProblemError.unauthorized('Invalid or expired token');
    }

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', claims.sub)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    return reply.status(200).send({
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at != null,
      handle: user.handle,
      display_name: user.display_name,
      avatar_url: user.avatar_key ? `${env.MEDIA_BASE_URL}/${user.avatar_key}` : null,
      roles: user.roles,
      created_at: new Date(user.created_at).toISOString(),
    });
  });
};
