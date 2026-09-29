import type { FastifyPluginAsync } from 'fastify';
import { verifyAccessToken } from '../crypto/jwt.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';

export const verifyRoute: FastifyPluginAsync<{
  env: Env;
}> = async (fastify, { env }) => {
  fastify.get('/v1/auth/verify', async (request, reply) => {
    const authHeader = request.headers.authorization;

    // 1. No Authorization header -> 204 without identity headers (anonymous request)
    if (!authHeader) {
      return reply.status(204).send();
    }

    // 2. Validate Bearer format
    if (!authHeader.startsWith('Bearer ') || authHeader.length <= 7) {
      throw ProblemError.unauthorized('Invalid Authorization header format');
    }

    const token = authHeader.slice(7).trim();

    // 3. Stateless in-memory verification (target p99 < 2ms, zero DB access)
    try {
      const claims = await verifyAccessToken(token, env);
      reply.header('X-User-Id', claims.sub);
      reply.header('X-User-Roles', claims.roles.join(','));
      return reply.status(204).send();
    } catch {
      throw ProblemError.unauthorized('Invalid or expired token');
    }
  });
};
