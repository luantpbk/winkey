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
import type { RevocationService } from '../revocation/revocation.js';
import { authRefreshCounter } from '../metrics.js';
import { createSession, extractCountry, touchSession } from '../security/sessions.js';
import { buildVietnameseDeviceLabel } from '../security/ua-label.js';
import { getKeyring } from '../crypto/keyring.js';
import { checkUserMfaEnabled, computeEffectiveRoles } from '../security/staff-rules.js';

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '').toLowerCase();
}

export const refreshRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  revocationService: RevocationService;
}> = async (fastify, { db, env, revocationService }) => {
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

      // Check session table
      const session = await trx
        .selectFrom('auth.sessions')
        .select(['id', 'revoked_at'])
        .where('id', '=', token.family_id)
        .forUpdate()
        .executeTakeFirst();

      // Expired or revoked token or revoked session
      const isExpired = new Date(token.expires_at).getTime() <= Date.now();
      const isRevoked = token.revoked_at != null || (session && session.revoked_at != null);

      if (isExpired || isRevoked) {
        throw ProblemError.unauthorized('Refresh token is expired or revoked');
      }

      // Backfill session if missing (pre-SOC-1a sign-ins, ADR-049 addendum)
      if (!session) {
        const clientIp = request.ip;
        const ua = request.headers['user-agent'] || null;
        const deviceLabel = buildVietnameseDeviceLabel(ua);
        const country = extractCountry(request, env);
        const keyring = getKeyring(env);
        const ipHash = keyring.hashIp(clientIp);

        await createSession(trx, {
          id: token.family_id,
          userId: token.user_id,
          deviceLabel,
          country,
          ipHash,
          amr: [],
        });
      }

      let isGraceRetry = false;
      const now = new Date();

      // Reuse detection or Grace retry (ADR-019 addendum)
      if (token.rotated_at != null) {
        const graceMs = env.REFRESH_REUSE_GRACE * 1000;
        const elapsedMs = now.getTime() - new Date(token.rotated_at).getTime();
        const isWithinGrace = env.REFRESH_REUSE_GRACE > 0 && elapsedMs >= 0 && elapsedMs <= graceMs;

        // Query and lock all direct children in ascending ID order to prevent deadlock
        const children = await trx
          .selectFrom('auth.refresh_tokens')
          .select(['id', 'rotated_at', 'revoked_at'])
          .where('family_id', '=', token.family_id)
          .where('parent_id', '=', token.id)
          .orderBy('id', 'asc')
          .forUpdate()
          .execute();

        const hasUsedChild = children.some((child) => child.rotated_at !== null);

        if (isWithinGrace && !hasUsedChild) {
          // Grace retry: revoke unused children from previous rotation
          await trx
            .updateTable('auth.refresh_tokens')
            .set({ revoked_at: now })
            .where('family_id', '=', token.family_id)
            .where('parent_id', '=', token.id)
            .where('revoked_at', 'is', null)
            .execute();

          isGraceRetry = true;
          // Parent's rotated_at is IMMUTABLE during grace retry to prevent sliding grace window
        } else {
          // Outside grace window OR child token was already used -> Revoke whole family
          await trx
            .updateTable('auth.refresh_tokens')
            .set({ revoked_at: now })
            .where('family_id', '=', token.family_id)
            .where('revoked_at', 'is', null)
            .execute();

          await trx
            .updateTable('auth.sessions')
            .set({ revoked_at: now, revoke_reason: 'REUSE_DETECTED' })
            .where('id', '=', token.family_id)
            .where('revoked_at', 'is', null)
            .execute();

          return {
            kind: 'reuse' as const,
            familyId: token.family_id,
            userId: token.user_id,
            tokenId: token.id,
          };
        }
      }

      // Normal rotation or Grace retry: generate new child refresh token
      const newOpaqueToken = generateRefreshToken();
      const newTokenHash = hashRefreshToken(newOpaqueToken);
      const newChildId = uuidv7();

      if (!isGraceRetry) {
        // Mark current token as rotated
        await trx
          .updateTable('auth.refresh_tokens')
          .set({ rotated_at: now })
          .where('id', '=', token.id)
          .execute();
      }

      // Insert new child refresh token (stop writing ip)
      await trx
        .insertInto('auth.refresh_tokens')
        .values({
          id: newChildId,
          user_id: token.user_id,
          family_id: token.family_id,
          token_hash: newTokenHash,
          parent_id: token.id,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          user_agent: request.headers['user-agent'] || null,
          ip: null, // ADR-049: no longer write IP in clear
        })
        .execute();

      // Read user details
      const user = await trx
        .selectFrom('auth.users')
        .selectAll()
        .where('id', '=', token.user_id)
        .executeTakeFirst();

      // Auto-lift expired suspension if needed
      if (
        user &&
        user.status === 'SUSPENDED' &&
        user.suspended_until &&
        new Date(user.suspended_until) <= new Date()
      ) {
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
        user.status = 'ACTIVE';
      }

      if (!user || user.status !== 'ACTIVE') {
        throw ProblemError.unauthorized('Account inactive or not found');
      }

      return {
        kind: isGraceRetry ? ('grace_retry' as const) : ('ok' as const),
        user,
        familyId: token.family_id,
        newOpaqueToken,
        tokenId: token.id,
        newChildId,
      };
    });

    if (result.kind === 'reuse') {
      // Valkey revocation AFTER DB commit
      await revocationService.revokeSession(result.familyId);

      request.log.warn(
        {
          family_id: result.familyId,
          user_id: result.userId,
          token_id: result.tokenId,
          ip: request.ip,
        },
        'refresh token reuse: family revoked',
      );

      reply.setCookie(REFRESH_COOKIE_NAME, '', getClearRefreshCookieOptions(env));
      throw ProblemError.unauthorized('Refresh token reuse detected');
    }

    if (result.kind === 'grace_retry') {
      authRefreshCounter.inc({ result: 'grace_retry' });
      request.log.info(
        {
          family_id: result.familyId,
          token_id: result.tokenId,
          new_token_id: result.newChildId,
          user_id: result.user.id,
        },
        'refresh retry within grace',
      );
    }

    // Touch session (throttled to at most once per minute)
    await touchSession(db, (revocationService as any).redis ?? null, result.familyId);

    // Compute effective roles based on MFA status
    const hasMfa = await checkUserMfaEnabled(db, result.user.id, result.user.totp_enabled_at);
    const { effectiveRoles, staffRolesPendingMfa } = computeEffectiveRoles(
      result.user.roles,
      hasMfa,
      env.STAFF_MFA_REQUIRED,
    );

    // 4. Issue new access token with effective roles
    const { token: accessToken, expiresIn } = await issueAccessToken(
      { id: result.user.id, roles: effectiveRoles },
      result.familyId,
      env,
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
        avatar_url: result.user.avatar_key
          ? `${env.MEDIA_BASE_URL}/${result.user.avatar_key}`
          : null,
        roles: effectiveRoles,
        staff_roles_pending_mfa: staffRolesPendingMfa,
        mfa_enabled: hasMfa,
        created_at: new Date(result.user.created_at).toISOString(),
      },
    });
  });
};
