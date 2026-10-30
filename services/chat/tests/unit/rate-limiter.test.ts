import { describe, it, expect } from 'vitest';
import {
  ValkeyRateLimiter,
  buildClaimKeysRateLimitKey,
} from '../../src/rate-limit/valkey-limiter.js';
import { ProblemError } from '../../src/errors/problem.js';

describe('ValkeyRateLimiter (In-Memory Fallback & Cost-Based Weighting)', () => {
  it('allows consumption within limit', async () => {
    const limiter = new ValkeyRateLimiter();
    await expect(
      limiter.consume({ key: 'test:1', limit: 10, windowSeconds: 60, cost: 5 }),
    ).resolves.toBeUndefined();
    await expect(
      limiter.consume({ key: 'test:1', limit: 10, windowSeconds: 60, cost: 5 }),
    ).resolves.toBeUndefined();
  });

  it('throws 429 when cost exceeds remaining limit', async () => {
    const limiter = new ValkeyRateLimiter();
    await limiter.consume({ key: 'test:2', limit: 10, windowSeconds: 60, cost: 8 });

    await expect(
      limiter.consume({ key: 'test:2', limit: 10, windowSeconds: 60, cost: 5 }),
    ).rejects.toThrowError(ProblemError);

    try {
      await limiter.consume({ key: 'test:2', limit: 10, windowSeconds: 60, cost: 5 });
    } catch (err) {
      const pErr = err as ProblemError;
      expect(pErr.status).toBe(429);
      expect(pErr.code).toBe('RATE_LIMITED');
      expect(pErr.headers?.['Retry-After']).toBeDefined();
    }
  });

  it('enforces 600 keys/minute for claimKeys rate limit with weighted cost', async () => {
    const limiter = new ValkeyRateLimiter();
    const userId = '018f0000-0000-7000-8000-000000000001';
    const key = buildClaimKeysRateLimitKey(userId);

    // 3 batches of 200 devices = 600 keys
    await limiter.consume({ key, limit: 600, windowSeconds: 60, cost: 200 });
    await limiter.consume({ key, limit: 600, windowSeconds: 60, cost: 200 });
    await limiter.consume({ key, limit: 600, windowSeconds: 60, cost: 200 });

    // 4th batch of 1 device exceeds 600
    await expect(
      limiter.consume({ key, limit: 600, windowSeconds: 60, cost: 1 }),
    ).rejects.toThrowError(ProblemError);
  });

  it('does not increment counter on rejected request (anti-starvation)', async () => {
    const limiter = new ValkeyRateLimiter();
    const key = 'test:anti-starve';

    // Used 5 of 10
    await limiter.consume({ key, limit: 10, windowSeconds: 60, cost: 5 });

    // Attempting cost 10 fails (5 + 10 > 10)
    await expect(
      limiter.consume({ key, limit: 10, windowSeconds: 60, cost: 10 }),
    ).rejects.toThrow();

    // A smaller cost of 3 should still succeed (5 + 3 <= 10) because failed request did not inflate counter
    await expect(
      limiter.consume({ key, limit: 10, windowSeconds: 60, cost: 3 }),
    ).resolves.toBeUndefined();
  });
});
