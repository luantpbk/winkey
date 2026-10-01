import { describe, it, expect, beforeEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { issueAccessToken } from '../../src/crypto/jwt.js';
import { generateEmailToken } from '../../src/tokens/email-tokens.js';

describe('email-verification routes (unit)', () => {
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
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  describe('POST /v1/auth/email/verification (resend)', () => {
    it('requires authentication (401 without Bearer token)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verification',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 409 EMAIL_ALREADY_VERIFIED when user is already verified', async () => {
      const userId = 'user-verified-1';
      store.users.push({
        id: userId,
        email: 'verified@winkey.vn',
        email_verified_at: new Date(),
        password_hash: 'hash',
        handle: 'verified',
        display_name: 'Verified User',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token: accessToken } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        uuidv7(),
        env,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verification',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('EMAIL_ALREADY_VERIFIED');
    });

    it('enforces at most 3 per user per hour cap -> 429 with Retry-After', async () => {
      const userId = 'user-unverified-1';
      store.users.push({
        id: userId,
        email: 'unverified@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'unverified',
        display_name: 'Unverified User',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token: accessToken } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        uuidv7(),
        env,
      );

      // 3 successful requests
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/email/verification',
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode).toBe(202);
      }

      expect(store.email_tokens).toHaveLength(3);
      expect(store.mail_queue).toHaveLength(3);

      // 4th request within hour -> 429
      const res4 = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verification',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res4.statusCode).toBe(429);
      expect(res4.headers['retry-after']).toBeDefined();
    });

    it('happy path: returns 202, queues VERIFY_EMAIL with link and locale from Accept-Language', async () => {
      const userId = 'user-locale-test';
      store.users.push({
        id: userId,
        email: 'david@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'david',
        display_name: 'David',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token: accessToken } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        uuidv7(),
        env,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verification',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(store.email_tokens).toHaveLength(1);
      expect(store.email_tokens[0].purpose).toBe('VERIFY_EMAIL');

      expect(store.mail_queue).toHaveLength(1);
      expect(store.mail_queue[0].template).toBe('VERIFY_EMAIL');
      expect(store.mail_queue[0].locale).toBe('en');
      expect(store.mail_queue[0].params.link).toContain('/en/verify-email?token=');
    });
  });

  describe('POST /v1/auth/email/verify', () => {
    it('rejects unknown token with 400 INVALID_TOKEN', async () => {
      const dummy = generateEmailToken('VERIFY_EMAIL');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: dummy.rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects expired token with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash } = generateEmailToken('VERIFY_EMAIL');
      store.users.push({
        id: 'user-expired-v',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: 'user-expired-v',
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(Date.now() - 50 * 60 * 60 * 1000),
        expires_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // expired
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects already used token with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
      store.users.push({
        id: 'user-used-v',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: 'user-used-v',
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: new Date(), // used!
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects wrong purpose (RESET_PASSWORD) with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
      store.users.push({
        id: 'user-wrong-v',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: 'user-wrong-v',
        purpose: 'RESET_PASSWORD', // wrong purpose!
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects token when user email changed with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
      store.users.push({
        id: 'user-email-changed',
        email: 'newemail@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: 'user-email-changed',
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: 'oldemail@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects token when user is suspended with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
      store.users.push({
        id: 'user-suspended-v',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        roles: ['viewer'],
        status: 'SUSPENDED',
        suspended_until: null,
        suspension_reason: 'Violation',
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: 'user-suspended-v',
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('happy path: verifies email, marks token used, returns 204', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
      const user = {
        id: 'user-verify-happy',
        email: 'eve@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'eve',
        display_name: 'Eve',
        avatar_key: null,
        roles: ['viewer' as const],
        status: 'ACTIVE' as const,
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.users.push(user);
      store.email_tokens.push({
        id: uuidv7(),
        user_id: user.id,
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: user.email,
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });

      expect(res.statusCode).toBe(204);

      // Token marked used
      expect(store.email_tokens[0].used_at).not.toBeNull();

      // User email verified
      const updatedUser = store.users.find((u) => u.id === user.id)!;
      expect(updatedUser.email_verified_at).not.toBeNull();

      // Re-using gives 400 INVALID_TOKEN
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: {
          token: rawToken,
        },
      });
      expect(reuseRes.statusCode).toBe(400);
      expect(reuseRes.json().code).toBe('INVALID_TOKEN');
    });
  });
});
