import type { FastifyPluginAsync } from 'fastify';
import { getJwks } from '../crypto/jwt.js';
import type { Env } from '../config/env.js';

export const jwksRoute: FastifyPluginAsync<{
  env: Env;
}> = async (fastify, { env }) => {
  fastify.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await getJwks(env);
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.status(200).send(jwks);
  });
};
