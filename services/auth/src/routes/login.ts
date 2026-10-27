import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { verifyPassword, hashPassword, needsRehash } from '../crypto/passwords.js';
import { issueAccessToken } from '../crypto/jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { ProblemError } from '../errors/problem.js';
import { buildLoginRateLimitKeys } from '../rate-limit/valkey-limiter.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import type { Redis } from 'ioredis';
import { getKeyring } from '../crypto/keyring.js';
import { buildVietnameseDeviceLabel } from '../security/ua-label.js';
import { createSession, extractCountry } from '../security/sessions.js';
import { recordSecurityEvent } from '../security/events.js';
import { checkUserMfaEnabled, computeEffectiveRoles } from '../security/staff-rules.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import {
  createMfaChallenge,
  getFailedLoginAttempts,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
} from '../security/mfa.js';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  turnstile_token: z.string().optional(),
});

export const loginRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
  redis?: Redis | null;
}> = async (fastify, { db, env, rateLimiter, redis }) => {
  fastify.post('/v1/auth/login', async (request, reply) => {
    // 1. Validate request body
    const parseResult = loginBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { email, password, turnstile_token } = parseResult.data;
    const clientIp = request.ip || '127.0.0.1';

    // Captcha check if 3+ failed logins in the last 15 minutes
    if (env.TURNSTILE_SECRET) {
      const failedCount = await getFailedLoginAttempts(redis, clientIp, email);
      if (failedCount >= 3) {
        if (!turnstile_token) {
          throw ProblemError.badRequest(
            'Captcha verification required',
            undefined,
            'CAPTCHA_REQUIRED',
          );
        }
        const validCaptcha = await verifyTurnstileToken({
          secret: env.TURNSTILE_SECRET,
          token: turnstile_token,
          ip: clientIp,
        });
        if (!validCaptcha) {
          throw ProblemError.badRequest('Invalid captcha token', undefined, 'CAPTCHA_INVALID');
        }
      }
    }

    // 2. Rate limiting: 5/min per IP+email AND 20/min per IP
    const { ipEmailKey, ipKey } = buildLoginRateLimitKeys(clientIp, email);
    await rateLimiter.consume({ key: ipEmailKey, limit: 5, windowSeconds: 60 });
    await rateLimiter.consume({ key: ipKey, limit: 20, windowSeconds: 60 });

    // 3. Look up user by email
    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();

    if (!user || user.status === 'DELETED' || !user.password_hash) {
      await recordFailedLoginAttempt(redis, clientIp, email);
      throw ProblemError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // 4. Verify password
    const isValid = await verifyPassword(user.password_hash, password);
    if (!isValid) {
      await recordFailedLoginAttempt(redis, clientIp, email);
      throw ProblemError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // Check account suspension after password verification
    if (user.status === 'SUSPENDED') {
      const now = new Date();
      if (user.suspended_until && new Date(user.suspended_until) <= now) {
        // Auto-lift expired temporary suspension in a single transaction
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('auth.users')
            .set({
              status: 'ACTIVE',
              suspended_until: null,
              suspension_reason: null,
              updated_at: now,
            })
            .where('id', '=', user.id)
            .execute();

          await trx
            .insertInto('auth.audit_log')
            .values({
              id: uuidv7(),
              actor_id: user.id,
              action: 'USER_UNSUSPENDED',
              target_user_id: user.id,
              details: JSON.stringify({ expired: true }),
            })
            .execute();
        });
        user.status = 'ACTIVE';
      } else {
        const detail = user.suspended_until
          ? `Account is suspended until ${new Date(user.suspended_until).toISOString()}`
          : 'Account is suspended';
        throw ProblemError.accountSuspended(detail);
      }
    }

    if (user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // Password verified: clear failed attempt counter
    await clearFailedLoginAttempts(redis, clientIp, email);

    // 5. Rehash on login if parameters changed
    if (needsRehash(user.password_hash)) {
      const newHash = await hashPassword(password);
      await db
        .updateTable('auth.users')
        .set({ password_hash: newHash })
        .where('id', '=', user.id)
        .execute();
    }

    // Check if account has 2FA (TOTP or Passkey)
    const hasMfa = await checkUserMfaEnabled(db, user.id, user.totp_enabled_at);
    if (hasMfa) {
      const methods: ('totp' | 'passkey' | 'recovery_code')[] = [];
      if (user.totp_enabled_at) {
        methods.push('totp');
      }

      const passkeyCountRow = await db
        .selectFrom('auth.passkeys')
        .select((eb) => eb.fn.count<number>('id').as('count'))
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      const passkeyCount = Number(passkeyCountRow?.count ?? 0);
      if (passkeyCount > 0) {
        methods.push('passkey');
      }

      const unusedRecovery = await db
        .selectFrom('auth.recovery_codes')
        .select('id')
        .where('user_id', '=', user.id)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (unusedRecovery) {
        methods.push('recovery_code');
      }

      const mfaToken = await createMfaChallenge(redis, user.id, 'pwd');

      return reply.status(200).send({
        mfa_required: true,
        mfa_token: mfaToken,
        methods,
        expires_in: 300,
      });
    }

    // Non-MFA sign-in: create session and issue tokens
    const familyId = uuidv7();
    const tokenId = uuidv7();
    const opaqueRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(opaqueRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const ua = request.headers['user-agent'] || null;
    const deviceLabel = buildVietnameseDeviceLabel(ua);
    const country = extractCountry(request, env);
    const keyring = getKeyring(env);
    const ipHash = keyring.hashIp(clientIp);

    await createSession(db, {
      id: familyId,
      userId: user.id,
      deviceLabel,
      country,
      ipHash,
      amr: ['pwd'],
    });

    await db
      .insertInto('auth.refresh_tokens')
      .values({
        id: tokenId,
        user_id: user.id,
        family_id: familyId,
        token_hash: tokenHash,
        parent_id: null,
        expires_at: expiresAt,
        user_agent: ua,
        ip: null, // ADR-049: no longer write IP in clear
      })
      .execute();

    // Compute effective roles based on STAFF_MFA_REQUIRED
    const { effectiveRoles, staffRolesPendingMfa } = computeEffectiveRoles(
      user.roles,
      false,
      env.STAFF_MFA_REQUIRED,
    );

    // Issue access JWT
    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: user.id, roles: effectiveRoles },
      familyId,
      env,
    );

    // Record SIGN_IN event
    await recordSecurityEvent(db, {
      userId: user.id,
      kind: 'SIGN_IN',
      sessionId: familyId,
      deviceLabel,
      country,
    });

    // Set wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, opaqueRefreshToken, getRefreshCookieOptions(env));

    // Format response
    return reply.status(200).send({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified_at != null,
        handle: user.handle,
        display_name: user.display_name,
        avatar_url: user.avatar_key ? `${env.MEDIA_BASE_URL}/${user.avatar_key}` : null,
        roles: effectiveRoles,
        staff_roles_pending_mfa: staffRolesPendingMfa,
        mfa_enabled: false,
        created_at: new Date(user.created_at).toISOString(),
      },
    });
  });
};
