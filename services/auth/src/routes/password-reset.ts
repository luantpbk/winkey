import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import type { RevocationService } from '../revocation/revocation.js';
import { ProblemError } from '../errors/problem.js';
import { hashPassword } from '../crypto/passwords.js';
import { generateEmailToken, hashEmailToken, isValidTokenFormat } from '../tokens/email-tokens.js';

const forgotPasswordSchema = z
  .object({
    email: z.string().email().max(254),
    locale: z.enum(['vi', 'en']).optional().default('vi'),
  })
  .strict();

const resetPasswordSchema = z
  .object({
    token: z
      .string()
      .min(43)
      .max(43)
      .regex(/^[A-Za-z0-9_-]{43}$/),
    new_password: z.string().min(8).max(128),
  })
  .strict();

export const passwordResetRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
  revocationService: RevocationService;
}> = async (fastify, { db, env, rateLimiter, revocationService }) => {
  // 1. POST /v1/auth/password/forgot (requestPasswordReset)
  fastify.post('/v1/auth/password/forgot', async (request, reply) => {
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit per IP like login (20/min)
    await rateLimiter.consume({
      key: `rl:login:ip:${clientIp}`,
      limit: 20,
      windowSeconds: 60,
    });

    const parseResult = forgotPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { email, locale } = parseResult.data;
    const normalizedEmail = email.trim().toLowerCase();

    // Look up user
    const user = await db
      .selectFrom('auth.users')
      .select(['id', 'email', 'status'])
      .where('email', '=', normalizedEmail)
      .executeTakeFirst();

    if (user && user.status === 'ACTIVE') {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentTokensCountRes = await db
        .selectFrom('auth.email_tokens')
        .select(sql<number>`count(*)::int`.as('cnt'))
        .where('user_id', '=', user.id)
        .where('purpose', '=', 'RESET_PASSWORD')
        .where('created_at', '>', oneHourAgo)
        .executeTakeFirst();

      const count = Number(recentTokensCountRes?.cnt ?? 0);

      // Max 3 reset tokens per user per hour
      if (count < 3) {
        const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
        const tokenId = uuidv7();
        const resetLink = `${env.PUBLIC_ORIGIN}/${locale}/reset-password?token=${rawToken}`;

        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto('auth.email_tokens')
            .values({
              id: tokenId,
              user_id: user.id,
              purpose: 'RESET_PASSWORD',
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
              template: 'RESET_PASSWORD',
              locale,
              params: { link: resetLink },
            })
            .execute();
        });
      } else {
        // Over user cap: perform dummy work to balance timing
        generateEmailToken('RESET_PASSWORD');
      }
    } else {
      // Unknown or inactive user: perform dummy token generation to balance timing
      generateEmailToken('RESET_PASSWORD');
    }

    // Always answers 202 Accepted with empty body
    return reply.status(202).send();
  });

  // 2. POST /v1/auth/password/reset (resetPassword)
  fastify.post('/v1/auth/password/reset', async (request, reply) => {
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit per IP like login (20/min)
    await rateLimiter.consume({
      key: `rl:login:ip:${clientIp}`,
      limit: 20,
      windowSeconds: 60,
    });

    const parseResult = resetPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { token, new_password } = parseResult.data;

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
      tokenRow.purpose !== 'RESET_PASSWORD' ||
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

    const newPasswordHash = await hashPassword(new_password);
    const acceptLang = request.headers['accept-language'];
    const locale = acceptLang?.toLowerCase().startsWith('en') ? 'en' : 'vi';

    // In one transaction:
    // - set new password
    // - mark every unused reset token of the user as used
    // - set email_verified_at if NULL
    // - revoke every refresh family
    // - queue PASSWORD_CHANGED mail
    await db.transaction().execute(async (trx) => {
      const txNow = new Date();

      await trx
        .updateTable('auth.users')
        .set({
          password_hash: newPasswordHash,
          email_verified_at: sql`COALESCE(email_verified_at, ${txNow})`,
          updated_at: txNow,
        })
        .where('id', '=', user.id)
        .execute();

      await trx
        .updateTable('auth.email_tokens')
        .set({ used_at: txNow })
        .where('user_id', '=', user.id)
        .where('purpose', '=', 'RESET_PASSWORD')
        .where('used_at', 'is', null)
        .execute();

      await trx
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: txNow })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .execute();

      await trx
        .insertInto('auth.mail_queue')
        .values({
          user_id: user.id,
          to_email: user.email,
          template: 'PASSWORD_CHANGED',
          locale,
          params: null,
        })
        .execute();
    });

    // Revoke user in Valkey AFTER DB commit (ADR-019)
    await revocationService.revokeUser(user.id);

    return reply.status(204).send();
  });
};
