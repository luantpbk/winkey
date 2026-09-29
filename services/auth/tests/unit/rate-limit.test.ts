import { describe, it, expect } from 'vitest';
import {
  ValkeyRateLimiter,
  buildLoginRateLimitKeys,
  buildRegisterRateLimitKey,
} from '../../src/rate-limit/valkey-limiter.js';
import { ProblemError } from '../../src/errors/problem.js';

describe('rate-limiter', () => {
  it('allows requests within limit and throws 429 when limit is exceeded', async () => {
    const limiter = new ValkeyRateLimiter(); // In-memory fallback mode
    const key = 'test-key-1';

    // Limit = 3 in window of 60s
    await limiter.consume({ key, limit: 3, windowSeconds: 60 });
    await limiter.consume({ key, limit: 3, windowSeconds: 60 });
    await limiter.consume({ key, limit: 3, windowSeconds: 60 });

    // 4th request must throw ProblemError 429
    try {
      await limiter.consume({ key, limit: 3, windowSeconds: 60 });
      expect.fail('Expected rate limit error');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProblemError);
      expect(err.status).toBe(429);
      expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(err.headers?.['Retry-After']).toBeDefined();
      expect(Number(err.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    }
  });

  it('builds distinct keys for different emails on the same IP', () => {
    const ip = '192.168.1.50';
    const { ipEmailKey: keyA, ipKey } = buildLoginRateLimitKeys(ip, 'userA@winkey.vn');
    const { ipEmailKey: keyB } = buildLoginRateLimitKeys(ip, 'userB@winkey.vn');

    expect(keyA).not.toBe(keyB);
    expect(ipKey).toBe(`rl:login:ip:${ip}`);
  });

  it('builds register rate limit key', () => {
    const key = buildRegisterRateLimitKey('10.0.0.1');
    expect(key).toBe('rl:reg:ip:10.0.0.1');
  });
});
