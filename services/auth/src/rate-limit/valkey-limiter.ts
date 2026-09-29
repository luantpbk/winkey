import { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { ProblemError } from '../errors/problem.js';

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimiter {
  consume(options: RateLimitOptions): Promise<void>;
  close(): Promise<void>;
}

export class ValkeyRateLimiter implements RateLimiter {
  private readonly redis: Redis | null;
  private readonly memoryStore = new Map<string, { count: number; resetAt: number }>();

  constructor(valkeyUrl?: string, customRedis?: Redis | null) {
    if (customRedis) {
      this.redis = customRedis;
    } else if (valkeyUrl) {
      try {
        this.redis = new Redis(valkeyUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
      } catch {
        this.redis = null;
      }
    } else {
      this.redis = null;
    }
  }

  async consume(options: RateLimitOptions): Promise<void> {
    const { key, limit, windowSeconds } = options;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const lua = `
          local current = redis.call('INCR', KEYS[1])
          if current == 1 then
            redis.call('EXPIRE', KEYS[1], ARGV[1])
          end
          local ttl = redis.call('TTL', KEYS[1])
          return {current, ttl}
        `;
        const res = (await this.redis.eval(lua, 1, key, windowSeconds)) as [number, number];
        const count = res[0];
        const ttl = res[1] > 0 ? res[1] : windowSeconds;

        if (count > limit) {
          throw ProblemError.tooManyRequests(ttl);
        }
        return;
      } catch (err) {
        if (err instanceof ProblemError) throw err;
        // Fall back to memory store on Valkey error
      }
    }

    // In-memory fallback
    const now = Date.now();
    const entry = this.memoryStore.get(key);

    if (!entry || entry.resetAt <= now) {
      this.memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return;
    }

    entry.count += 1;
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw ProblemError.tooManyRequests(Math.max(1, retryAfter));
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}

/**
 * Normalizes email and IP to build safe rate limit keys.
 */
export function buildLoginRateLimitKeys(
  ip: string,
  email: string,
): { ipEmailKey: string; ipKey: string } {
  const normEmail = email.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(`${ip}:${normEmail}`).digest('hex').slice(0, 16);
  return {
    ipEmailKey: `rl:login:ip_email:${hash}`,
    ipKey: `rl:login:ip:${ip}`,
  };
}

export function buildRegisterRateLimitKey(ip: string): string {
  return `rl:reg:ip:${ip}`;
}
