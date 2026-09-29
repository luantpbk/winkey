import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { TicketStore } from '../../src/tickets/ticket-store.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('OpenAPI Contract Verification against realtime.v1.yaml and common.yaml', () => {
  let app: FastifyInstance;
  let ajv: Ajv;
  let validateTicket: ValidateFunction;
  let validateProblem: ValidateFunction;

  beforeAll(async () => {
    // 1. Load OpenAPI contracts
    const realtimeYamlPath = path.resolve(
      __dirname,
      '../../../../contracts/openapi/realtime.v1.yaml',
    );
    const commonYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/common.yaml');

    const realtimeSpec = parseYaml(fs.readFileSync(realtimeYamlPath, 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));

    // 2. Setup Ajv
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);

    commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    realtimeSpec.$id = 'https://winkey.vn/contracts/openapi/realtime.v1.yaml';

    ajv.addSchema(commonSpec);
    ajv.addSchema(realtimeSpec);

    validateTicket = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/realtime.v1.yaml#/components/schemas/RealtimeTicket',
    )!;
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;

    // 3. Build test server
    const env = getEnv({ NODE_ENV: 'test' });
    const storeMap = new Map<string, string>();
    const mockRedis = {
      status: 'ready',
      set: async (key: string, val: string) => {
        storeMap.set(key, val);
        return 'OK';
      },
      getdel: async (key: string) => {
        const val = storeMap.get(key) || null;
        storeMap.delete(key);
        return val;
      },
    } as unknown as import('ioredis').Redis;

    const ticketStore = new TicketStore(mockRedis);
    const rateLimiter = new ValkeyRateLimiter();

    const server = await buildApp({
      env,
      ticketStore,
      rateLimiter,
    });
    app = server.app;
    await app.ready();
  });

  it('Validates 201 response schema on POST /v1/realtime/ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: {
        'x-user-id': '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        'x-user-roles': 'viewer,creator',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.json();
    const isValid = validateTicket(body);
    expect(validateTicket.errors).toBeNull();
    expect(isValid).toBe(true);
    expect(body.ticket).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it('Validates 401 response schema on unauthenticated POST /v1/realtime/ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');

    const body = res.json();
    const isValid = validateProblem(body);
    expect(validateProblem.errors).toBeNull();
    expect(isValid).toBe(true);
    expect(body.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('Validates 400 response schema on non-upgrade GET /v1/realtime', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/realtime',
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');

    const body = res.json();
    const isValid = validateProblem(body);
    expect(validateProblem.errors).toBeNull();
    expect(isValid).toBe(true);
    expect(body.status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('Validates 429 response schema when rate limit is exceeded', async () => {
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99';

    // Exhaust 30 requests limit
    for (let i = 0; i < 30; i++) {
      const okRes = await app.inject({
        method: 'POST',
        url: '/v1/realtime/ticket',
        headers: {
          'x-user-id': userId,
        },
      });
      expect(okRes.statusCode).toBe(201);
    }

    // 31st request triggers 429
    const res = await app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: {
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['retry-after']).toBeDefined();

    const body = res.json();
    const isValid = validateProblem(body);
    expect(validateProblem.errors).toBeNull();
    expect(isValid).toBe(true);
    expect(body.status).toBe(429);
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
