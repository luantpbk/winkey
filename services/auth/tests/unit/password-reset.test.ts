import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { RevocationService } from '../../src/revocation/revocation.js';
import { hashPassword, verifyPassword } from '../../src/crypto/passwords.js';
import { generateEmailToken } from '../../src/tokens/email-tokens.js';

describe('password-reset routes (unit)', () => {
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
  let revocationService: RevocationService;

  beforeEach(async () => {
    store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();
    revocationService = new RevocationService(null);
    vi.spyOn(revocationService, 'revokeUser').mockResolvedValue(true);

    app = await buildApp({
      env,
      db,
      rateLimiter,
      revocationService,
    });
  });

  describe('POST /v1/auth/password/forgot', () => {
    it('returns 202 and queues reset mail for active user', async () => {
      const passwordHash = await hashPassword('CurrentPassword123!');
      store.users.push({
        id: 'user-active-1',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: passwordHash,
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

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'alice@winkey.vn',
          locale: 'en',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(res.body).toBe('');

      // Token and mail created
      expect(store.email_tokens).toHaveLength(1);
      expect(store.email_tokens[0].user_id).toBe('user-active-1');
      expect(store.email_tokens[0].purpose).toBe('RESET_PASSWORD');

      expect(store.mail_queue).toHaveLength(1);
      expect(store.mail_queue[0].template).toBe('RESET_PASSWORD');
      expect(store.mail_queue[0].locale).toBe('en');
      expect(store.mail_queue[0].params.link).toContain('/en/reset-password?token=');
    });

    it('returns 202 and queues nothing for unknown email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'nobody@winkey.vn',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(store.email_tokens).toHaveLength(0);
      expect(store.mail_queue).toHaveLength(0);
    });

    it('returns 202 and queues nothing for suspended user', async () => {
      store.users.push({
        id: 'user-suspended-1',
        email: 'banned@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'banned',
        display_name: 'Banned',
        avatar_key: null,
        roles: ['viewer'],
        status: 'SUSPENDED',
        suspended_until: null,
        suspension_reason: 'Abuse',
        created_at: new Date(),
        updated_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'banned@winkey.vn',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(store.email_tokens).toHaveLength(0);
      expect(store.mail_queue).toHaveLength(0);
    });

    it('enforces 3 reset tokens per user per hour cap (extra requests return 202 and send nothing)', async () => {
      store.users.push({
        id: 'user-cap-1',
        email: 'bob@winkey.vn',
        email_verified_at: null,
        password_hash: 'hash',
        handle: 'bob',
        display_name: 'Bob',
        avatar_key: null,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // 3 requests within the hour
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/password/forgot',
          payload: { email: 'bob@winkey.vn' },
        });
        expect(res.statusCode).toBe(202);
      }

      expect(store.email_tokens).toHaveLength(3);
      expect(store.mail_queue).toHaveLength(3);

      // 4th request: still 202, but does not create 4th token or mail
      const res4 = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: { email: 'bob@winkey.vn' },
      });
      expect(res4.statusCode).toBe(202);
      expect(store.email_tokens).toHaveLength(3);
      expect(store.mail_queue).toHaveLength(3);
    });
  });

  describe('POST /v1/auth/password/reset', () => {
    it('rejects invalid or malformed tokens with 400 INVALID_TOKEN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: 'invalid_short_token',
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects unknown token with 400 INVALID_TOKEN', async () => {
      const dummy = generateEmailToken('RESET_PASSWORD');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: dummy.rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects expired token with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash } = generateEmailToken('RESET_PASSWORD');
      store.users.push({
        id: 'user-expired-1',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'old_hash',
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
        user_id: 'user-expired-1',
        purpose: 'RESET_PASSWORD',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000), // expired 1h ago
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects already used token with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
      store.users.push({
        id: 'user-used-1',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'old_hash',
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
        user_id: 'user-used-1',
        purpose: 'RESET_PASSWORD',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: new Date(), // used!
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects token with wrong purpose (VERIFY_EMAIL) with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');
      store.users.push({
        id: 'user-verify-1',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'old_hash',
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
        user_id: 'user-verify-1',
        purpose: 'VERIFY_EMAIL',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects token when user email has changed with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
      store.users.push({
        id: 'user-changed-1',
        email: 'newemail@winkey.vn', // changed!
        email_verified_at: null,
        password_hash: 'old_hash',
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
        user_id: 'user-changed-1',
        purpose: 'RESET_PASSWORD',
        token_hash: tokenHash,
        email: 'oldemail@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('rejects token when user is suspended with 400 INVALID_TOKEN', async () => {
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
      store.users.push({
        id: 'user-banned-1',
        email: 'alice@winkey.vn',
        email_verified_at: null,
        password_hash: 'old_hash',
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
        user_id: 'user-banned-1',
        purpose: 'RESET_PASSWORD',
        token_hash: tokenHash,
        email: 'alice@winkey.vn',
        created_at: new Date(),
        expires_at: expiresAt,
        used_at: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
    });

    it('happy path: updates password, marks tokens used, verifies email, revokes sessions, queues mail', async () => {
      const oldHash = await hashPassword('OldPassword123!');
      const user = {
        id: 'user-reset-happy',
        email: 'charlie@winkey.vn',
        email_verified_at: null,
        password_hash: oldHash,
        handle: 'charlie',
        display_name: 'Charlie',
        avatar_key: null,
        roles: ['viewer' as const],
        status: 'ACTIVE' as const,
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.users.push(user);

      // 2 unused reset tokens for this user
      const t1 = generateEmailToken('RESET_PASSWORD');
      const t2 = generateEmailToken('RESET_PASSWORD');
      store.email_tokens.push({
        id: uuidv7(),
        user_id: user.id,
        purpose: 'RESET_PASSWORD',
        token_hash: t1.tokenHash,
        email: user.email,
        created_at: new Date(),
        expires_at: t1.expiresAt,
        used_at: null,
      });
      store.email_tokens.push({
        id: uuidv7(),
        user_id: user.id,
        purpose: 'RESET_PASSWORD',
        token_hash: t2.tokenHash,
        email: user.email,
        created_at: new Date(),
        expires_at: t2.expiresAt,
        used_at: null,
      });

      // Active refresh token family
      store.refresh_tokens.push({
        id: uuidv7(),
        user_id: user.id,
        family_id: uuidv7(),
        token_hash: Buffer.alloc(32),
        parent_id: null,
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 100000),
        rotated_at: null,
        revoked_at: null,
        user_agent: 'test',
        ip: '127.0.0.1',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        headers: {
          'accept-language': 'vi-VN,vi;q=0.9',
        },
        payload: {
          token: t1.rawToken,
          new_password: 'NewStrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(204);

      // Password changed
      const updatedUser = store.users.find((u) => u.id === user.id)!;
      const isNewMatch = await verifyPassword(updatedUser.password_hash!, 'NewStrongPassword123!');
      expect(isNewMatch).toBe(true);

      // Email verified
      expect(updatedUser.email_verified_at).not.toBeNull();

      // ALL unused reset tokens of user marked used
      expect(store.email_tokens.every((t) => t.used_at !== null)).toBe(true);

      // Refresh tokens revoked
      expect(store.refresh_tokens[0].revoked_at).not.toBeNull();

      // ADR-019 revocation called
      expect(revocationService.revokeUser).toHaveBeenCalledWith(user.id);

      // PASSWORD_CHANGED mail queued
      expect(store.mail_queue).toHaveLength(1);
      expect(store.mail_queue[0].template).toBe('PASSWORD_CHANGED');
      expect(store.mail_queue[0].locale).toBe('vi');
      expect(store.mail_queue[0].params).toBeNull();
    });
  });
});
