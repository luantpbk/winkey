import type { FastifyPluginAsync } from 'fastify';
import { verifyAccessToken, type AccessTokenClaims } from '../crypto/jwt.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import {
  RevocationService,
  verifyRevocationCheckCounter,
} from '../revocation/revocation.js';

export const verifyRoute: FastifyPluginAsync<{
  env: Env;
  revocationService: RevocationService;
}> = async (fastify, { env, revocationService }) => {
  fastify.get('/v1/auth/verify', async (request, reply) => {
    const authHeader = request.headers.authorization;

    // 1. No Authorization header -> 204 without identity headers (anonymous request)
    // Anonymous requests never touch Valkey
    if (!authHeader) {
      return reply.status(204).send();
    }

    // 2. Validate Bearer format
    if (!authHeader.startsWith('Bearer ') || authHeader.length <= 7) {
      throw ProblemError.unauthorized('Invalid Authorization header format');
    }

    const token = authHeader.slice(7).trim();

    // 3. Stateless in-memory verification (target p99 < 2ms, zero DB access)
    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token, env);
    } catch {
      throw ProblemError.unauthorized('Invalid or expired token');
    }

    // 4. Task A4 (ADR-019): immediate revocation check via Valkey MGET with 50 ms timeout
    const check = await revocationService.isRevoked(claims.sid, claims.sub, claims.iat);
    if (!check.checked) {
      verifyRevocationCheckCounter.inc({ result: 'error' });
    } else if (check.revoked) {
      verifyRevocationCheckCounter.inc({ result: 'revoked' });
      throw ProblemError.unauthorized('Invalid or expired token');
    } else {
      verifyRevocationCheckCounter.inc({ result: 'ok' });
    }

    reply.header('X-User-Id', claims.sub);
    reply.header('X-User-Roles', claims.roles.join(','));
    return reply.status(204).send();
  });
};
