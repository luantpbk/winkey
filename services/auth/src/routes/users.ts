import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';

const handleParamSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_.]{3,30}$/),
});

export const usersRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
}> = async (fastify, { db, env }) => {
  fastify.get('/v1/users/:handle', async (request, reply) => {
    const parseResult = handleParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      throw ProblemError.badRequest('Invalid handle parameter format');
    }

    const { handle } = parseResult.data;

    const profile = await db
      .selectFrom('auth.public_profiles')
      .selectAll()
      .where('handle', '=', handle)
      .executeTakeFirst();

    if (!profile) {
      throw ProblemError.notFound(`User with handle '${handle}' not found`);
    }

    return reply.status(200).send({
      id: profile.id,
      handle: profile.handle,
      display_name: profile.display_name,
      avatar_url: profile.avatar_key ? `${env.MEDIA_BASE_URL}/${profile.avatar_key}` : null,
    });
  });
};
