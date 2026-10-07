import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../src/server.js';
import { getEnv, type Env } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';
import { OAUTH_COOKIE_NAME } from '../../src/crypto/pkce.js';
import { validate as isValidUuid, version as uuidVersion } from 'uuid';
import fastify, { type FastifyInstance } from 'fastify';
import { oauthRoute } from '../../src/routes/oauth.js';

describe('auth-svc full integration flow', () => {
  const keys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_KID: 'winkey-auth-key-1',
    JWT_ISSUER: 'https://winkey.vn',
    PUBLIC_ORIGIN: 'https://winkey.vn',
    MEDIA_BASE_URL: 'https://media.winkey.vn',
    GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
    NODE_ENV: 'test',
  });

  let store: MockStore;
  let app: any;

  beforeEach(async () => {
    store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter(); // In-memory rate limiter

    app = await buildApp({
      env,
      db,
      rateLimiter,
      googleTokenExchanger: async (code, _verifier) => ({
        sub: `google-sub-${code}`,
        email: `${code}@gmail.com`,
        email_verified: true,
        name: `Google User ${code}`,
      }),
    });
  });

  it('Register: happy path returns 201, sets wk_rt cookie, and atomically enqueues outbox event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice@winkey.vn',
        password: 'Password123!',
        handle: 'alice_streamer',
        display_name: 'Alice Streamer',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Verify TokenResponse structure
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
    expect(typeof body.access_token).toBe('string');
    expect(body.user.email).toBe('alice@winkey.vn');
    expect(body.user.handle).toBe('alice_streamer');
    expect(body.user.roles).toEqual(['viewer', 'creator']);
    expect(isValidUuid(body.user.id)).toBe(true);

    // Verify Set-Cookie header
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`${REFRESH_COOKIE_NAME}=`);
    expect(setCookie).toContain('Path=/v1/auth');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('HttpOnly');

    // Verify database atomic outbox insertion
    expect(store.outbox.length).toBe(1);
    const outboxRow = store.outbox[0];
    expect(outboxRow.subject).toBe('user.registered');
    expect(outboxRow.payload.type).toBe('user.registered');
    expect(outboxRow.payload.producer).toBe('auth-svc');
    expect(outboxRow.payload.data.user_id).toBe(body.user.id);
    expect(outboxRow.payload.data.handle).toBe('alice_streamer');
    expect(outboxRow.payload.data.method).toBe('password');
    expect(uuidVersion(outboxRow.event_id)).toBe(7);

    // Verify refresh token stored in DB as hash
    expect(store.refresh_tokens.length).toBe(1);
    expect(store.refresh_tokens[0].user_id).toBe(body.user.id);
    expect(store.refresh_tokens[0].token_hash.length).toBe(32);
  });

  it('Register: rejects duplicate email with 409 EMAIL_TAKEN', async () => {
    // Register first user
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice@winkey.vn',
        password: 'Password123!',
        handle: 'alice_1',
        display_name: 'Alice One',
      },
    });

    // Try registering same email with different handle
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice@winkey.vn',
        password: 'Password123!',
        handle: 'alice_2',
        display_name: 'Alice Two',
      },
    });

    expect(res.statusCode).toBe(409);
    const problem = res.json();
    expect(problem.code).toBe('EMAIL_TAKEN');
    expect(problem.title).toBe('Conflict');
  });

  it('Register: rejects duplicate handle with 409 HANDLE_TAKEN', async () => {
    // Register first user
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice@winkey.vn',
        password: 'Password123!',
        handle: 'unique_handle',
        display_name: 'Alice',
      },
    });

    // Try registering same handle with different email
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'bob@winkey.vn',
        password: 'Password123!',
        handle: 'unique_handle',
        display_name: 'Bob',
      },
    });

    expect(res.statusCode).toBe(409);
    const problem = res.json();
    expect(problem.code).toBe('HANDLE_TAKEN');
  });

  it('Register: returns 400 with field-level errors for invalid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'invalid-email',
        password: 'short',
        handle: 'a', // Too short
        display_name: '',
      },
    });

    expect(res.statusCode).toBe(400);
    const problem = res.json();
    expect(problem.title).toBe('Bad Request');
    expect(problem.errors).toBeDefined();
    expect(problem.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('Login: happy path and invalid credentials', async () => {
    // Register user
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'login_test@winkey.vn',
        password: 'Password123!',
        handle: 'login_test',
        display_name: 'Login Test',
      },
    });

    // Wrong password
    const wrongRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'login_test@winkey.vn', password: 'WrongPassword!' },
    });
    expect(wrongRes.statusCode).toBe(401);
    expect(wrongRes.json().code).toBe('INVALID_CREDENTIALS');

    // Unknown user
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'unknown@winkey.vn', password: 'Password123!' },
    });
    expect(unknownRes.statusCode).toBe(401);

    // Correct password
    const okRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'login_test@winkey.vn', password: 'Password123!' },
    });
    expect(okRes.statusCode).toBe(200);
    const body = okRes.json();
    expect(body.access_token).toBeDefined();
    expect(okRes.headers['set-cookie']).toContain('wk_rt=');
  });

  it('Refresh: normal rotation and REUSE DETECTION REVOKES WHOLE FAMILY', async () => {
    // 1. Register user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'refresh_test@winkey.vn',
        password: 'Password123!',
        handle: 'refresh_test',
        display_name: 'Refresh Test',
      },
    });

    // Extract initial cookie
    const initialCookie = regRes.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. First refresh (Rotation)
    const refresh1Res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
    });
    expect(refresh1Res.statusCode).toBe(200);
    const rotatedCookie = refresh1Res.cookies.find(
      (c: any) => c.name === REFRESH_COOKIE_NAME,
    )!.value;
    expect(rotatedCookie).not.toBe(initialCookie);

    // 3. TOKEN REUSE DETECTION!
    // An attacker or compromised client presents the OLD (already rotated) initialCookie again!
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
    });
    expect(reuseRes.statusCode).toBe(401);

    // 4. Verify THAT THE ENTIRE FAMILY IS NOW REVOKED
    // Presenting the valid, newest rotatedCookie MUST NOW ALSO FAIL because the family was revoked!
    const followUpRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: rotatedCookie },
    });
    expect(followUpRes.statusCode).toBe(401);

    // Check store in DB: all tokens for this family should have revoked_at != null
    const familyTokens = store.refresh_tokens;
    expect(familyTokens.length).toBe(2);
    expect(familyTokens[0].revoked_at).not.toBeNull();
    expect(familyTokens[1].revoked_at).not.toBeNull();
  });

  it('Refresh and Logout: reject when Origin header is present and != PUBLIC_ORIGIN', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'origin_test@winkey.vn',
        password: 'Password123!',
        handle: 'origin_test',
        display_name: 'Origin Test',
      },
    });
    const cookie = regRes.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

    // Reject refresh from malicious origin
    const badRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Origin: 'https://malicious-site.com' },
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });
    expect(badRefresh.statusCode).toBe(401);

    // Reject logout from malicious origin
    const badLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { Origin: 'https://malicious-site.com' },
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });
    expect(badLogout.statusCode).toBe(401);

    // Accept refresh from valid PUBLIC_ORIGIN
    const goodRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Origin: 'https://winkey.vn' },
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });
    expect(goodRefresh.statusCode).toBe(200);
  });

  it('Logout: revokes family and clears wk_rt cookie', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'logout_test@winkey.vn',
        password: 'Password123!',
        handle: 'logout_test',
        display_name: 'Logout Test',
      },
    });
    const cookie = regRes.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });
    expect(logoutRes.statusCode).toBe(204);

    // Verify cookie was cleared (max-age=0)
    const setCookie = logoutRes.headers['set-cookie'] as string;
    expect(setCookie).toContain('Max-Age=0');

    // Token family should now be revoked
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('/v1/auth/verify: stateless forwardAuth endpoint tests', async () => {
    // 1. No Authorization header -> 204 without identity headers (anonymous)
    const anonRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify',
    });
    expect(anonRes.statusCode).toBe(204);
    expect(anonRes.headers['x-user-id']).toBeUndefined();
    expect(anonRes.headers['x-user-roles']).toBeUndefined();

    // 2. Valid token -> 204 with X-User-Id and X-User-Roles
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'verify_test@winkey.vn',
        password: 'Password123!',
        handle: 'verify_test',
        display_name: 'Verify Test',
      },
    });
    const { access_token, user } = regRes.json();

    const authRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify',
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(authRes.statusCode).toBe(204);
    expect(authRes.headers['x-user-id']).toBe(user.id);
    expect(authRes.headers['x-user-roles']).toBe('viewer,creator');

    // 3. Expired / tampered / wrong token -> 401
    const tamperedRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify',
      headers: { Authorization: `Bearer ${access_token}tampered` },
    });
    expect(tamperedRes.statusCode).toBe(401);

    const invalidHeaderRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(invalidHeaderRes.statusCode).toBe(401);
  });

  it('/v1/auth/me: returns authenticated user profile', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'me_test@winkey.vn',
        password: 'Password123!',
        handle: 'me_test',
        display_name: 'Me Test',
      },
    });
    const { access_token, user } = regRes.json();

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.id).toBe(user.id);
    expect(me.email).toBe('me_test@winkey.vn');
    expect(me.handle).toBe('me_test');
  });

  it('/v1/users/:handle: returns public profile from auth.public_profiles', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'profile@winkey.vn',
        password: 'Password123!',
        handle: 'public_channel',
        display_name: 'Public Channel',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/public_channel',
    });
    expect(res.statusCode).toBe(200);
    const profile = res.json();
    expect(profile.handle).toBe('public_channel');
    expect(profile.display_name).toBe('Public Channel');
    expect(profile.avatar_url).toBeNull();

    // Unknown handle -> 404
    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/v1/users/unknown_user',
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('Google OAuth: start redirects with PKCE and callback links/creates user', async () => {
    // 1. Start OAuth
    const startRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google?return_to=/watch%3Fv%3D123',
    });
    expect(startRes.statusCode).toBe(302);
    const redirectUrl = new URL(startRes.headers.location);
    expect(redirectUrl.origin).toBe('https://accounts.google.com');
    expect(redirectUrl.searchParams.get('code_challenge')).toBeDefined();

    // Must set signed cookie
    const oauthCookie = startRes.cookies.find((c: any) => c.name === OAUTH_COOKIE_NAME)!.value;
    const stateParam = redirectUrl.searchParams.get('state')!;

    // 2. Rejects invalid return_to (absolute URL)
    const badReturnTo = await app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google?return_to=https://evil.com',
    });
    expect(badReturnTo.statusCode).toBe(400);

    // 3. Callback
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/oauth/google/callback?code=oauthuser1&state=${stateParam}`,
      cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/watch?v=123');
    const setCookieHeader = callbackRes.headers['set-cookie'];
    const cookiesStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join('; ')
      : String(setCookieHeader);
    expect(cookiesStr).toContain(`${REFRESH_COOKIE_NAME}=`);

    // Verify user was created in DB and outbox event enqueued
    expect(store.users.length).toBe(1);
    expect(store.users[0].email).toBe('oauthuser1@gmail.com');
    expect(store.oauth_identities.length).toBe(1);
    expect(store.oauth_identities[0].subject).toBe('google-sub-oauthuser1');

    expect(store.outbox.length).toBe(1);
    expect(store.outbox[0].subject).toBe('user.registered');
    expect(store.outbox[0].payload.data.method).toBe('google');
  });

  it('Google OAuth: start redirects to /login?error=oauth_unavailable when GOOGLE_CLIENT_ID is not configured', async () => {
    const unconfiguredEnv = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_KID: 'winkey-auth-key-1',
      JWT_ISSUER: 'https://winkey.vn',
      PUBLIC_ORIGIN: 'https://winkey.vn',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
      GOOGLE_CLIENT_ID: '',
      NODE_ENV: 'test',
    });

    const unconfiguredApp = await buildApp({
      env: unconfiguredEnv,
      db: createMockDb(store).db,
      rateLimiter: new ValkeyRateLimiter(),
    });

    // 1. With return_to query parameter
    const resWithReturnTo = await unconfiguredApp.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google?return_to=/watch%3Fv%3D123',
    });
    expect(resWithReturnTo.statusCode).toBe(302);
    expect(resWithReturnTo.headers.location).toBe('/login?error=oauth_unavailable');

    // 2. Without return_to query parameter
    const resWithoutReturnTo = await unconfiguredApp.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google',
    });
    expect(resWithoutReturnTo.statusCode).toBe(302);
    expect(resWithoutReturnTo.headers.location).toBe('/login?error=oauth_unavailable');

    // 3. Confirm no OAuth cookie is set
    const cookies = resWithReturnTo.cookies || [];
    expect(cookies.find((c: any) => c.name === OAUTH_COOKIE_NAME)).toBeUndefined();
  });

  it('Google OAuth: logs warn on startup when GOOGLE_CLIENT_ID is empty', async () => {
    const unconfiguredEnv = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_KID: 'winkey-auth-key-1',
      JWT_ISSUER: 'https://winkey.vn',
      PUBLIC_ORIGIN: 'https://winkey.vn',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
      GOOGLE_CLIENT_ID: '',
      NODE_ENV: 'test',
    });

    const testApp = fastify({ logger: false });
    let loggedWarn = '';
    testApp.log.warn = ((msg: string) => {
      loggedWarn = msg;
    }) as any;

    await testApp.register(oauthRoute, {
      db: createMockDb(store).db,
      env: unconfiguredEnv,
    });
    await testApp.ready();

    expect(loggedWarn).toBe('Google OAuth not configured');
    await testApp.close();
  });

  it('Health: /healthz and /readyz', async () => {
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ status: 'ok' });

    const readyz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json().status).toBe('ok');
  });

  describe('Admin and Moderation Integration', () => {
    const adminId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001';
    const modId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0002';
    const adminHeaders = {
      'x-user-id': adminId,
      'x-user-roles': 'admin,viewer',
    };
    const modHeaders = {
      'x-user-id': modId,
      'x-user-roles': 'moderator,viewer',
    };

    it('Admin: update roles writes USER_ROLES_CHANGED audit log; no-op writes nothing', async () => {
      // 1. Register a user
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'role_target@winkey.vn',
          password: 'Password123!',
          handle: 'role_target',
          display_name: 'Role Target',
        },
      });
      expect(reg.statusCode).toBe(201);
      const targetId = reg.json().user.id;

      // 2. Admin promotes user to creator, moderator
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${targetId}/roles`,
        headers: adminHeaders,
        payload: {
          roles: ['viewer', 'creator', 'moderator'],
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().roles).toEqual(['viewer', 'creator', 'moderator']);

      // Check audit log
      expect(store.audit_log.length).toBe(1);
      expect(store.audit_log[0].action).toBe('USER_ROLES_CHANGED');
      expect(store.audit_log[0].actor_id).toBe(adminId);
      expect(store.audit_log[0].target_user_id).toBe(targetId);

      // 3. No-op update (same roles)
      const noopRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${targetId}/roles`,
        headers: adminHeaders,
        payload: {
          roles: ['viewer', 'creator', 'moderator'],
        },
      });
      expect(noopRes.statusCode).toBe(200);
      // Audit log count must remain 1
      expect(store.audit_log.length).toBe(1);
    });

    it('Moderator: suspends user revoking refresh tokens; login returns 403 ACCOUNT_SUSPENDED without leaking reason', async () => {
      // 1. Register a user and log in to get a refresh token
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'suspend_target@winkey.vn',
          password: 'Password123!',
          handle: 'suspend_target',
          display_name: 'Suspend Target',
        },
      });
      expect(reg.statusCode).toBe(201);
      const targetId = reg.json().user.id;
      const initialCookie = reg.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

      // 2. Moderator suspends user until tomorrow
      const until = new Date(Date.now() + 86400000).toISOString();
      const suspRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${targetId}/suspension`,
        headers: modHeaders,
        payload: {
          reason: 'Internal notes about harassment',
          until,
        },
      });
      expect(suspRes.statusCode).toBe(200);
      expect(suspRes.json().status).toBe('SUSPENDED');
      expect(suspRes.json().suspension_reason).toBe('Internal notes about harassment');

      // Check audit log
      expect(store.audit_log.some((a) => a.action === 'USER_SUSPENDED')).toBe(true);

      // 3. User refresh token must be revoked (401)
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
      });
      expect(refreshRes.statusCode).toBe(401);

      // 4. User login must answer 403 ACCOUNT_SUSPENDED with until in detail, never internal reason
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'suspend_target@winkey.vn',
          password: 'Password123!',
        },
      });
      expect(loginRes.statusCode).toBe(403);
      const problem = loginRes.json();
      expect(problem.code).toBe('ACCOUNT_SUSPENDED');
      expect(problem.detail).toContain(until);
      expect(problem.detail).not.toContain('harassment');
    });

    it('Login: expired temporary suspension auto-lifts with USER_UNSUSPENDED audit log', async () => {
      // 1. Create a user who was temporarily suspended in the past
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'expired_target@winkey.vn',
          password: 'Password123!',
          handle: 'expired_target',
          display_name: 'Expired Target',
        },
      });
      expect(reg.statusCode).toBe(201);
      const targetId = reg.json().user.id;

      // Manually set suspension expired in the past
      const user = store.users.find((u) => u.id === targetId)!;
      user.status = 'SUSPENDED';
      user.suspended_until = new Date(Date.now() - 3600000); // 1 hour ago
      user.suspension_reason = 'Past minor warning';

      // 2. User logs in with correct password
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'expired_target@winkey.vn',
          password: 'Password123!',
        },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.json().access_token).toBeDefined();

      // User must now be ACTIVE in database with suspension cleared
      expect(user.status).toBe('ACTIVE');
      expect(user.suspended_until).toBeNull();
      expect(user.suspension_reason).toBeNull();

      // Audit log must have recorded USER_UNSUSPENDED with { expired: true }
      const unSuspAudit = store.audit_log.find(
        (a) => a.target_user_id === targetId && a.action === 'USER_UNSUSPENDED',
      );
      expect(unSuspAudit).toBeDefined();
      expect(unSuspAudit!.details).toEqual({ expired: true });
    });

    it('Admin/Moderator: Unsuspend of ACTIVE user is idempotent without audit row', async () => {
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'active_target@winkey.vn',
          password: 'Password123!',
          handle: 'active_target',
          display_name: 'Active Target',
        },
      });
      const targetId = reg.json().user.id;
      const initialLogCount = store.audit_log.length;

      const unsuspRes = await app.inject({
        method: 'DELETE',
        url: `/v1/admin/users/${targetId}/suspension`,
        headers: modHeaders,
      });
      expect(unsuspRes.statusCode).toBe(200);
      expect(unsuspRes.json().status).toBe('ACTIVE');
      expect(store.audit_log.length).toBe(initialLogCount);
    });

    it('Admin/Moderator: Self-protection and admin-protection enforce CANNOT_MODERATE_TARGET (403)', async () => {
      // 1. Admin cannot suspend self
      const selfSusp = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${adminId}/suspension`,
        headers: adminHeaders,
        payload: { reason: 'Test self' },
      });
      expect(selfSusp.statusCode).toBe(403);
      expect(selfSusp.json().code).toBe('CANNOT_MODERATE_TARGET');

      // 2. Admin cannot change own roles
      const selfRoles = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${adminId}/roles`,
        headers: adminHeaders,
        payload: { roles: ['viewer'] },
      });
      expect(selfRoles.statusCode).toBe(403);
      expect(selfRoles.json().code).toBe('CANNOT_MODERATE_TARGET');

      // 3. Register another admin user
      const anotherAdmin = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'another_admin@winkey.vn',
          password: 'Password123!',
          handle: 'another_admin',
          display_name: 'Another Admin',
        },
      });
      const anotherAdminId = anotherAdmin.json().user.id;
      store.users.find((u) => u.id === anotherAdminId)!.roles = ['admin', 'viewer'];

      // Admin cannot suspend another admin
      const adminSuspAdmin = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${anotherAdminId}/suspension`,
        headers: adminHeaders,
        payload: { reason: 'Test' },
      });
      expect(adminSuspAdmin.statusCode).toBe(403);
      expect(adminSuspAdmin.json().code).toBe('CANNOT_MODERATE_TARGET');

      // Moderator cannot suspend another moderator
      const anotherMod = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'another_mod@winkey.vn',
          password: 'Password123!',
          handle: 'another_mod',
          display_name: 'Another Mod',
        },
      });
      const anotherModId = anotherMod.json().user.id;
      store.users.find((u) => u.id === anotherModId)!.roles = ['moderator', 'viewer'];

      const modSuspMod = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${anotherModId}/suspension`,
        headers: modHeaders,
        payload: { reason: 'Test' },
      });
      expect(modSuspMod.statusCode).toBe(403);
      expect(modSuspMod.json().code).toBe('CANNOT_MODERATE_TARGET');
    });

    it('Admin: Admin A can change Admin B roles, but cannot demote the sole admin (409 LAST_ADMIN)', async () => {
      // Create admin B
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'admin_b@winkey.vn',
          password: 'Password123!',
          handle: 'admin_b',
          display_name: 'Admin B',
        },
      });
      const adminBId = reg.json().user.id;
      store.users.find((u) => u.id === adminBId)!.roles = ['admin', 'viewer'];

      // Admin A promotes Admin B with creator role
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${adminBId}/roles`,
        headers: adminHeaders,
        payload: {
          roles: ['admin', 'creator', 'viewer'],
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().roles).toEqual(['admin', 'creator', 'viewer']);

      // But if there is only 1 admin, demoting them returns 409 LAST_ADMIN
      // Remove admin role from Admin B
      store.users.find((u) => u.id === adminBId)!.roles = ['viewer'];
      // Ensure only caller admin is in store as admin
      const soleAdminTarget = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'sole_admin_target@winkey.vn',
          password: 'Password123!',
          handle: 'sole_admin_target',
          display_name: 'Sole Admin Target',
        },
      });
      const soleAdminId = soleAdminTarget.json().user.id;
      store.users.find((u) => u.id === soleAdminId)!.roles = ['admin', 'viewer'];
      store.users = store.users.filter((u) => u.id === soleAdminId || !u.roles.includes('admin'));

      const demoteRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${soleAdminId}/roles`,
        headers: adminHeaders,
        payload: {
          roles: ['viewer'],
        },
      });
      expect(demoteRes.statusCode).toBe(409);
      expect(demoteRes.json().code).toBe('LAST_ADMIN');
    });

    it('Admin/Moderator: Unsuspend/Suspend on DELETED user returns 409 conflict and user remains DELETED', async () => {
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'deleted_user@winkey.vn',
          password: 'Password123!',
          handle: 'deleted_user',
          display_name: 'Deleted User',
        },
      });
      const deletedId = reg.json().user.id;
      store.users.find((u) => u.id === deletedId)!.status = 'DELETED';

      // 1. Unsuspend must fail with 409
      const unsuspRes = await app.inject({
        method: 'DELETE',
        url: `/v1/admin/users/${deletedId}/suspension`,
        headers: modHeaders,
      });
      expect(unsuspRes.statusCode).toBe(409);
      expect(unsuspRes.json().detail).toContain('User is deleted');

      // Database status remains DELETED
      expect(store.users.find((u) => u.id === deletedId)!.status).toBe('DELETED');

      // 2. Suspend must fail with 409
      const suspRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${deletedId}/suspension`,
        headers: modHeaders,
        payload: {
          reason: 'Attempting to suspend deleted user',
        },
      });
      expect(suspRes.statusCode).toBe(409);
      expect(suspRes.json().detail).toContain('User is deleted');
      expect(store.users.find((u) => u.id === deletedId)!.status).toBe('DELETED');
    });
  });

  describe('Task A3: Account Self-Service (me, updateMe, changePassword, deleteMe)', () => {
    it('GET /v1/auth/me returns has_password = true for password user and false for OAuth-only user', async () => {
      // 1. Password user
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'pw_user@winkey.vn',
          password: 'Password123!',
          handle: 'pw_user',
          display_name: 'Password User',
        },
      });
      expect(reg.statusCode).toBe(201);
      const pwToken = reg.json().access_token;

      const meRes1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${pwToken}` },
      });
      expect(meRes1.statusCode).toBe(200);
      expect(meRes1.json().has_password).toBe(true);

      // 2. OAuth-only user
      const startRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/',
      });
      const redirectUrl = new URL(startRes.headers.location);
      const oauthSignedCookie = startRes.cookies.find(
        (c: { name: string; value: string }) => c.name === OAUTH_COOKIE_NAME,
      )!.value;
      const stateParam = redirectUrl.searchParams.get('state')!;

      const oauthRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=oauth_user_code&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthSignedCookie },
      });
      expect(oauthRes.statusCode).toBe(302);
      const oauthCookie = oauthRes.cookies.find(
        (c: { name: string; value: string }) => c.name === REFRESH_COOKIE_NAME,
      )!.value;

      // Exchange refresh cookie for access token
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: oauthCookie },
      });
      expect(refreshRes.statusCode).toBe(200);
      const oauthToken = refreshRes.json().access_token;

      const meRes2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${oauthToken}` },
      });
      expect(meRes2.statusCode).toBe(200);
      expect(meRes2.json().has_password).toBe(false);
    });

    it('PATCH /v1/auth/me (updateMe): updates display_name and handle; no-op returns 200 without DB write', async () => {
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'updateme_user@winkey.vn',
          password: 'Password123!',
          handle: 'updateme_orig',
          display_name: 'Original Name',
        },
      });
      const token = reg.json().access_token;
      const userId = reg.json().user.id;

      // 1. Update display_name only
      const u1 = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { display_name: 'Updated Name 1' },
      });
      expect(u1.statusCode).toBe(200);
      expect(u1.json().display_name).toBe('Updated Name 1');
      expect(u1.json().handle).toBe('updateme_orig');
      expect(u1.json().has_password).toBe(true);
      expect(store.users.find((u) => u.id === userId)!.display_name).toBe('Updated Name 1');

      // 2. Update handle only
      const u2 = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { handle: 'updateme_newhandle' },
      });
      expect(u2.statusCode).toBe(200);
      expect(u2.json().handle).toBe('updateme_newhandle');
      expect(store.users.find((u) => u.id === userId)!.handle).toBe('updateme_newhandle');

      // 3. No-op: sending exact same values returns 200
      const prevUpdatedAt = store.users.find((u) => u.id === userId)!.updated_at;
      const noop = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { display_name: 'Updated Name 1', handle: 'updateme_newhandle' },
      });
      expect(noop.statusCode).toBe(200);
      expect(store.users.find((u) => u.id === userId)!.updated_at).toEqual(prevUpdatedAt);

      // 4. Empty payload -> 400
      const bad1 = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(bad1.statusCode).toBe(400);

      // 5. Invalid handle format -> 400
      const bad2 = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { handle: 'bad handle with spaces' },
      });
      expect(bad2.statusCode).toBe(400);
    });

    it('PATCH /v1/auth/me: returns 409 HANDLE_TAKEN on case-insensitive collision and 429 when rate limited', async () => {
      // Register alice and bob
      const r1 = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'alice_patch@winkey.vn',
          password: 'Password123!',
          handle: 'alice_patch',
          display_name: 'Alice Patch',
        },
      });
      expect(r1.statusCode).toBe(201);
      const bobRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'bob_patch@winkey.vn',
          password: 'Password123!',
          handle: 'bob_patch',
          display_name: 'Bob Patch',
        },
      });
      expect(bobRes.statusCode).toBe(201);
      const bobToken = bobRes.json().access_token;

      // Bob tries to take Alice's handle (case variant)
      const conflictRes = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { handle: 'ALICE_PATCH' },
      });
      expect(conflictRes.statusCode).toBe(409);
      expect(conflictRes.json().code).toBe('HANDLE_TAKEN');

      // Rate limit test: 10 changes allowed per hour
      for (let i = 0; i < 9; i++) {
        const ok = await app.inject({
          method: 'PATCH',
          url: '/v1/auth/me',
          headers: { authorization: `Bearer ${bobToken}` },
          payload: { display_name: `Bob Iteration ${i}` },
        });
        expect(ok.statusCode).toBe(200);
      }
      // 10th change or subsequent request triggers 429
      const rateLimitedRes = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { display_name: 'Bob Exceeded' },
      });
      expect(rateLimitedRes.statusCode).toBe(429);
    });

    it('PUT /v1/auth/me/password: password verification, OAuth first password, and other-device session revocation', async () => {
      // 1. Register user (Device 1)
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'pwd_user@winkey.vn',
          password: 'OldPassword123!',
          handle: 'pwd_user',
          display_name: 'Pwd User',
        },
      });
      const device1Cookie = reg.cookies.find(
        (c: { name: string; value: string }) => c.name === REFRESH_COOKIE_NAME,
      )!.value;
      const device1Token = reg.json().access_token;

      // 2. Login on Device 2
      const loginDev2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'pwd_user@winkey.vn',
          password: 'OldPassword123!',
        },
      });
      expect(loginDev2.statusCode).toBe(200);
      const device2Cookie = loginDev2.cookies.find(
        (c: { name: string; value: string }) => c.name === REFRESH_COOKIE_NAME,
      )!.value;

      // 3. Wrong current_password returns 403 INVALID_CREDENTIALS
      const wrongPwdRes = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${device1Token}` },
        cookies: { [REFRESH_COOKIE_NAME]: device1Cookie },
        payload: {
          current_password: 'WrongPassword!',
          new_password: 'NewPassword123!',
        },
      });
      expect(wrongPwdRes.statusCode).toBe(403);
      expect(wrongPwdRes.json().code).toBe('INVALID_CREDENTIALS');

      // 4. Missing current_password on password account returns 403
      const missingPwdRes = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${device1Token}` },
        cookies: { [REFRESH_COOKIE_NAME]: device1Cookie },
        payload: {
          new_password: 'NewPassword123!',
        },
      });
      expect(missingPwdRes.statusCode).toBe(403);
      expect(missingPwdRes.json().code).toBe('INVALID_CREDENTIALS');

      // 5. Change password successfully from Device 1
      const okPwdRes = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${device1Token}` },
        cookies: { [REFRESH_COOKIE_NAME]: device1Cookie },
        payload: {
          current_password: 'OldPassword123!',
          new_password: 'NewPassword123!',
        },
      });
      expect(okPwdRes.statusCode).toBe(204);

      // 6. Old password fails login, new password succeeds
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'pwd_user@winkey.vn', password: 'OldPassword123!' },
      });
      expect(oldLogin.statusCode).toBe(401);

      const newLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'pwd_user@winkey.vn', password: 'NewPassword123!' },
      });
      expect(newLogin.statusCode).toBe(200);

      // 7. Device 2 refresh token is revoked (401), while Device 1 refresh token remains valid (200)
      const dev2Refresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: device2Cookie },
      });
      expect(dev2Refresh.statusCode).toBe(401);

      const dev1Refresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: device1Cookie },
      });
      expect(dev1Refresh.statusCode).toBe(200);

      // 8. OAuth-only account sets first password
      const startOAuth2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/',
      });
      const redirectUrl2 = new URL(startOAuth2.headers.location);
      const oauthSignedCookie2 = startOAuth2.cookies.find(
        (c: { name: string; value: string }) => c.name === OAUTH_COOKIE_NAME,
      )!.value;
      const stateParam2 = redirectUrl2.searchParams.get('state')!;

      const oauthRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=oauth_first_pwd&state=${stateParam2}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthSignedCookie2 },
      });
      expect(oauthRes.statusCode).toBe(302);
      const oauthCookie = oauthRes.cookies.find(
        (c: { name: string; value: string }) => c.name === REFRESH_COOKIE_NAME,
      )!.value;
      const oauthRefresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: oauthCookie },
      });
      const oauthAccessToken = oauthRefresh.json().access_token;

      // Providing current_password on OAuth account returns 400
      const oauthBad = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${oauthAccessToken}` },
        payload: {
          current_password: 'UnexpectedPassword',
          new_password: 'BrandNewPassword123!',
        },
      });
      expect(oauthBad.statusCode).toBe(400);

      // Setting first password without current_password succeeds
      const oauthSet = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${oauthAccessToken}` },
        cookies: { [REFRESH_COOKIE_NAME]: oauthCookie },
        payload: {
          new_password: 'BrandNewPassword123!',
        },
      });
      expect(oauthSet.statusCode).toBe(204);

      // Now can log in with email and new password
      const oauthLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'oauth_first_pwd@gmail.com',
          password: 'BrandNewPassword123!',
        },
      });
      expect(oauthLogin.statusCode).toBe(200);
      const meAfterPwd = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${oauthLogin.json().access_token}` },
      });
      expect(meAfterPwd.statusCode).toBe(200);
      expect(meAfterPwd.json().has_password).toBe(true);
    });

    it('DELETE /v1/auth/me: confirmation, last admin safeguard, user scrubbing, token revocation, and cookie clearing', async () => {
      // 1. Register a regular user
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'del_user@winkey.vn',
          password: 'Password123!',
          handle: 'del_user',
          display_name: 'Delete Target',
        },
      });
      const delCookie = reg.cookies.find(
        (c: { name: string; value: string }) => c.name === REFRESH_COOKIE_NAME,
      )!.value;
      const delToken = reg.json().access_token;
      const delUserId = reg.json().user.id;

      // 2. Confirmation mismatch -> 400 CONFIRMATION_MISMATCH
      const misRes = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${delToken}` },
        payload: {
          confirm_handle: 'wrong_handle',
          password: 'Password123!',
        },
      });
      expect(misRes.statusCode).toBe(400);
      expect(misRes.json().code).toBe('CONFIRMATION_MISMATCH');

      // 3. Wrong password -> 403 INVALID_CREDENTIALS
      const wrongPwd = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${delToken}` },
        payload: {
          confirm_handle: 'del_user',
          password: 'WrongPassword!',
        },
      });
      expect(wrongPwd.statusCode).toBe(403);
      expect(wrongPwd.json().code).toBe('INVALID_CREDENTIALS');

      // 4. Sole admin safeguard -> 409 LAST_ADMIN
      const soleAdminReg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'sole_admin_del@winkey.vn',
          password: 'Password123!',
          handle: 'sole_admin_del',
          display_name: 'Sole Admin Del',
        },
      });
      const soleAdminId = soleAdminReg.json().user.id;
      const soleAdminToken = soleAdminReg.json().access_token;
      // Make them the only active admin
      store.users.find((u) => u.id === soleAdminId)!.roles = ['admin', 'viewer'];
      store.users = store.users.filter((u) => u.id === soleAdminId || !u.roles.includes('admin'));

      const lastAdminDel = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${soleAdminToken}` },
        payload: {
          confirm_handle: 'sole_admin_del',
          password: 'Password123!',
        },
      });
      expect(lastAdminDel.statusCode).toBe(409);
      expect(lastAdminDel.json().code).toBe('LAST_ADMIN');

      // 5. Successful delete of regular user (case-insensitive handle confirmation)
      const okDel = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${delToken}` },
        payload: {
          confirm_handle: 'DEL_USER',
          password: 'Password123!',
        },
      });
      expect(okDel.statusCode).toBe(204);
      expect(okDel.headers['set-cookie'] as string).toContain('Max-Age=0');

      // Verify scrubbed user row in store
      const scrubbed = store.users.find((u) => u.id === delUserId)!;
      expect(scrubbed.status).toBe('DELETED');
      expect(scrubbed.email).toBe(`deleted+${delUserId}@invalid.winkey.vn`);
      const hex = delUserId.replace(/-/g, '');
      expect(scrubbed.handle).toBe(`d_${hex.slice(0, 28)}`);
      expect(scrubbed.handle.length).toBe(30);
      expect(scrubbed.display_name).toBe('Deleted user');
      expect(scrubbed.password_hash).toBeNull();
      expect(scrubbed.email_verified_at).toBeNull();
      expect(scrubbed.avatar_key).toBeNull();
      expect(scrubbed.suspended_until).toBeNull();
      expect(scrubbed.suspension_reason).toBeNull();

      // Refresh token is revoked
      const delRefresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: delCookie },
      });
      expect(delRefresh.statusCode).toBe(401);

      // Login with old email fails
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'del_user@winkey.vn',
          password: 'Password123!',
        },
      });
      expect(oldLogin.statusCode).toBe(401);

      // 6. Re-registration with the same email and handle succeeds
      const reReg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'del_user@winkey.vn',
          password: 'NewPassword456!',
          handle: 'del_user',
          display_name: 'New Re-registered User',
        },
      });
      expect(reReg.statusCode).toBe(201);
      expect(reReg.json().user.handle).toBe('del_user');
      expect(reReg.json().user.email).toBe('del_user@winkey.vn');
    });
  });

  describe('Closed-beta registration mode & invite codes (Task BETA1, ADR-034)', () => {
    const CODE_A = 'valid-alpha-invite-code-1234';
    const CODE_B = 'valid-bravo-invite-code-5678';

    let betaStore: MockStore;
    let betaApp: FastifyInstance;
    let betaEnv: Env;

    beforeEach(async () => {
      betaStore = createMockStore();
      const { db } = createMockDb(betaStore);
      const rateLimiter = new ValkeyRateLimiter();
      betaEnv = getEnv({
        JWT_PRIVATE_KEY: keys.privateKey,
        JWT_KID: 'winkey-auth-key-1',
        JWT_ISSUER: 'https://winkey.vn',
        PUBLIC_ORIGIN: 'https://winkey.vn',
        MEDIA_BASE_URL: 'https://media.winkey.vn',
        GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
        REGISTRATION_MODE: 'invite',
        INVITE_CODES: `${CODE_A},${CODE_B}`,
        NODE_ENV: 'test',
      });

      betaApp = await buildApp({
        env: betaEnv,
        db,
        rateLimiter,
        googleTokenExchanger: async (code, _verifier) => ({
          sub: `google-sub-${code}`,
          email: `${code}@gmail.com`,
          email_verified: true,
          name: `Google User ${code}`,
        }),
      });
    });

    it('invite mode: register missing code returns 403 INVITE_REQUIRED', async () => {
      const res = await betaApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'beta_new@winkey.vn',
          password: 'Password123!',
          handle: 'beta_new',
          display_name: 'Beta User',
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = res.json();
      expect(problem.code).toBe('INVITE_REQUIRED');
      expect(betaStore.users.length).toBe(0);
    });

    it('invite mode: register with wrong code returns 403 INVITE_INVALID', async () => {
      const res = await betaApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'beta_new@winkey.vn',
          password: 'Password123!',
          handle: 'beta_new',
          display_name: 'Beta User',
          invite_code: 'wrong-invite-code-9999',
        },
      });

      expect(res.statusCode).toBe(403);
      const problem = res.json();
      expect(problem.code).toBe('INVITE_INVALID');
      expect(betaStore.users.length).toBe(0);
    });

    it('invite mode: register with already-registered email and wrong code returns 403 INVITE_INVALID (no existence leak)', async () => {
      // Pre-seed an existing user
      betaStore.users.push({
        id: '01923456-789a-7bc8-9012-3456789abcde',
        email: 'taken@winkey.vn',
        email_verified_at: new Date(),
        password_hash: 'hash',
        handle: 'taken_user',
        display_name: 'Taken User',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const res = await betaApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'taken@winkey.vn',
          password: 'Password123!',
          handle: 'brand_new_handle',
          display_name: 'Brand New',
          invite_code: 'wrong-invite-code-9999',
        },
      });

      // Must be 403 INVITE_INVALID, NOT 409 EMAIL_TAKEN
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('INVITE_INVALID');
    });

    it('invite mode: register with valid code returns 201, sets wk_rt and creates user', async () => {
      const res = await betaApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'beta_success@winkey.vn',
          password: 'Password123!',
          handle: 'beta_success',
          display_name: 'Beta Success',
          invite_code: CODE_A,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user.email).toBe('beta_success@winkey.vn');
      expect(res.headers['set-cookie'] as string).toContain(`${REFRESH_COOKIE_NAME}=`);
      expect(betaStore.users.length).toBe(1);

      // Second code also works
      const res2 = await betaApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'beta_success2@winkey.vn',
          password: 'Password123!',
          handle: 'beta_success2',
          display_name: 'Beta Success 2',
          invite_code: CODE_B,
        },
      });
      expect(res2.statusCode).toBe(201);
      expect(betaStore.users.length).toBe(2);
    });

    it('open mode: ignores invite_code (valid, invalid, or missing)', async () => {
      // Using app which is open mode
      const resMissing = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'open_missing@winkey.vn',
          password: 'Password123!',
          handle: 'open_missing',
          display_name: 'Open Missing',
        },
      });
      expect(resMissing.statusCode).toBe(201);

      const resInvalid = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'open_invalid@winkey.vn',
          password: 'Password123!',
          handle: 'open_invalid',
          display_name: 'Open Invalid',
          invite_code: 'any-arbitrary-code',
        },
      });
      expect(resInvalid.statusCode).toBe(201);
    });

    it('Google OAuth: start validates invite_code length (1-64 chars or 400)', async () => {
      const badShort = await betaApp.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?invite_code=',
      });
      expect(badShort.statusCode).toBe(400);

      const badLong = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google?invite_code=${'a'.repeat(65)}`,
      });
      expect(badLong.statusCode).toBe(400);

      const okStart = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google?invite_code=${CODE_A}`,
      });
      expect(okStart.statusCode).toBe(302);
    });

    it('Google OAuth in invite mode: new account without code redirects to /register?error=INVITE_REQUIRED and creates no user', async () => {
      const startRes = await betaApp.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/',
      });
      expect(startRes.statusCode).toBe(302);
      const oauthCookie = startRes.cookies.find((c) => c.name === OAUTH_COOKIE_NAME)!.value;
      const stateParam = new URL(startRes.headers.location!).searchParams.get('state')!;

      const callbackRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=newgoogle1&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/register?error=INVITE_REQUIRED');
      // No user or oauth identity created
      expect(betaStore.users.length).toBe(0);
      expect(betaStore.oauth_identities.length).toBe(0);
      // No refresh token cookie
      const cookiesStr = String(callbackRes.headers['set-cookie'] || '');
      expect(cookiesStr).not.toContain(`${REFRESH_COOKIE_NAME}=`);
      // OAuth cookie cleared
      expect(cookiesStr).toContain(`${OAUTH_COOKIE_NAME}=;`);
      expect(cookiesStr).toContain('Max-Age=0');
    });

    it('Google OAuth in invite mode: new account with wrong code redirects to /register?error=INVITE_INVALID and creates no user', async () => {
      const startRes = await betaApp.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/&invite_code=wrong-invite-code-9999',
      });
      expect(startRes.statusCode).toBe(302);
      const oauthCookie = startRes.cookies.find((c) => c.name === OAUTH_COOKIE_NAME)!.value;
      const stateParam = new URL(startRes.headers.location!).searchParams.get('state')!;

      const callbackRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=newgoogle2&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/register?error=INVITE_INVALID');
      expect(betaStore.users.length).toBe(0);
      expect(betaStore.oauth_identities.length).toBe(0);
      const cookiesStr = String(callbackRes.headers['set-cookie'] || '');
      expect(cookiesStr).not.toContain(`${REFRESH_COOKIE_NAME}=`);
      expect(cookiesStr).toContain('Max-Age=0');
    });

    it('Google OAuth in invite mode: new account with valid code creates user and sets wk_rt', async () => {
      const startRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google?return_to=/welcome&invite_code=${CODE_A}`,
      });
      expect(startRes.statusCode).toBe(302);
      const oauthCookie = startRes.cookies.find((c) => c.name === OAUTH_COOKIE_NAME)!.value;
      const stateParam = new URL(startRes.headers.location!).searchParams.get('state')!;

      const callbackRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=newgoogle3&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/welcome');
      expect(betaStore.users.length).toBe(1);
      expect(betaStore.oauth_identities.length).toBe(1);
      const cookiesStr = String(callbackRes.headers['set-cookie'] || '');
      expect(cookiesStr).toContain(`${REFRESH_COOKIE_NAME}=`);
    });

    it('Google OAuth in invite mode: existing linked user signs in without a code', async () => {
      // Pre-seed user with linked oauth identity
      const existingUserId = '01923456-789a-7bc8-9012-3456789abcd1';
      betaStore.users.push({
        id: existingUserId,
        email: 'existing_oauth@gmail.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'existing_oauth',
        display_name: 'Existing OAuth',
        avatar_key: null,
        roles: ['viewer', 'creator'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      betaStore.oauth_identities.push({
        provider: 'google',
        subject: 'google-sub-existing_oauth',
        user_id: existingUserId,
        email: 'existing_oauth@gmail.com',
        created_at: new Date(),
      });

      // Sign in without invite_code
      const startRes = await betaApp.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/home',
      });
      const oauthCookie = startRes.cookies.find((c) => c.name === OAUTH_COOKIE_NAME)!.value;
      const stateParam = new URL(startRes.headers.location!).searchParams.get('state')!;

      const callbackRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=existing_oauth&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('/home');
      expect(String(callbackRes.headers['set-cookie'])).toContain(`${REFRESH_COOKIE_NAME}=`);
      // User count remains 1
      expect(betaStore.users.length).toBe(1);
    });

    it('Google OAuth in invite mode: linking verified email to existing user never checks code', async () => {
      // Pre-seed user with same email but no oauth identity
      const existingUserId = '01923456-789a-7bc8-9012-3456789abcd3';
      betaStore.users.push({
        id: existingUserId,
        email: 'linkme@gmail.com',
        email_verified_at: new Date(),
        password_hash: 'somehash',
        handle: 'linkme_user',
        display_name: 'Link Me',
        avatar_key: null,
        roles: ['viewer', 'creator'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Sign in without invite code
      const startRes = await betaApp.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google?return_to=/',
      });
      const oauthCookie = startRes.cookies.find((c) => c.name === OAUTH_COOKIE_NAME)!.value;
      const stateParam = new URL(startRes.headers.location!).searchParams.get('state')!;

      const callbackRes = await betaApp.inject({
        method: 'GET',
        url: `/v1/auth/oauth/google/callback?code=linkme&state=${stateParam}`,
        cookies: { [OAUTH_COOKIE_NAME]: oauthCookie },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(betaStore.oauth_identities.length).toBe(1);
      expect(betaStore.oauth_identities[0].user_id).toBe(existingUserId);
    });

    it('Log redaction: logs never contain invite code value', async () => {
      const SECRET_CODE = 'super-secret-invite-code-9999';
      const secretEnv = getEnv({
        JWT_PRIVATE_KEY: keys.privateKey,
        REGISTRATION_MODE: 'invite',
        INVITE_CODES: SECRET_CODE,
        NODE_ENV: 'test',
      });

      const loggedChunks: string[] = [];
      const testApp = await buildApp({
        env: secretEnv,
        db: createMockDb(createMockStore()).db,
        rateLimiter: new ValkeyRateLimiter(),
      });

      // Attempt registration with invalid code
      await testApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'logtest@winkey.vn',
          password: 'Password123!',
          handle: 'logtest',
          display_name: 'Log Test',
          invite_code: 'attempted-bad-code-1234',
        },
      });

      // Attempt registration with valid secret code
      await testApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'logtest2@winkey.vn',
          password: 'Password123!',
          handle: 'logtest2',
          display_name: 'Log Test 2',
          invite_code: SECRET_CODE,
        },
      });

      const joinedLogs = loggedChunks.join('\n');
      expect(joinedLogs).not.toContain(SECRET_CODE);
      expect(joinedLogs).not.toContain('attempted-bad-code-1234');
    });
  });
});
