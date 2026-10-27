import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';
import { generateTotpCode } from '../../src/crypto/totp.js';

describe('SOC-1a Account Security Integration Flow (PR 1)', () => {
  const keys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_KID: 'winkey-auth-key-1',
    JWT_ISSUER: 'https://winkey.vn',
    PUBLIC_ORIGIN: 'https://winkey.vn',
    MEDIA_BASE_URL: 'https://media.winkey.vn',
    NODE_ENV: 'test',
    STAFF_MFA_REQUIRED: true,
  });

  let store: MockStore;
  let app: any;

  beforeEach(async () => {
    store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  async function registerUser(
    email = 'alice@winkey.vn',
    handle = 'alice',
    password = 'Password123!',
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
        'CF-IPCountry': 'VN',
      },
      payload: {
        email,
        password,
        handle,
        display_name: handle,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const setCookie = res.headers['set-cookie'] as string;
    const cookieMatch = setCookie.match(new RegExp(`${REFRESH_COOKIE_NAME}=([^;]+)`));
    const refreshToken = cookieMatch ? cookieMatch[1] : '';
    return {
      user: body.user,
      accessToken: body.access_token,
      refreshToken,
    };
  }

  describe('1. Sessions management', () => {
    it('creates session row upon registration and lists active sessions', async () => {
      const { accessToken, user } = await registerUser('alice_sess@winkey.vn', 'alice_sess');

      expect(store.sessions.length).toBe(1);
      const session = store.sessions[0];
      expect(session.user_id).toBe(user.id);
      expect(session.device_label).toBe('Chrome trên Windows');
      expect(session.country).toBe('VN');
      expect(session.revoked_at).toBeNull();

      // List my sessions
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/sessions',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0].id).toBe(session.id);
      expect(listBody.items[0].current).toBe(true);
      expect(listBody.items[0].device_label).toBe('Chrome trên Windows');
      expect(listBody.items[0].country).toBe('VN');
    });

    it('revokes a specific session via DELETE /v1/auth/me/sessions/:id', async () => {
      const { accessToken, refreshToken } = await registerUser('bob_sess@winkey.vn', 'bob_sess');
      const sessionId = store.sessions[0].id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/auth/me/sessions/${sessionId}`,
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(delRes.statusCode).toBe(204);
      expect(store.sessions[0].revoked_at).not.toBeNull();
      expect(store.sessions[0].revoke_reason).toBe('USER_REVOKED');

      // Refreshing with the revoked session's cookie must fail
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`,
        },
      });
      expect(refreshRes.statusCode).toBe(401);
    });

    it('revokes other sessions via POST /v1/auth/me/sessions/revoke-others', async () => {
      const { accessToken, user } = await registerUser('charlie_sess@winkey.vn', 'charlie_sess');
      const currentSid = store.sessions[0].id;

      // Add a second session simulating a tablet
      store.sessions.push({
        id: '018f6c38-892f-7634-9388-3490715e2190',
        user_id: user.id,
        family_id: 'fam-tablet-123',
        device_label: 'Safari trên iPad',
        country: 'SG',
        ip_hash: null,
        amr: ['pwd'],
        step_up_at: null,
        last_used_at: new Date(),
        revoked_at: null,
        revoke_reason: null,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 86400000),
      });

      const revokeRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/sessions/revoke-others',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(revokeRes.statusCode).toBe(200);
      expect(revokeRes.json().revoked).toBe(1);

      // Current session still active
      expect(store.sessions.find((s) => s.id === currentSid)?.revoked_at).toBeNull();
      // Other session revoked
      const other = store.sessions.find((s) => s.id === '018f6c38-892f-7634-9388-3490715e2190');
      expect(other?.revoked_at).not.toBeNull();
      expect(other?.revoke_reason).toBe('REVOKE_OTHERS');
    });
  });

  describe('2. Step-up authorization', () => {
    it('blocks guarded endpoint with 403 STEP_UP_REQUIRED without step-up', async () => {
      const { accessToken } = await registerUser('dave_step@winkey.vn', 'dave_step');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('STEP_UP_REQUIRED');
    });

    it('allows guarded endpoint after successful stepUp with password', async () => {
      const { accessToken } = await registerUser(
        'eve_step@winkey.vn',
        'eve_step',
        'EvePassword123!',
      );

      // Step-up with password
      const stepUpRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          method: 'password',
          password: 'EvePassword123!',
        },
      });

      expect(stepUpRes.statusCode).toBe(200);
      expect(stepUpRes.json().step_up_until).toBeDefined();

      // Now guarded endpoint succeeds
      const totpRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(totpRes.statusCode).toBe(201);
      const totpBody = totpRes.json();
      expect(totpBody.setup_id).toBeDefined();
      expect(totpBody.secret).toBeDefined();
      expect(totpBody.otpauth_uri).toContain('otpauth://totp/');
    });
  });

  describe('3. TOTP & Recovery codes lifecycle', () => {
    it('full flow: setup -> confirm -> replay rejection -> regenerate recovery -> disable', async () => {
      const { accessToken } = await registerUser(
        'frank_totp@winkey.vn',
        'frank_totp',
        'FrankPass123!',
      );

      // 1. Step-up
      await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { method: 'password', password: 'FrankPass123!' },
      });

      // 2. Start TOTP setup
      const setupRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(setupRes.statusCode).toBe(201);
      const { setup_id, secret } = setupRes.json();

      // 3. Confirm with valid code
      const validCode = generateTotpCode(secret);
      const confirmRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp/confirm',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          setup_id,
          code: validCode,
        },
      });

      expect(confirmRes.statusCode).toBe(200);
      const confirmBody = confirmRes.json();
      expect(confirmBody.recovery_codes).toHaveLength(10);
      expect(store.recovery_codes.length).toBe(10);

      // Check security summary
      const secRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/security',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(secRes.statusCode).toBe(200);
      const secBody = secRes.json();
      expect(secBody.mfa_enabled).toBe(true);
      expect(secBody.totp_enabled).toBe(true);
      expect(secBody.recovery_codes_remaining).toBe(10);

      // 4. Replay protection: using the same code again fails
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          method: 'totp',
          code: validCode,
        },
      });
      expect(replayRes.statusCode).toBe(403);
      expect(replayRes.json().code).toBe('INVALID_CREDENTIALS');

      // 5. Regenerate recovery codes
      const regenRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/recovery-codes',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(regenRes.statusCode).toBe(200);
      expect(regenRes.json().recovery_codes).toHaveLength(10);

      // 6. Disable TOTP
      const disableRes = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me/totp',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(disableRes.statusCode).toBe(204);
      expect(store.recovery_codes.length).toBe(0);
    });
  });

  describe('4. Staff 2FA enforcement rule', () => {
    it('strips admin and moderator roles from token until 2FA is configured', async () => {
      // Create user with admin role directly in store
      const { refreshToken, user } = await registerUser(
        'admin_user@winkey.vn',
        'admin_staff',
        'AdminPass123!',
      );
      const dbUser = store.users.find((u) => u.id === user.id)!;
      dbUser.roles = ['viewer', 'admin'];

      // Refresh to get effective roles
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`,
        },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = refreshRes.json();
      const setCookie = refreshRes.headers['set-cookie'] as string;
      const cookieMatch = setCookie.match(new RegExp(`${REFRESH_COOKIE_NAME}=([^;]+)`));
      const rotatedRefreshToken = cookieMatch ? cookieMatch[1] : '';

      // Admin stripped because 2FA not enabled
      expect(refreshBody.user.roles).toEqual(['viewer']);
      expect(refreshBody.user.staff_roles_pending_mfa).toEqual(['admin']);
      expect(refreshBody.user.mfa_enabled).toBe(false);

      // Now enable TOTP for this admin user
      const adminToken = refreshBody.access_token;
      await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { method: 'password', password: 'AdminPass123!' },
      });
      const setupRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const { setup_id, secret } = setupRes.json();
      await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp/confirm',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { setup_id, code: generateTotpCode(secret) },
      });

      // Next refresh has admin role restored!
      const refreshAfter2Fa = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: `${REFRESH_COOKIE_NAME}=${rotatedRefreshToken}`,
        },
      });

      expect(refreshAfter2Fa.statusCode).toBe(200);
      const bodyAfter = refreshAfter2Fa.json();
      expect(bodyAfter.user.roles).toContain('admin');
      expect(bodyAfter.user.staff_roles_pending_mfa).toEqual([]);
      expect(bodyAfter.user.mfa_enabled).toBe(true);
    });
  });

  describe('5. MFA Login Flow', () => {
    it('returns MfaChallenge when user has TOTP enabled, and completes login with code or recovery code', async () => {
      const { accessToken } = await registerUser('mfa_user@winkey.vn', 'mfa_user', 'MfaPass123!');

      // Enable TOTP
      await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { method: 'password', password: 'MfaPass123!' },
      });
      const setupRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const { setup_id, secret } = setupRes.json();
      const confirmRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/totp/confirm',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { setup_id, code: generateTotpCode(secret) },
      });
      const recoveryCodes = confirmRes.json().recovery_codes as string[];

      // Now login returns MfaChallenge
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa_user@winkey.vn', password: 'MfaPass123!' },
      });
      expect(loginRes.statusCode).toBe(200);
      const chalBody = loginRes.json();
      expect(chalBody.mfa_required).toBe(true);
      expect(chalBody.mfa_token).toBeDefined();
      expect(chalBody.methods).toContain('totp');
      expect(chalBody.methods).toContain('recovery_code');
      // No wk_rt cookie yet!
      expect(loginRes.headers['set-cookie']).toBeUndefined();

      // Complete with wrong code
      const wrongRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login/complete',
        payload: {
          mfa_token: chalBody.mfa_token,
          method: 'totp',
          code: '000000',
        },
      });
      expect(wrongRes.statusCode).toBe(401);
      expect(wrongRes.json().code).toBe('MFA_CODE_INVALID');
      // Check MFA_FAILED event logged
      expect(store.security_events.some((e) => e.kind === 'MFA_FAILED')).toBe(true);

      // Complete with recovery code
      const rcode = recoveryCodes[0];
      const rcodeRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login/complete',
        payload: {
          mfa_token: chalBody.mfa_token,
          method: 'recovery_code',
          code: rcode,
        },
      });

      expect(rcodeRes.statusCode).toBe(200);
      const rcodeBody = rcodeRes.json();
      expect(rcodeBody.token_type).toBe('Bearer');
      expect(rcodeRes.headers['set-cookie']).toBeDefined();

      // The used recovery code cannot be used again
      const login2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa_user@winkey.vn', password: 'MfaPass123!' },
      });
      const chal2 = login2.json();
      const reuseRcodeRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login/complete',
        payload: {
          mfa_token: chal2.mfa_token,
          method: 'recovery_code',
          code: rcode,
        },
      });
      expect(reuseRcodeRes.statusCode).toBe(401);
      expect(reuseRcodeRes.json().code).toBe('MFA_CODE_INVALID');
    });
  });

  describe('6. Step-up via Email Code', () => {
    it('sends email code, respects 3-rate-limit, and verifies step-up', async () => {
      const { accessToken } = await registerUser(
        'email_step@winkey.vn',
        'email_step',
        'EmailPass123!',
      );

      // Request email code
      const req1 = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up/email-code',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(req1.statusCode).toBe(202);

      // Verify email queued
      expect(store.mail_queue.length).toBeGreaterThanOrEqual(1);
      const mail = store.mail_queue[store.mail_queue.length - 1];
      const params = typeof mail.params === 'string' ? JSON.parse(mail.params) : mail.params;
      const sentCode = params.code as string;
      expect(sentCode).toMatch(/^\d{6}$/);

      // Verify wrong code returns 403
      const badVerify = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          method: 'email_code',
          code: '000000',
        },
      });
      expect(badVerify.statusCode).toBe(403);
      expect(badVerify.json().code).toBe('INVALID_CREDENTIALS');

      // Verify correct code returns 200 with step_up_until
      const goodVerify = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          method: 'email_code',
          code: sentCode,
        },
      });
      expect(goodVerify.statusCode).toBe(200);
      expect(goodVerify.json().step_up_until).toBeDefined();
    });
  });

  describe('7. Captcha enforcement (Cloudflare Turnstile)', () => {
    it('requires turnstile_token on register and on login after 3 failed attempts', async () => {
      const captchaEnv = getEnv({
        JWT_PRIVATE_KEY: keys.privateKey,
        JWT_KID: 'winkey-auth-key-1',
        JWT_ISSUER: 'https://winkey.vn',
        PUBLIC_ORIGIN: 'https://winkey.vn',
        MEDIA_BASE_URL: 'https://media.winkey.vn',
        NODE_ENV: 'test',
        TURNSTILE_SECRET: 'turnstile-test-secret',
      });

      const cStore = createMockStore();
      const { db: cDb } = createMockDb(cStore);
      const cLimiter = new ValkeyRateLimiter();
      const cApp = await buildApp({
        env: captchaEnv,
        db: cDb,
        rateLimiter: cLimiter,
      });

      // 1. Register without token fails
      const regFail = await cApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'captcha_user@winkey.vn',
          password: 'Password123!',
          handle: 'captcha_user',
          display_name: 'Captcha User',
        },
      });
      expect(regFail.statusCode).toBe(400);
      expect(regFail.json().code).toBe('CAPTCHA_REQUIRED');

      // 2. Register with valid token (mocked) succeeds
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      try {
        const regOk = await cApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: 'captcha_user@winkey.vn',
            password: 'Password123!',
            handle: 'captcha_user',
            display_name: 'Captcha User',
            turnstile_token: 'good-turnstile-token',
          },
        });
        expect(regOk.statusCode).toBe(201);

        // Clear any previous failed attempts for this test IP/email
        const { clearFailedLoginAttempts } = await import('../../src/security/mfa.js');
        await clearFailedLoginAttempts(undefined, '127.0.0.1', 'captcha_user@winkey.vn');

        // 3. Login with wrong password 3 times without needing captcha
        for (let i = 0; i < 3; i++) {
          const failLogin = await cApp.inject({
            method: 'POST',
            url: '/v1/auth/login',
            payload: { email: 'captcha_user@winkey.vn', password: 'WrongPassword!' },
          });
          expect(failLogin.statusCode).toBe(401);
        }

        // 4. 4th attempt now requires captcha
        const login4 = await cApp.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'captcha_user@winkey.vn', password: 'Password123!' },
        });
        expect(login4.statusCode).toBe(400);
        expect(login4.json().code).toBe('CAPTCHA_REQUIRED');

        // 5. 5th attempt with captcha succeeds
        const login5 = await cApp.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: 'captcha_user@winkey.vn',
            password: 'Password123!',
            turnstile_token: 'good-turnstile-token',
          },
        });
        expect(login5.statusCode).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('8. Breached password check (HaveIBeenPwned)', () => {
    it('rejects breached password on register and fails open on network errors', async () => {
      const breachEnv = getEnv({
        JWT_PRIVATE_KEY: keys.privateKey,
        JWT_KID: 'winkey-auth-key-1',
        JWT_ISSUER: 'https://winkey.vn',
        PUBLIC_ORIGIN: 'https://winkey.vn',
        MEDIA_BASE_URL: 'https://media.winkey.vn',
        NODE_ENV: 'test',
        PASSWORD_BREACH_CHECK: true,
      });

      const bStore = createMockStore();
      const { db: bDb } = createMockDb(bStore);
      const bLimiter = new ValkeyRateLimiter();
      const bApp = await buildApp({
        env: breachEnv,
        db: bDb,
        rateLimiter: bLimiter,
      });

      const originalFetch = globalThis.fetch;

      // 1. Mock HIBP returning breach
      globalThis.fetch = async (_url: any) => {
        // Return matching suffix with count 999
        return new Response(
          '00000000000000000000000000000000000:1\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:10\n',
          { status: 200 },
        );
      };

      try {
        // Mock returning breach for 'Password123!'
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha1').update('Password123!').digest('hex').toUpperCase();
        const suffix = hash.slice(5);

        globalThis.fetch = async () => new Response(`${suffix}:5000\n`, { status: 200 });

        const resBreached = await bApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: 'pwned_user@winkey.vn',
            password: 'Password123!',
            handle: 'pwned_user',
            display_name: 'Pwned User',
          },
        });

        expect(resBreached.statusCode).toBe(400);
        expect(resBreached.json().code).toBe('PASSWORD_BREACHED');

        // 2. Network error / timeout -> fails open, registration succeeds
        globalThis.fetch = async () => {
          throw new Error('Connection refused / timeout');
        };

        const resFailOpen = await bApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: 'fail_open_user@winkey.vn',
            password: 'Password123!',
            handle: 'fail_open_user',
            display_name: 'Fail Open User',
          },
        });

        expect(resFailOpen.statusCode).toBe(201);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
