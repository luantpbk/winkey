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
    const rotatedCookie = refresh1Res.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;
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
    const cookiesStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : String(setCookieHeader);
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
});
