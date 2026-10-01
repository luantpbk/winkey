import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { verifyAccessToken, type AccessTokenClaims } from '../crypto/jwt.js';
import { generateEmailToken, hashEmailToken, isValidTokenFormat } from '../tokens/email-tokens.js';

const verifyEmailSchema = z
  .object({
    token: z
      .string()
      .min(43)
      .max(43)
      .regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

async function extractBearerClaims(request: FastifyRequest, env: Env): Promise<AccessTokenClaims> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ProblemError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7).trim();
  try {
    return await verifyAccessToken(token, env);
  } catch {
    throw ProblemError.unauthorized('Invalid or expired token');
  }
}

export const emailVerificationRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}> = async (fastify, { db, env, rateLimiter }) => {
  // 1. POST /v1/auth/email/verification (resendEmailVerification)
  fastify.post('/v1/auth/email/verification', async (request, reply) => {
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit per IP like login (20/min)
    await rateLimiter.consume({
      key: `rl:login:ip:${clientIp}`,
      limit: 20,
      windowSeconds: 60,
    });

    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    if (user.email_verified_at !== null) {
      throw ProblemError.conflict('Email is already verified', 'EMAIL_ALREADY_VERIFIED');
    }

    // Rate limit: at most 3 per user per hour -> 429 with Retry-After
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentTokens = await db
      .selectFrom('auth.email_tokens')
      .select(['created_at'])
      .where('user_id', '=', user.id)
      .where('purpose', '=', 'VERIFY_EMAIL')
      .where('created_at', '>', oneHourAgo)
      .orderBy('created_at', 'asc')
      .execute();

    if (recentTokens.length >= 3) {
      const oldestCreatedAt = new Date(recentTokens[0].created_at).getTime();
      const expiresWindowAt = oldestCreatedAt + 60 * 60 * 1000;
      const retryAfterSeconds = Math.max(1, Math.ceil((expiresWindowAt - Date.now()) / 1000));
      throw ProblemError.tooManyRequests(
        retryAfterSeconds,
        'Too many verification email requests; please try again later',
      );
    }

    const acceptLang = request.headers['accept-language'];
    const locale = acceptLang?.toLowerCase().startsWith('en') ? 'en' : 'vi';

    const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
    const tokenId = uuidv7();
    const verifyLink = `${env.PUBLIC_ORIGIN}/${locale}/verify-email?token=${rawToken}`;

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('auth.email_tokens')
        .values({
          id: tokenId,
          user_id: user.id,
          purpose: 'VERIFY_EMAIL',
          token_hash: tokenHash,
          email: user.email,
          expires_at: expiresAt,
        })
        .execute();

      await trx
        .insertInto('auth.mail_queue')
        .values({
          user_id: user.id,
          to_email: user.email,
          template: 'VERIFY_EMAIL',
          locale,
          params: { link: verifyLink },
        })
        .execute();
    });

    return reply.status(202).send();
  });

  // 2. POST /v1/auth/email/verify (verifyEmail)
  fastify.post('/v1/auth/email/verify', async (request, reply) => {
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit per IP like login (20/min)
    await rateLimiter.consume({
      key: `rl:login:ip:${clientIp}`,
      limit: 20,
      windowSeconds: 60,
    });

    const parseResult = verifyEmailSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { token } = parseResult.data;

    if (!isValidTokenFormat(token)) {
      throw ProblemError.badRequest('Invalid or expired token', undefined, 'INVALID_TOKEN');
    }

    const tokenHash = hashEmailToken(token);
    const now = new Date();

    const tokenRow = await db
      .selectFrom('auth.email_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (
      !tokenRow ||
      tokenRow.purpose !== 'VERIFY_EMAIL' ||
      tokenRow.used_at !== null ||
      tokenRow.expires_at <= now
    ) {
      throw ProblemError.badRequest('Invalid or expired token', undefined, 'INVALID_TOKEN');
    }

    // Lookup user
    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', tokenRow.user_id)
      .executeTakeFirst();

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.email.toLowerCase() !== tokenRow.email.toLowerCase()
    ) {
      throw ProblemError.badRequest('Invalid or expired token', undefined, 'INVALID_TOKEN');
    }

    // Mark token used and set email_verified_at in one transaction
    await db.transaction().execute(async (trx) => {
      const txNow = new Date();

      await trx
        .updateTable('auth.email_tokens')
        .set({ used_at: txNow })
        .where('id', '=', tokenRow.id)
        .execute();

      await trx
        .updateTable('auth.users')
        .set({
          email_verified_at: sql`COALESCE(email_verified_at, ${txNow})`,
          updated_at: txNow,
        })
        .where('id', '=', user.id)
        .execute();
    });

    return reply.status(204).send();
  });
};
