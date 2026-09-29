import { describe, it, expect } from 'vitest';
import {
  ValkeyRateLimiter,
  buildCommentRateLimitKey,
  buildLikeRateLimitKey,
  buildSubscriptionRateLimitKey,
} from '../../src/rate-limit/valkey-limiter.js';
import { ProblemError } from '../../src/errors/problem.js';

describe('ValkeyRateLimiter (In-Memory Fallback)', () => {
  it('allows requests within limit and throws 429 when exceeded', async () => {
    const limiter = new ValkeyRateLimiter();
    const key = buildCommentRateLimitKey('user-123');

    // Limit 2 for test
    await limiter.consume({ key, limit: 2, windowSeconds: 10 });
    await limiter.consume({ key, limit: 2, windowSeconds: 10 });

    try {
      await limiter.consume({ key, limit: 2, windowSeconds: 10 });
      expect.fail('Expected rate limit error');
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      const problem = err as ProblemError;
      expect(problem.status).toBe(429);
      expect(problem.headers?.['Retry-After']).toBeDefined();
    }
  });

  it('generates proper rate limit keys', () => {
    expect(buildCommentRateLimitKey('u1')).toBe('rl:social:comment:u1');
    expect(buildLikeRateLimitKey('u1')).toBe('rl:social:like:u1');
    expect(buildSubscriptionRateLimitKey('u1')).toBe('rl:social:sub:u1');
  });
});
