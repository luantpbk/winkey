import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database, ProfileLink } from '../db/types.js';
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

    let parsedLinks: ProfileLink[] = [];
    if (Array.isArray(profile.links)) {
      parsedLinks = profile.links;
    } else if (typeof profile.links === 'string') {
      try {
        parsedLinks = JSON.parse(profile.links);
      } catch {
        parsedLinks = [];
      }
    }

    return reply.status(200).send({
      id: profile.id,
      handle: profile.handle,
      display_name: profile.display_name,
      avatar_url: profile.avatar_key ? `${env.MEDIA_BASE_URL}/${profile.avatar_key}` : null,
      bio: profile.bio ?? null,
      links: parsedLinks,
      banner_url: profile.banner_key ? `${env.MEDIA_BASE_URL}/${profile.banner_key}` : null,
      is_private: Boolean(profile.is_private),
      created_at: new Date(profile.created_at).toISOString(),
    });
  });
};
