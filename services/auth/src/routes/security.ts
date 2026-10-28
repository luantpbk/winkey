import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { Kysely } from 'kysely';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import type { RevocationService } from '../revocation/revocation.js';
import type { Redis } from 'ioredis';
import { ProblemError } from '../errors/problem.js';
import { verifyAccessToken, issueAccessToken, type AccessTokenClaims } from '../crypto/jwt.js';
import { verifyPassword } from '../crypto/passwords.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  getClearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { getKeyring } from '../crypto/keyring.js';
import { generateTotpSecret, matchTotpStep, buildOtpauthUri } from '../crypto/totp.js';
import { generateRecoveryCodeBatch, verifyRecoveryCode } from '../crypto/recovery.js';
import { buildVietnameseDeviceLabel } from '../security/ua-label.js';
import {
  createSession,
  extractCountry,
  revokeSession,
  revokeOtherSessions,
} from '../security/sessions.js';
import { recordSecurityEvent } from '../security/events.js';
import { checkUserMfaEnabled, computeEffectiveRoles } from '../security/staff-rules.js';
import {
  assertStepUp,
  sendStepUpEmailCode,
  verifyStepUpEmailCode,
  STEP_UP_WINDOW_MS,
} from '../security/step-up.js';
import {
  consumeMfaChallenge,
  deleteMfaChallenge,
  storePendingTotpSetup,
  consumePendingTotpSetup,
  deletePendingTotpSetup,
  recordFailedLoginAttempt,
} from '../security/mfa.js';
import { buildLoginRateLimitKeys } from '../rate-limit/valkey-limiter.js';

const mfaLoginBodySchema = z
  .object({
    mfa_token: z.string().optional(),
    method: z.enum(['totp', 'recovery_code', 'passkey']),
    code: z.string().min(6).max(32).optional(),
    flow_id: z.string().optional(),
    credential: z.any().optional(),
  })
  .strict();

const stepUpBodySchema = z
  .object({
    method: z.enum(['password', 'totp', 'passkey', 'email_code']),
    password: z.string().optional(),
    code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
    flow_id: z.string().optional(),
    credential: z.any().optional(),
  })
  .strict();

