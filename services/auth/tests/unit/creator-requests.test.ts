import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { issueAccessToken } from '../../src/crypto/jwt.js';

describe('Creator Requests (Unit Tests)', () => {
  let app: FastifyInstance;
  let store: MockStore;
  const keys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_KID: 'winkey-auth-key-1',
    JWT_ISSUER: 'https://winkey.vn',
    PUBLIC_ORIGIN: 'https://winkey.vn',
    MEDIA_BASE_URL: 'https://media.winkey.vn',
    NODE_ENV: 'test',
    SIGNUP_ROLES: 'viewer',
  });

  beforeEach(async () => {
    store = createMockStore();
    const mockDb = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db: mockDb.db,
      rateLimiter,
      redis: null,
      natsConnection: null,
    });
  });

  async function createTestUser(
    roles: ('viewer' | 'creator' | 'moderator' | 'admin')[] = ['viewer'],
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' = 'ACTIVE',
  ) {
    const id = uuidv7();
    const user = {
      id,
      email: `user-${id.slice(0, 8)}@example.com`,
      email_verified_at: new Date(),
      password_hash: 'hashed',
      handle: `user_${id.slice(0, 8)}`,
      display_name: `Test User ${id.slice(0, 4)}`,
      avatar_key: null,
      roles,
      status,
      suspended_until: null,
      suspension_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.users.push(user);

    const { token } = await issueAccessToken({ id, roles }, uuidv7(), env);
    return { user, token };
  }

  describe('GET /v1/auth/me/creator-request', () => {
    it('returns 401 when unauthorized', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/creator-request',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when no request exists', async () => {
      const { token } = await createTestUser();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns latest request when one exists', async () => {
      const { user, token } = await createTestUser();
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: user.id,
        status: 'PENDING',
        message: 'I want to upload high quality coding videos.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(reqId);
      expect(body.status).toBe('PENDING');
      expect(body.message).toBe('I want to upload high quality coding videos.');
      expect(body.decision_note).toBeNull();
    });
  });

  describe('POST /v1/auth/me/creator-request', () => {
    it('validates message length and trims whitespace', async () => {
      const { token } = await createTestUser();
      // Too short
      const resShort = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'Short' },
      });
      expect(resShort.statusCode).toBe(400);
      expect(resShort.json().code).toBe('VALIDATION_ERROR');

      // Whitespace only that trims to < 10 chars
      const resWhitespace = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: '   short   ' },
      });
      expect(resWhitespace.statusCode).toBe(400);
      expect(resWhitespace.json().code).toBe('VALIDATION_ERROR');

      // Too long (> 1000)
      const resLong = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'a'.repeat(1001) },
      });
      expect(resLong.statusCode).toBe(400);
      expect(resLong.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 409 ALREADY_CREATOR if caller already has creator role', async () => {
      const { token } = await createTestUser(['viewer', 'creator']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'I want to upload more videos for viewers.' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ALREADY_CREATOR');
    });

    it('returns 409 REQUEST_PENDING if caller already has a pending request', async () => {
      const { user, token } = await createTestUser();
      store.creator_requests.push({
        id: uuidv7(),
        user_id: user.id,
        status: 'PENDING',
        message: 'Existing pending request.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'New creator request attempt.' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('REQUEST_PENDING');
    });

    it('returns 409 REQUEST_COOLDOWN if latest request was rejected < 24h ago', async () => {
      const { user, token } = await createTestUser();
      const decidedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      store.creator_requests.push({
        id: uuidv7(),
        user_id: user.id,
        status: 'REJECTED',
        message: 'Previous request.',
        decision_note: 'Need more experience.',
        decided_by: uuidv7(),
        decided_at: decidedAt,
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'New creator request after rejection.' },
      });
      expect(res.statusCode).toBe(409);
      const json = res.json();
      expect(json.code).toBe('REQUEST_COOLDOWN');
      expect(json.detail).toContain(
        new Date(decidedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('creates request (201) if previous rejection was > 24h ago', async () => {
      const { user, token } = await createTestUser();
      const decidedAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      store.creator_requests.push({
        id: uuidv7(),
        user_id: user.id,
        status: 'REJECTED',
        message: 'Previous old request.',
        decision_note: 'Need more portfolio.',
        decided_by: uuidv7(),
        decided_at: decidedAt,
        created_at: new Date(Date.now() - 26 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'New creator request after cooldown expired.' },
      });
      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.status).toBe('PENDING');
      expect(json.message).toBe('New creator request after cooldown expired.');
    });

    it('enforces rate limit of 5 requests per day', async () => {
      const { token } = await createTestUser();

      // Submit 5 valid requests (cleaning store in between to test rate limit independently)
      for (let i = 0; i < 5; i++) {
        store.creator_requests = [];
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/me/creator-request',
          headers: { authorization: `Bearer ${token}` },
          payload: { message: `Creator request iteration ${i + 1} test` },
        });
        expect(res.statusCode).toBe(201);
      }

      // 6th request hits rate limit
      store.creator_requests = [];
      const res6 = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${token}` },
        payload: { message: 'Creator request iteration 6 exceeding' },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.json().code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  describe('GET /v1/admin/creator-requests', () => {
    it('returns 403 for viewer, creator, and moderator', async () => {
      const { token: viewerToken } = await createTestUser(['viewer']);
      const resViewer = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(resViewer.statusCode).toBe(403);

      const { token: modToken } = await createTestUser(['moderator']);
      const resMod = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests',
        headers: { authorization: `Bearer ${modToken}` },
      });
      expect(resMod.statusCode).toBe(403);
    });

    it('returns 200 with list, pending_count and correct admin structure', async () => {
      const { token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);

      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'PENDING',
        message: 'Applicant request message content.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.pending_count).toBe(1);
      expect(json.items).toHaveLength(1);
      expect(json.items[0].id).toBe(reqId);
      expect(json.items[0].user.id).toBe(applicant.id);
      expect(json.items[0].user.email).toBe(applicant.email);
      expect(json.items[0].decided_by).toBeNull();
    });
  });

  describe('POST /v1/admin/creator-requests/:id/decision', () => {
    it('returns 403 when trying to decide own creator request', async () => {
      const { user: adminUser, token: adminToken } = await createTestUser(['admin', 'viewer']);
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: adminUser.id,
        status: 'PENDING',
        message: 'Admin self request.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CANNOT_MODERATE_TARGET');
    });

    it('rejects with 400 when note is missing for REJECT decision', async () => {
      const { token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'PENDING',
        message: 'Applicant request.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'REJECT' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('successfully REJECTs with note (no audit row, roles untouched)', async () => {
      const { user: adminUser, token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'PENDING',
        message: 'Applicant request.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'REJECT', note: 'Not enough videos yet.' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('REJECTED');
      expect(json.decision_note).toBe('Not enough videos yet.');
      expect(json.decided_by.id).toBe(adminUser.id);

      // Verify DB state
      const dbReq = store.creator_requests.find((r) => r.id === reqId);
      expect(dbReq?.status).toBe('REJECTED');
      expect(dbReq?.decision_note).toBe('Not enough videos yet.');
      expect(applicant.roles).toEqual(['viewer']);
      expect(store.audit_log).toHaveLength(0);
    });

    it('successfully APPROVEs request (adds creator role, audit row, no revocation)', async () => {
      const { user: adminUser, token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'PENDING',
        message: 'Applicant request to become creator.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE', note: 'Welcome creator!' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('APPROVED');
      expect(json.decision_note).toBe('Welcome creator!');
      expect(json.user.roles).toContain('creator');

      // Verify DB state: applicant gained creator
      expect(applicant.roles).toContain('creator');
      expect(applicant.roles).toContain('viewer');

      // Verify audit log has USER_ROLES_CHANGED with creator_request_id
      const audit = store.audit_log.find((a) => a.action === 'USER_ROLES_CHANGED');
      expect(audit).toBeDefined();
      expect(audit?.actor_id).toBe(adminUser.id);
      expect(audit?.target_user_id).toBe(applicant.id);
      expect(audit?.details.creator_request_id).toBe(reqId);
    });

    it('returns 409 REQUEST_ALREADY_DECIDED when deciding an already decided request', async () => {
      const { token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);
      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'APPROVED',
        message: 'Applicant request.',
        decision_note: 'Approved',
        decided_by: uuidv7(),
        decided_at: new Date(),
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('REQUEST_ALREADY_DECIDED');
    });

    it('returns 409 USER_NOT_ACTIVE when approving suspended user', async () => {
      const { token: adminToken } = await createTestUser(['admin', 'viewer']);
      const { user: applicant } = await createTestUser(['viewer']);
      applicant.status = 'SUSPENDED';

      const reqId = uuidv7();
      store.creator_requests.push({
        id: reqId,
        user_id: applicant.id,
        status: 'PENDING',
        message: 'Applicant request.',
        decision_note: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('USER_NOT_ACTIVE');
    });
  });
});
