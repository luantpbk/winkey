import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { enqueue } from '@winkey/outbox';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  signOAuthPayload,
  verifyOAuthPayload,
  getOAuthCookieOptions,
  getClearOAuthCookieOptions,
  OAUTH_COOKIE_NAME,
} from '../crypto/pkce.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
} from '../crypto/refresh.js';
import { checkInvite } from '../tokens/invite-codes.js';
import { authRegistrationsCounter } from '../metrics.js';
import { ProblemError } from '../errors/problem.js';
import type { Env } from '../config/env.js';
import type { Database, Role, UserStatus } from '../db/types.js';
import type { Kysely, Transaction } from 'kysely';

class SuspendedOAuthError extends Error {}
class InvalidOAuthInviteError extends Error {
  constructor(public readonly reason: 'INVITE_REQUIRED' | 'INVITE_INVALID') {
    super(reason);
  }
}

async function checkOrLiftSuspension(
  trx: Transaction<Database>,
  user: { id: string; status: UserStatus; suspended_until?: Date | string | null },
): Promise<void> {
  if (user.status === 'SUSPENDED') {
    const now = new Date();
    if (user.suspended_until && new Date(user.suspended_until) <= now) {
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
    } else {
      throw new SuspendedOAuthError();
    }
  }
}

const RETURN_TO_REGEX = /^(\/[^/].*|\/)$/;
const HANDLE_REGEX = /^[A-Za-z0-9_.]{3,30}$/;

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export type GoogleTokenExchanger = (
  code: string,
  codeVerifier: string,
  env: Env,
) => Promise<GoogleUserInfo>;

export const defaultGoogleTokenExchanger: GoogleTokenExchanger = async (
  code,
  codeVerifier,
  env,
) => {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw ProblemError.badRequest('Failed to exchange authorization code with Google');
  }

  interface GoogleTokenResponse {
    access_token: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
  }

  const tokenData = (await tokenResponse.json()) as GoogleTokenResponse;
  const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userinfoResponse.ok) {
    throw ProblemError.badRequest('Failed to retrieve user profile from Google');
  }

  return (await userinfoResponse.json()) as GoogleUserInfo;
};

