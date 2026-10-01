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
    const started = process.hrtime.bigint();
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

    // Floor timing mitigation: minimum 250 ms for any 202 response
    const floorMs = 250;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs < floorMs) {
      await new Promise((r) => setTimeout(r, floorMs - elapsedMs));
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
    // Hash password with argon2id BEFORE opening transaction to avoid holding locks
    const newPasswordHash = await hashPassword(new_password);
    const acceptLang = request.headers['accept-language'];
    const locale = acceptLang?.toLowerCase().startsWith('en') ? 'en' : 'vi';

    let targetUserId: string;

    // In one atomic transaction:
    // 1. Claim the token conditionally (UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING ...)
    // 2. Lock the user FOR UPDATE and verify ACTIVE and matching email
    // 3. Update password_hash, email_verified_at
    // 4. Mark all other unused RESET tokens of this user as used
    // 5. Revoke every refresh family
    // 6. Queue PASSWORD_CHANGED mail
    await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable('auth.email_tokens')
        .set({ used_at: sql`now()` })
        .where('token_hash', '=', tokenHash)
        .where('purpose', '=', 'RESET_PASSWORD')
        .where('used_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .returning(['user_id', 'email'])
        .executeTakeFirst();

      if (!claimed) {
        throw ProblemError.badRequest('Invalid or expired token', undefined, 'INVALID_TOKEN');
      }

      const user = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', claimed.user_id)
        .forUpdate()
        .executeTakeFirst();

      if (
        !user ||
        user.status !== 'ACTIVE' ||
        user.email.toLowerCase() !== claimed.email.toLowerCase()
      ) {
        throw ProblemError.badRequest('Invalid or expired token', undefined, 'INVALID_TOKEN');
      }

      targetUserId = user.id;
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
    await revocationService.revokeUser(targetUserId!);

    return reply.status(204).send();
  });
};