const totpConfirmBodySchema = z
  .object({
    setup_id: z.string().min(1),
    code: z.string().regex(/^[0-9]{6}$/),
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

export const securityRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
  revocationService: RevocationService;
  redis?: Redis | null;
}> = async (fastify, { db, env, rateLimiter, revocationService: _revocationService, redis }) => {
  // 1. POST /v1/auth/login/complete (completeMfaLogin)
  fastify.post('/v1/auth/login/complete', async (request, reply) => {
    const parseResult = mfaLoginBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { mfa_token: bodyMfaToken, method, code } = parseResult.data;
    const cookieMfaToken = (request.cookies as Record<string, string>)['wk_mfa'];
    const mfaToken = bodyMfaToken || cookieMfaToken;

    if (!mfaToken) {
      throw ProblemError.unauthorized('MFA token is missing or expired', 'MFA_TOKEN_INVALID');
    }

    const challengeRes = await consumeMfaChallenge(redis, mfaToken);
    if (!challengeRes.valid || !challengeRes.data) {
      throw ProblemError.unauthorized('MFA token is invalid or expired', 'MFA_TOKEN_INVALID');
    }

    const { userId, firstFactor } = challengeRes.data;
    const clientIp = request.ip || '127.0.0.1';

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('Account inactive or not found', 'INVALID_CREDENTIALS');
    }

    if (method === 'totp') {
      if (!code || !user.totp_enabled_at || !user.totp_secret_enc || !user.totp_key_id) {
        await recordFailedLoginAttempt(redis, clientIp, user.email);
        await recordSecurityEvent(db, {
          userId: user.id,
          kind: 'MFA_FAILED',
          details: { method: 'totp' },
        });
        throw ProblemError.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
      }

      let secretBase32: string;
      try {
        const keyring = getKeyring(env);
        const bufEnc = Buffer.isBuffer(user.totp_secret_enc)
          ? user.totp_secret_enc
          : Buffer.from(user.totp_secret_enc as unknown as Uint8Array);
        secretBase32 = keyring.decrypt(user.totp_key_id, bufEnc).toString('utf8');
      } catch {
        throw ProblemError.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
      }

      const matchedStep = matchTotpStep(secretBase32, code);
      if (matchedStep === null) {
        await recordFailedLoginAttempt(redis, clientIp, user.email);
        await recordSecurityEvent(db, {
          userId: user.id,
          kind: 'MFA_FAILED',
          details: { method: 'totp' },
        });
        throw ProblemError.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
      }

      // Atomic update for replay protection
      const updateResult = await db
        .updateTable('auth.users')
        .set({ totp_last_step: Number(matchedStep) })
        .where('id', '=', user.id)
        .where((eb) =>
          eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', Number(matchedStep))]),
        )
        .executeTakeFirst();

      if ((updateResult.numUpdatedRows ?? 0n) === 0n) {
        // Code replayed in the same 30s step
        await recordFailedLoginAttempt(redis, clientIp, user.email);
        await recordSecurityEvent(db, {
          userId: user.id,
          kind: 'MFA_FAILED',
          details: { method: 'totp', reason: 'replayed' },
        });
        throw ProblemError.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
      }
    } else if (method === 'recovery_code') {
      if (!code) {
        await recordFailedLoginAttempt(redis, clientIp, user.email);
        throw ProblemError.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
      }

      const unusedCodes = await db
        .selectFrom('auth.recovery_codes')
        .select(['id', 'code_hash'])
        .where('user_id', '=', user.id)
        .where('used_at', 'is', null)
        .execute();

      let matchedId: string | null = null;
      for (const row of unusedCodes) {
        if (await verifyRecoveryCode(row.code_hash, code)) {
          matchedId = row.id;
          break;
        }
      }

      if (!matchedId) {
        await recordFailedLoginAttempt(redis, clientIp, user.email);
        await recordSecurityEvent(db, {
          userId: user.id,
          kind: 'MFA_FAILED',
          details: { method: 'recovery_code' },
        });
        throw ProblemError.unauthorized('Invalid recovery code', 'MFA_CODE_INVALID');
      }

      // Mark recovery code as used
      await db
        .updateTable('auth.recovery_codes')
        .set({ used_at: new Date() })
        .where('id', '=', matchedId)
        .execute();

      await recordSecurityEvent(db, {
        userId: user.id,
        kind: 'RECOVERY_CODE_USED',
      });
    } else {
      // Passkey will be fully hooked in PR 2
      throw ProblemError.badRequest(
        'Method not supported in this phase',
        undefined,
        'METHOD_UNAVAILABLE',
      );
    }

    // MFA succeeded: delete challenge
    await deleteMfaChallenge(redis, mfaToken);

    // Create session
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
    const secondFactorMethod = method === 'totp' ? 'otp' : 'rcode';

    await createSession(db, {
      id: familyId,
      userId: user.id,
      deviceLabel,
      country,
      ipHash,
      amr: [firstFactor, secondFactorMethod],
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
        ip: null,
      })
      .execute();

    // Since MFA succeeded, effective roles include staff roles
    const { effectiveRoles, staffRolesPendingMfa } = computeEffectiveRoles(
      user.roles,
      true,
      env.STAFF_MFA_REQUIRED,
    );

    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: user.id, roles: effectiveRoles },
      familyId,
      env,
    );

    await recordSecurityEvent(db, {
      userId: user.id,
      kind: 'SIGN_IN',
      sessionId: familyId,
      deviceLabel,
      country,
    });

    // Clear wk_mfa cookie
    reply.setCookie('wk_mfa', '', {
      path: '/v1/auth/login',
      httpOnly: true,
      secure: env.NODE_ENV === 'production' || env.PUBLIC_ORIGIN.startsWith('https://'),
      sameSite: 'lax',
      maxAge: 0,
    });

    // Set wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, opaqueRefreshToken, getRefreshCookieOptions(env));

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
        mfa_enabled: true,
        created_at: new Date(user.created_at).toISOString(),
      },
    });
  });

  // 2. POST /v1/auth/me/step-up (stepUp)
  fastify.post('/v1/auth/me/step-up', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;
    const clientIp = request.ip || '127.0.0.1';

    // Rate limit like login
    const { ipEmailKey, ipKey } = buildLoginRateLimitKeys(clientIp, `user:${userId}`);
    await rateLimiter.consume({ key: ipEmailKey, limit: 5, windowSeconds: 60 });
    await rateLimiter.consume({ key: ipKey, limit: 20, windowSeconds: 60 });

    const parseResult = stepUpBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { method, password, code } = parseResult.data;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    if (method === 'password') {
      if (user.password_hash === null) {
        throw ProblemError.badRequest(
          'Password authentication not available for this account',
          undefined,
          'METHOD_UNAVAILABLE',
        );
      }
      if (!password) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
      const isValid = await verifyPassword(user.password_hash, password);
      if (!isValid) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
    } else if (method === 'totp') {
      if (!user.totp_enabled_at || !user.totp_secret_enc || !user.totp_key_id) {
        throw ProblemError.badRequest(
          'TOTP not enabled for this account',
          undefined,
          'METHOD_UNAVAILABLE',
        );
      }
      if (!code) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }

      let secretBase32: string;
      try {
        const keyring = getKeyring(env);
        const bufEnc = Buffer.isBuffer(user.totp_secret_enc)
          ? user.totp_secret_enc
          : Buffer.from(user.totp_secret_enc as unknown as Uint8Array);
        secretBase32 = keyring.decrypt(user.totp_key_id, bufEnc).toString('utf8');
      } catch {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }

      const matchedStep = matchTotpStep(secretBase32, code);
      if (matchedStep === null) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }

      const updateResult = await db
        .updateTable('auth.users')
        .set({ totp_last_step: Number(matchedStep) })
        .where('id', '=', user.id)
        .where((eb) =>
          eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', Number(matchedStep))]),
        )
        .executeTakeFirst();

      if ((updateResult.numUpdatedRows ?? 0n) === 0n) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
    } else if (method === 'email_code') {
      if (!code) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
      const ok = await verifyStepUpEmailCode(redis, sessionId, code);
      if (!ok) {
        throw ProblemError.forbidden('Invalid credentials', 'INVALID_CREDENTIALS');
      }
    } else {
      throw ProblemError.badRequest(
        'Method not supported in this phase',
        undefined,
        'METHOD_UNAVAILABLE',
      );
    }

    const now = new Date();
    const validUntil = new Date(now.getTime() + STEP_UP_WINDOW_MS);

    const updateResult = await db
      .updateTable('auth.sessions')
      .set({
        step_up_at: now,
      })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if ((updateResult.numUpdatedRows ?? 0n) === 0n) {
      throw ProblemError.unauthorized('Session not found', 'SESSION_NOT_FOUND');
    }

    await recordSecurityEvent(db, {
      userId: user.id,
      kind: 'STEP_UP',
      sessionId,
      details: { method },
    });

    return reply.status(200).send({
      step_up_until: validUntil.toISOString(),
    });
  });

  // 3. POST /v1/auth/me/step-up/email-code (sendStepUpEmailCode)
  fastify.post('/v1/auth/me/step-up/email-code', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    await sendStepUpEmailCode(db, redis, sessionId, user.id, user.email);
    return reply.status(202).send();
  });

  // 4. GET /v1/auth/me/security (getMySecurity)
  fastify.get('/v1/auth/me/security', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    const totpEnabled = user.totp_enabled_at != null;

    const passkeyCountRow = await db
      .selectFrom('auth.passkeys')
      .select((eb) => eb.fn.count<number>('id').as('cnt'))
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const passkeyCount = Number(passkeyCountRow?.cnt ?? 0);

    const mfaEnabled = totpEnabled || passkeyCount > 0;

    const recoveryCodesRow = await db
      .selectFrom('auth.recovery_codes')
      .select((eb) => eb.fn.count<number>('id').as('cnt'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    const recoveryCodesRemaining = Number(recoveryCodesRow?.cnt ?? 0);

    const session = await db
      .selectFrom('auth.sessions')
      .select(['step_up_at', 'revoked_at'])
      .where('id', '=', sessionId)
      .executeTakeFirst();

    let stepUpUntil: string | null = null;
    if (session && session.step_up_at && !session.revoked_at) {
      const stepUpTime = new Date(session.step_up_at).getTime();
      const elapsed = Date.now() - stepUpTime;
      if (elapsed >= 0 && elapsed <= STEP_UP_WINDOW_MS) {
        stepUpUntil = new Date(stepUpTime + STEP_UP_WINDOW_MS).toISOString();
      }
    }

    const { staffRolesPendingMfa } = computeEffectiveRoles(
      user.roles,
      mfaEnabled,
      env.STAFF_MFA_REQUIRED,
    );

    return reply.status(200).send({
      mfa_enabled: mfaEnabled,
      totp_enabled: totpEnabled,
      passkey_count: passkeyCount,
      recovery_codes_remaining: recoveryCodesRemaining,
      has_password: user.password_hash != null,
      step_up_until: stepUpUntil,
      staff_roles_pending_mfa: staffRolesPendingMfa,
    });
  });

  // 5. POST /v1/auth/me/totp (startTotpSetup) - Needs step-up
  fastify.post('/v1/auth/me/totp', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    await assertStepUp(db, sessionId);

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    if (user.totp_enabled_at != null) {
      throw ProblemError.conflict(
        'TOTP is already enabled for this account',
        'TOTP_ALREADY_ENABLED',
      );
    }

    const setupId = uuidv7();
    const secret = generateTotpSecret();
    const otpauthUri = buildOtpauthUri(user.handle, secret);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const keyring = getKeyring(env);
    const { keyId, payload } = keyring.encrypt(secret);
    await storePendingTotpSetup(redis, setupId, userId, payload, keyId);

    return reply.status(201).send({
      setup_id: setupId,
      secret,
      otpauth_uri: otpauthUri,
      expires_at: expiresAt,
    });
  });

  // 6. POST /v1/auth/me/totp/confirm (confirmTotpSetup)
  fastify.post('/v1/auth/me/totp/confirm', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    const parseResult = totpConfirmBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw ProblemError.badRequest('Validation failed', fieldErrors, 'VALIDATION_FAILED');
    }

    const { setup_id, code } = parseResult.data;

    const pending = await consumePendingTotpSetup(redis, setup_id);
    if (!pending.valid || !pending.data || pending.data.userId !== userId) {
      throw ProblemError.notFound('TOTP setup session not found or expired');
    }

    const keyring = getKeyring(env);
    let secretBase32: string;
    try {
      const bufEnc = Buffer.from(pending.data.encryptedSecret, 'base64');
      secretBase32 = keyring.decrypt(pending.data.keyId, bufEnc).toString('utf8');
    } catch {
      throw ProblemError.notFound('TOTP setup session not found or expired');
    }

    const matchedStep = matchTotpStep(secretBase32, code);
    if (matchedStep === null) {
      await recordSecurityEvent(db, {
        userId,
        kind: 'MFA_FAILED',
        sessionId,
        details: { method: 'totp_setup' },
      });
      throw ProblemError.badRequest('Invalid verification code', undefined, 'MFA_CODE_INVALID');
    }

    // Success: save encrypted secret and keyId into DB
    const bufEnc = Buffer.from(pending.data.encryptedSecret, 'base64');
    const keyId = pending.data.keyId;
    await deletePendingTotpSetup(redis, setup_id);

    let recoveryCodes: string[] | null = null;

    await db.transaction().execute(async (trx) => {
      const now = new Date();
      await trx
        .updateTable('auth.users')
        .set({
          totp_secret_enc: bufEnc,
          totp_key_id: keyId,
          totp_enabled_at: now,
          totp_last_step: Number(matchedStep),
        })
        .where('id', '=', userId)
        .execute();

      // Check if account already has recovery codes (e.g. from passkey)
      const existingCodesRow = await trx
        .selectFrom('auth.recovery_codes')
        .select((eb) => eb.fn.count<number>('id').as('cnt'))
        .where('user_id', '=', userId)
        .executeTakeFirst();

      const existingCodesCount = Number(existingCodesRow?.cnt ?? 0);
      if (existingCodesCount === 0) {
        const batch = await generateRecoveryCodeBatch(10);
        recoveryCodes = batch.formattedCodes;

        for (const h of batch.hashes) {
          await trx
            .insertInto('auth.recovery_codes')
            .values({
              id: uuidv7(),
              user_id: userId,
              code_hash: h,
              created_at: now,
              used_at: null,
            })
            .execute();
        }

        await recordSecurityEvent(trx, {
          userId,
          kind: 'RECOVERY_CODES_GENERATED',
          sessionId,
        });
      }

      await recordSecurityEvent(trx, {
        userId,
        kind: 'TOTP_ENABLED',
        sessionId,
      });
    });

    return reply.status(200).send({
      recovery_codes: recoveryCodes,
    });
  });

  // 7. DELETE /v1/auth/me/totp (disableTotp) - Needs step-up
  fastify.delete('/v1/auth/me/totp', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    await assertStepUp(db, sessionId);

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.totp_enabled_at === null) {
      throw ProblemError.notFound('TOTP is not enabled for this account');
    }

    const passkeyCountRow = await db
      .selectFrom('auth.passkeys')
      .select((eb) => eb.fn.count<number>('id').as('cnt'))
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const passkeyCount = Number(passkeyCountRow?.cnt ?? 0);

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('auth.users')
        .set({
          totp_secret_enc: null,
          totp_key_id: null,
          totp_enabled_at: null,
          totp_last_step: null,
        })
        .where('id', '=', userId)
        .execute();

      // If no passkeys remain either, delete recovery codes and revoke every other session
      if (passkeyCount === 0) {
        await trx.deleteFrom('auth.recovery_codes').where('user_id', '=', userId).execute();

        await revokeOtherSessions(trx as any, redis, userId, sessionId, 'MFA_DISABLED');
      }

      await recordSecurityEvent(trx, {
        userId,
        kind: 'TOTP_DISABLED',
        sessionId,
      });
    });

    return reply.status(204).send();
  });

  // 8. POST /v1/auth/me/recovery-codes (regenerateRecoveryCodes) - Needs step-up
  fastify.post('/v1/auth/me/recovery-codes', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    await assertStepUp(db, sessionId);

    const user = await db
      .selectFrom('auth.users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    if (!user || user.status !== 'ACTIVE') {
      throw ProblemError.unauthorized('User not found or inactive');
    }

    const hasMfa = await checkUserMfaEnabled(db, userId, user.totp_enabled_at);
    if (!hasMfa) {
      throw ProblemError.conflict('MFA is not enabled on this account', 'MFA_NOT_ENABLED');
    }

    const batch = await generateRecoveryCodeBatch(10);
    const now = new Date();

    await db.transaction().execute(async (trx) => {
      // Invalidate old recovery codes
      await trx.deleteFrom('auth.recovery_codes').where('user_id', '=', userId).execute();

      for (const h of batch.hashes) {
        await trx
          .insertInto('auth.recovery_codes')
          .values({
            id: uuidv7(),
            user_id: userId,
            code_hash: h,
            created_at: now,
            used_at: null,
          })
          .execute();
      }

      await recordSecurityEvent(trx, {
        userId,
        kind: 'RECOVERY_CODES_GENERATED',
        sessionId,
      });
    });

    return reply.status(200).send({
      recovery_codes: batch.formattedCodes,
    });
  });

  // 9. GET /v1/auth/me/sessions (listMySessions)
  fastify.get('/v1/auth/me/sessions', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const sessionId = claims.sid;

    const rows = await db
      .selectFrom('auth.sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('last_used_at', 'desc')
      .limit(50)
      .execute();

    const items = rows.map((r) => ({
      id: r.id,
      current: r.id === sessionId,
      device_label: r.device_label,
      country: r.country,
      created_at: new Date(r.created_at).toISOString(),
      last_used_at: new Date(r.last_used_at).toISOString(),
      methods: r.amr || [],
    }));

    return reply.status(200).send({
      items,
    });
  });

  // 10. DELETE /v1/auth/me/sessions/:id (revokeMySession)
  fastify.delete('/v1/auth/me/sessions/:id', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const currentSessionId = claims.sid;
    const targetSessionId = (request.params as { id: string }).id;

    const session = await db
      .selectFrom('auth.sessions')
      .select('id')
      .where('id', '=', targetSessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!session) {
      throw ProblemError.notFound('Session not found or already revoked');
    }

    await revokeSession(db, redis, targetSessionId, 'USER_REVOKED');

    await recordSecurityEvent(db, {
      userId,
      kind: 'SESSION_REVOKED',
      sessionId: targetSessionId,
    });

    // If caller revoked their own session, clear wk_rt cookie
    if (targetSessionId === currentSessionId) {
      reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));
    }

    return reply.status(204).send();
  });

  // 11. POST /v1/auth/me/sessions/revoke-others (revokeOtherSessions)
  fastify.post('/v1/auth/me/sessions/revoke-others', async (request, reply) => {
    const claims = await extractBearerClaims(request, env);
    const userId = claims.sub;
    const currentSessionId = claims.sid;

    const revokedCount = await revokeOtherSessions(
      db,
      redis,
      userId,
      currentSessionId,
      'REVOKE_OTHERS',
    );

    await recordSecurityEvent(db, {
      userId,
      kind: 'OTHER_SESSIONS_REVOKED',
      sessionId: currentSessionId,
      details: { revoked: revokedCount },
    });

    return reply.status(200).send({
      revoked: revokedCount,
    });
  });
};
