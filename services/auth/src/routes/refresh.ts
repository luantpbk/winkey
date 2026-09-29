import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { issueAccessToken } from '../crypto/jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
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

export const refreshRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
}> = async (fastify, { db, env }) => {
  fastify.post('/v1/auth/refresh', async (request, reply) => {
    // 1. Reject if Origin header is present and != PUBLIC_ORIGIN
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

    // 3. In ONE transaction with SELECT ... FOR UPDATE
    const result = await db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('auth.refresh_tokens')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();

      // Unknown token
      if (!token) {
        throw ProblemError.unauthorized('Invalid refresh token');
      }

      // Expired or revoked token
      const isExpired = new Date(token.expires_at).getTime() <= Date.now();
      const isRevoked = token.revoked_at != null;

      if (isExpired || isRevoked) {
        throw ProblemError.unauthorized('Refresh token is expired or revoked');
      }

      // Reuse detection: token was already rotated!
      if (token.rotated_at != null) {
        // Revoke the entire family
        await trx
          .updateTable('auth.refresh_tokens')
          .set({ revoked_at: new Date() })
          .where('family_id', '=', token.family_id)
          .where('revoked_at', 'is', null)
          .execute();

        return {
          kind: 'reuse' as const,
          familyId: token.family_id,
          userId: token.user_id,
          tokenId: token.id,
        };
      }

      // Mark current token rotated
      await trx
        .updateTable('auth.refresh_tokens')
        .set({ rotated_at: new Date() })
        .where('id', '=', token.id)
        .execute();

      // Issue child refresh token with the same family_id
      const newOpaqueToken = generateRefreshToken();
      const newTokenHash = hashRefreshToken(newOpaqueToken);
      const newChildId = uuidv7();
      const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await trx
        .insertInto('auth.refresh_tokens')
        .values({
          id: newChildId,
          user_id: token.user_id,
          family_id: token.family_id,
          token_hash: newTokenHash,
          parent_id: token.id,
          expires_at: newExpiresAt,
          user_agent: request.headers['user-agent'] || null,
          ip: request.ip || '127.0.0.1',
        })
        .execute();

      // Fetch user data
      const user = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', token.user_id)
        .executeTakeFirst();

      if (!user || user.status !== 'ACTIVE') {
        throw ProblemError.unauthorized('Account inactive or not found');
      }

      return {
        kind: 'ok' as const,
        user,
        familyId: token.family_id,
        newOpaqueToken,
      };
    });

    if (result.kind === 'reuse') {
      request.log.warn(
        {
          family_id: result.familyId,
          user_id: result.userId,
          token_id: result.tokenId,
          ip: request.ip,
        },
        'refresh token reuse: family revoked'
      );

      reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));
      throw ProblemError.unauthorized('Refresh token reuse detected');
    }

    // 4. Issue new access token
    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: result.user.id, roles: result.user.roles },
      result.familyId,
      env
    );

    // 5. Set new wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, result.newOpaqueToken, getRefreshCookieOptions(env));

    // 6. Return response
    return reply.status(200).send({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: {
        id: result.user.id,
        email: result.user.email,
        email_verified: result.user.email_verified_at != null,
        handle: result.user.handle,
        display_name: result.user.display_name,
        avatar_url: result.user.avatar_key ? `${env.MEDIA_BASE_URL}/${result.user.avatar_key}` : null,
        roles: result.user.roles,
        created_at: new Date(result.user.created_at).toISOString(),
      },
    });
  });
};
