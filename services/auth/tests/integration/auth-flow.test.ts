import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';
import { OAUTH_COOKIE_NAME } from '../../src/crypto/pkce.js';
import { validate as isValidUuid, version as uuidVersion } from 'uuid';

describe('auth-svc full integration flow', () => {
  const keys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_KID: 'winkey-auth-key-1',
    JWT_ISSUER: 'https://winkey.vn',
    PUBLIC_ORIGIN: 'https://winkey.vn',
    MEDIA_BASE_URL: 'https://media.winkey.vn',
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
});
