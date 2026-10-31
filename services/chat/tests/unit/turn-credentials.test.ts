import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import pino from 'pino';
import { parse as parseYaml } from 'yaml';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { buildApp } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import { REDACT_PATHS } from '../../src/infra/logger.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import { parseTurnConfig, turnCredential } from '../../src/routes/calls.js';
import type { RateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { ProblemError } from '../../src/errors/problem.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
const SECRET = 'north-pole-test-secret';

function schema(name: string) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const dir = path.resolve(__dirname, '../../../../contracts/openapi');
  const common = parseYaml(fs.readFileSync(path.join(dir, 'common.yaml'), 'utf8'));
  const chat = parseYaml(fs.readFileSync(path.join(dir, 'chat.v1.yaml'), 'utf8'));
  common.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
  chat.$id = 'https://winkey.vn/contracts/openapi/chat.v1.yaml';
  ajv.addSchema(common);
  ajv.addSchema(chat);
  return ajv.getSchema(
    `https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/${name}`,
  )!;
}

describe('SOC-4a getTurnCredentials', () => {
  it('matches a known coturn REST vector (computed independently with openssl)', () => {
    // printf '%s' '1793404800:<user>' | openssl dgst -sha1 -hmac 'north-pole-test-secret' -binary | openssl base64
    expect(turnCredential(SECRET, `1793404800:${USER}`)).toBe('zSfKT4mfPoaIkm869a9Daqk1RxI=');
  });

  it('is configured only with a secret and at least one turn:/turns:/stun: URL', () => {
    expect(parseTurnConfig({ TURN_TTL_SECONDS: 600 })).toBeNull();
    expect(parseTurnConfig({ TURN_SECRET: 's', TURN_URLS: ' ', TURN_TTL_SECONDS: 600 })).toBeNull();
    expect(
      parseTurnConfig({ TURN_SECRET: 's', TURN_URLS: 'https://x', TURN_TTL_SECONDS: 600 }),
    ).toBeNull();
    expect(
      parseTurnConfig({
        TURN_SECRET: 's',
        TURN_URLS: 'turn:turn.winkey.vn:3478?transport=udp, turns:turn.winkey.vn:443?transport=tcp',
        TURN_TTL_SECONDS: 600,
      }),
    ).toEqual({
      secret: 's',
      urls: ['turn:turn.winkey.vn:3478?transport=udp', 'turns:turn.winkey.vn:443?transport=tcp'],
      ttlSeconds: 600,
    });
    expect(() => loadEnv({ NODE_ENV: 'test', TURN_TTL_SECONDS: '5' })).toThrow();
    expect(loadEnv({ NODE_ENV: 'test' }).TURN_TTL_SECONDS).toBe(600);
  });

  it('returns credentials that match the contract, expire after the TTL and never reach the logs', async () => {
    const logs: string[] = [];
    const loggerInstance = pino(
      { level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      new Writable({
        write(chunk, _e, cb) {
          logs.push(chunk.toString());
          cb();
        },
      }),
    );
    const app = await buildApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: createMockDb(createMockStore()),
      loggerInstance,
      turn: { secret: SECRET, urls: ['turn:turn.winkey.vn:3478'], ttlSeconds: 600 },
    });
    try {
      const before = Math.floor(Date.now() / 1000);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/calls/turn-credentials',
        headers: { 'x-user-id': USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(schema('TurnCredentials')(body)).toBe(true);
      const [expiry, user] = body.username.split(':');
      expect(user).toBe(USER);
      expect(Number(expiry) - before).toBeGreaterThanOrEqual(600);
      expect(Number(expiry) - before).toBeLessThanOrEqual(601);
      expect(body.credential).toBe(turnCredential(SECRET, body.username));
      expect(body).toMatchObject({ urls: ['turn:turn.winkey.vn:3478'], ttl_seconds: 600 });
      expect(new Date(body.expires_at).getTime()).toBe(Number(expiry) * 1000);

      expect(logs.join('\n')).not.toContain(body.credential);
      expect(logs.join('\n')).not.toContain(SECRET);

      const anon = await app.inject({ method: 'POST', url: '/v1/chat/calls/turn-credentials' });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('answers 503 without TURN config, and 429 past 30 per hour', async () => {
    const noTurn = await buildApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: createMockDb(createMockStore()),
      turn: null,
    });
    const res = await noTurn.inject({
      method: 'POST',
      url: '/v1/chat/calls/turn-credentials',
      headers: { 'x-user-id': USER },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('TURN_UNAVAILABLE');
    await noTurn.close();

    const calls: Array<{ key: string; limit: number; windowSeconds: number }> = [];
    const limiter: RateLimiter = {
      async consume(o) {
        calls.push(o);
        if (calls.length > 30) throw ProblemError.tooManyRequests(60);
      },
      async close() {},
    };
    const app = await buildApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: createMockDb(createMockStore()),
      rateLimiter: limiter,
      turn: { secret: SECRET, urls: ['turn:t:3478'], ttlSeconds: 600 },
    });
    try {
      let last = 0;
      for (let i = 0; i < 31; i++) {
        last = (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/calls/turn-credentials',
            headers: { 'x-user-id': USER },
          })
        ).statusCode;
      }
      expect(last).toBe(429);
      expect(calls[0]).toEqual({ key: `rl:chat:turn:${USER}`, limit: 30, windowSeconds: 3600 });
    } finally {
      await app.close();
    }
  });
});
