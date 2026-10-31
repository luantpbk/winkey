import { Redis } from 'ioredis';
import { ProblemError } from '../errors/problem.js';

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
  cost?: number;
}

export interface RateLimiter {
  consume(options: RateLimitOptions): Promise<void>;
  close(): Promise<void>;
}

export class ValkeyRateLimiter implements RateLimiter {
  private readonly redis: Redis | null;
  private readonly memoryStore = new Map<string, { count: number; resetAt: number }>();

  constructor(valkeyUrl?: string, customRedis?: Redis | null) {
    if (customRedis !== undefined) {
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
    const { key, limit, windowSeconds, cost = 1 } = options;

    if (cost <= 0) return;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const lua = `
          local key = KEYS[1]
          local window = tonumber(ARGV[1])
          local limit = tonumber(ARGV[2])
          local cost = tonumber(ARGV[3])

          local current = tonumber(redis.call('GET', key) or '0')
          if current + cost > limit then
            local ttl = redis.call('TTL', key)
            if ttl < 0 then ttl = window end
            return { 0, current, ttl }
          end

          local next_val = redis.call('INCRBY', key, cost)
          if next_val == cost then
            redis.call('EXPIRE', key, window)
          end
          local ttl = redis.call('TTL', key)
          if ttl < 0 then ttl = window end
          return { 1, next_val, ttl }
        `;
        const res = (await this.redis.eval(lua, 1, key, windowSeconds, limit, cost)) as [
          number,
          number,
          number,
        ];
        const allowed = res[0];
        const ttl = res[2] > 0 ? res[2] : windowSeconds;

        if (allowed === 0) {
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
      if (cost > limit) {
        this.memoryStore.set(key, { count: 0, resetAt: now + windowSeconds * 1000 });
        throw ProblemError.tooManyRequests(windowSeconds);
      }
      this.memoryStore.set(key, { count: cost, resetAt: now + windowSeconds * 1000 });
      return;
    }

    if (entry.count + cost > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw ProblemError.tooManyRequests(Math.max(1, retryAfter));
    }
    entry.count += cost;
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}

export function buildClaimKeysRateLimitKey(userId: string): string {
  return `rl:chat:claim:${userId}`;
}

export function buildMessageRateLimitKey(userId: string): string {
  return `rl:chat:msg:${userId}`;
}

export function buildToDeviceRateLimitKey(userId: string): string {
  return `rl:chat:todev:${userId}`;
}

export function buildCreateConversationRateLimitKey(userId: string): string {
  return `rl:chat:conv:${userId}`;
}

export function buildTurnCredentialsRateLimitKey(userId: string): string {
  return `rl:chat:turn:${userId}`;
}

export function buildMessageRequestRateLimitKey(userId: string): string {
  return `rl:chat:req:${userId}`;
}

export function buildCreateAttachmentRateLimitKey(userId: string): string {
  return `rl:chat:attachment_create:${userId}`;
}

export function buildDownloadAttachmentRateLimitKey(userId: string): string {
  return `rl:chat:attachment_download:${userId}`;
}

export function buildPutKeyBackupRateLimitKey(userId: string): string {
  return `rl:chat:key_backup_put:${userId}`;
}

export function buildGetKeyBackupRateLimitKey(userId: string): string {
  return `rl:chat:key_backup_get:${userId}`;
}

export function buildKeyBackupSessionsRateLimitKey(userId: string): string {
  return `rl:chat:key_backup_sessions:${userId}`;
}
