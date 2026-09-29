import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { getTestKeys } from '../fixtures/keys.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { getEnv } from '../../src/config/env.js';

describe('trustProxy and rate-limiting with X-Forwarded-For', () => {
  let app: FastifyInstance;
  let limiter: ValkeyRateLimiter;
  let store: MockStore;
  const keys = getTestKeys();

  beforeEach(async () => {
    limiter = new ValkeyRateLimiter();
    store = createMockStore();
    const { db } = createMockDb(store);
    const env = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      TRUST_PROXY_CIDRS: '10.42.0.0/16,127.0.0.1',
      NODE_ENV: 'test',
    });
    app = await buildApp({ env, db, rateLimiter: limiter });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('separates rate limit buckets for different X-Forwarded-For client IPs', async () => {
    const ip1 = '203.0.113.10';
    const ip2 = '198.51.100.20';

    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': ip1 },
        payload: { email: 'attempt' + i + '@winkey.vn', password: 'WrongPassword123!' },
      });
      expect(res.statusCode).toBe(401);
    }

    const blockedRes1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': ip1 },
      payload: { email: 'another@winkey.vn', password: 'WrongPassword123!' },
    });
    expect(blockedRes1.statusCode).toBe(429);
    expect(blockedRes1.json().code).toBe('RATE_LIMIT_EXCEEDED');

    const allowedRes2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': ip2 },
      payload: { email: 'user2@winkey.vn', password: 'WrongPassword123!' },
    });
    expect(allowedRes2.statusCode).toBe(401);
    expect(allowedRes2.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('records real client IP from X-Forwarded-For into refresh_tokens.ip', async () => {
    const clientIp = '198.51.100.77';
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'x-forwarded-for': clientIp },
      payload: {
        email: 'client_ip_test@winkey.vn',
        password: 'Password123!',
        handle: 'client_ip_user',
        display_name: 'Client IP User',
      },
    });
    expect(regRes.statusCode).toBe(201);
    expect(store.refresh_tokens.length).toBe(1);
    expect(store.refresh_tokens[0].ip).toBe(clientIp);
  });
});