export const oauthRoute: FastifyPluginAsync<{
  db: Kysely<Database>;
  env: Env;
  tokenExchanger?: GoogleTokenExchanger;
}> = async (fastify, { db, env, tokenExchanger = defaultGoogleTokenExchanger }) => {
  if (!env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID.trim() === '') {
    fastify.log.warn('Google OAuth not configured');
  }

  // 1. Start Google OAuth
  fastify.get('/v1/auth/oauth/google', async (request, reply) => {
    if (!env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID.trim() === '') {
      return reply.redirect('/login?error=oauth_unavailable', 302);
    }

    const { return_to, invite_code } = request.query as {
      return_to?: string;
      invite_code?: string;
    };
    const targetReturnTo = return_to || '/';

    // Must be a relative path only
    if (!RETURN_TO_REGEX.test(targetReturnTo)) {
      throw ProblemError.badRequest('Invalid return_to: must be a relative path');
    }

    if (invite_code !== undefined) {
      if (typeof invite_code !== 'string' || invite_code.length < 1 || invite_code.length > 64) {
        throw ProblemError.badRequest('Invalid invite_code: must be between 1 and 64 characters');
      }
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const signedCookie = signOAuthPayload(
      {
        state,
        codeVerifier,
        returnTo: targetReturnTo,
        ...(invite_code ? { inviteCode: invite_code } : {}),
      },
      env.COOKIE_SECRET,
    );

    reply.setCookie(OAUTH_COOKIE_NAME, signedCookie, getOAuthCookieOptions(env));

    const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    googleAuthUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
    googleAuthUrl.searchParams.set('response_type', 'code');
    googleAuthUrl.searchParams.set('scope', 'openid email profile');
    googleAuthUrl.searchParams.set('state', state);
    googleAuthUrl.searchParams.set('code_challenge', codeChallenge);
    googleAuthUrl.searchParams.set('code_challenge_method', 'S256');

    return reply.redirect(googleAuthUrl.toString(), 302);
  });

  // 2. Google OAuth Callback
  fastify.get('/v1/auth/oauth/google/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      throw ProblemError.badRequest('Missing code or state query parameter');
    }

    // Verify session cookie
    const oauthCookie = request.cookies[OAUTH_COOKIE_NAME];
    if (!oauthCookie) {
      throw ProblemError.badRequest('Missing OAuth session cookie');
    }

    const sessionState = verifyOAuthPayload(oauthCookie, env.COOKIE_SECRET);
    if (!sessionState || sessionState.state !== state) {
      throw ProblemError.badRequest('Invalid or expired OAuth state');
    }

    // Exchange authorization code for Google profile
    const googleUser = await tokenExchanger(code, sessionState.codeVerifier, env);

    const familyId = uuidv7();
    const tokenId = uuidv7();
    const opaqueRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(opaqueRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const clientIp = request.ip || '127.0.0.1';

    // Database lookup & link in ONE transaction
    try {
      await db.transaction().execute(async (trx) => {
        // 1. Check if OAuth identity already exists
        const existingIdentity = await trx
          .selectFrom('auth.oauth_identities')
          .selectAll()
          .where('provider', '=', 'google')
          .where('subject', '=', googleUser.sub)
          .executeTakeFirst();

        let targetUserId: string;

        if (existingIdentity) {
          targetUserId = existingIdentity.user_id;
          const user = await trx
            .selectFrom('auth.users')
            .select(['id', 'status', 'suspended_until'])
            .where('id', '=', targetUserId)
            .executeTakeFirst();
          if (!user || user.status === 'DELETED') {
            throw ProblemError.unauthorized('Account inactive');
          }
          await checkOrLiftSuspension(trx, user);
        } else {
          // 2. Check if user with same email exists
          const normEmail = googleUser.email.trim().toLowerCase();
          const existingUser = await trx
            .selectFrom('auth.users')
            .selectAll()
            .where('email', '=', normEmail)
            .executeTakeFirst();

          if (existingUser) {
            targetUserId = existingUser.id;
            if (existingUser.status === 'DELETED') {
              throw ProblemError.unauthorized('Account inactive');
            }
            await checkOrLiftSuspension(trx, existingUser);
            // Link identity
            await trx
              .insertInto('auth.oauth_identities')
              .values({
                provider: 'google',
                subject: googleUser.sub,
                user_id: targetUserId,
                email: normEmail,
              })
              .execute();

            if (!existingUser.email_verified_at) {
              await trx
                .updateTable('auth.users')
                .set({ email_verified_at: new Date() })
                .where('id', '=', targetUserId)
                .execute();
            }
          } else {
            // 3. Create new user
            const inviteResult = checkInvite(env, sessionState.inviteCode);
            if (!inviteResult.ok) {
              const metricResult =
                inviteResult.reason === 'INVITE_REQUIRED' ? 'invite_required' : 'invite_invalid';
              authRegistrationsCounter.inc({ method: 'google', result: metricResult });
              throw new InvalidOAuthInviteError(inviteResult.reason);
            }

            targetUserId = uuidv7();
            const derivedHandle = await generateUniqueHandle(trx, googleUser.email);
            const displayName = (googleUser.name || derivedHandle).slice(0, 50);
            const defaultRoles: Role[] = ['viewer', 'creator'];

            await trx
              .insertInto('auth.users')
              .values({
                id: targetUserId,
                email: normEmail,
                email_verified_at: new Date(),
                password_hash: null, // OAuth-only account
                handle: derivedHandle,
                display_name: displayName,
                avatar_key: null,
                roles: defaultRoles,
                status: 'ACTIVE',
              })
              .execute();

            await trx
              .insertInto('auth.oauth_identities')
              .values({
                provider: 'google',
                subject: googleUser.sub,
                user_id: targetUserId,
                email: normEmail,
              })
              .execute();

            // Enqueue user.registered domain event
            await enqueue(
              trx,
              'auth',
              'user.registered',
              {
                user_id: targetUserId,
                handle: derivedHandle,
                method: 'google',
              },
              { producer: 'auth-svc', version: 1 },
            );

            authRegistrationsCounter.inc({ method: 'google', result: 'ok' });

            request.log.info(
              {
                user_id: targetUserId,
                handle: derivedHandle,
                invite_index: inviteResult.index,
              },
              'user registered',
            );
          }
        }

        // Create refresh token
        await trx
          .insertInto('auth.refresh_tokens')
          .values({
            id: tokenId,
            user_id: targetUserId,
            family_id: familyId,
            token_hash: tokenHash,
            parent_id: null,
            expires_at: expiresAt,
            user_agent: request.headers['user-agent'] || null,
            ip: clientIp,
          })
          .execute();
      });
    } catch (err) {
      if (err instanceof SuspendedOAuthError) {
        reply.setCookie(OAUTH_COOKIE_NAME, '', getClearOAuthCookieOptions(env));
        return reply.redirect('/login?error=ACCOUNT_SUSPENDED', 302);
      }
      if (err instanceof InvalidOAuthInviteError) {
        reply.setCookie(OAUTH_COOKIE_NAME, '', getClearOAuthCookieOptions(env));
        return reply.redirect(`/register?error=${err.reason}`, 302);
      }
      throw err;
    }

    // Set wk_rt cookie
    reply.setCookie(REFRESH_COOKIE_NAME, opaqueRefreshToken, getRefreshCookieOptions(env));
    // Clear oauth cookie
    reply.setCookie(OAUTH_COOKIE_NAME, '', getClearOAuthCookieOptions(env));

    // Redirect to relative return_to path
    return reply.redirect(sessionState.returnTo, 302);
  });
};

/**
 * Derives a sanitized unique handle from the email local-part + random suffix.
 * Must match regex ^[A-Za-z0-9_.]{3,30}$
 */
async function generateUniqueHandle(
  trx: Transaction<Database> | Kysely<Database>,
  email: string,
): Promise<string> {
  const localPart = email.split('@')[0] || 'user';
  // Sanitize characters not in [A-Za-z0-9_.]
  let cleanLocal = localPart.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, 20);
  if (cleanLocal.length < 3) {
    cleanLocal = `user_${cleanLocal}`;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(3).toString('hex'); // 6 chars
    const candidate = `${cleanLocal.slice(0, 23)}_${suffix}`;
    if (!HANDLE_REGEX.test(candidate)) continue;

    const existing = await trx
      .selectFrom('auth.users')
      .select('id')
      .where('handle', '=', candidate)
      .executeTakeFirst();

    if (!existing) {
      return candidate;
    }
  }

  return `user_${crypto.randomBytes(6).toString('hex')}`;
}
