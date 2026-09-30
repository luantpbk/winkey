import type { Redis } from 'ioredis';
import { createRegistry, Counter } from '@winkey/metrics';

export const REVOCATION_TTL_SECONDS = 960; // 900s access token TTL + 60s clock skew
export const MGET_TIMEOUT_MS = 50;

export const LUA_REVOKE_USER = `
local current = redis.call('GET', KEYS[1])
if not current or tonumber(ARGV[1]) > tonumber(current) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
else
  return 0
end
`;

export interface RevocationCheckResult {
  revoked: boolean;
  checked: boolean;
}

export interface LoggerLike {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info?(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}

// Prometheus metrics registry & counters
export const authRegistry = createRegistry('auth-svc');

export const revocationWriteCounter = new Counter({
  name: 'auth_revocation_write_total',
  help: 'Total number of revocation write operations',
  labelNames: ['result'],
  registers: [authRegistry],
});

export const verifyRevocationCheckCounter = new Counter({
  name: 'auth_verify_revocation_check_total',
  help: 'Total number of verify revocation checks by result',
  labelNames: ['result'],
  registers: [authRegistry],
});

let lastWarnAt = 0;

export function resetLastWarnAtForTest(): void {
  lastWarnAt = 0;
}

export class RevocationService {
  private redis: Redis | null;
  private logger?: LoggerLike;

  constructor(redis: Redis | null = null, logger?: LoggerLike) {
    this.redis = redis;
    this.logger = logger;
  }

  setRedis(redis: Redis | null): void {
    this.redis = redis;
  }

  setLogger(logger: LoggerLike): void {
    this.logger = logger;
  }

  /**
   * Revokes a specific session (refresh token family).
   * SET auth:revoked:sid:{sid} 1 EX 960
   * Executed AFTER DB commit. Never throws.
   */
  async revokeSession(sid: string): Promise<boolean> {
    if (!this.redis) {
      return false;
    }
    const key = `auth:revoked:sid:${sid}`;
    try {
      await this.redis.set(key, '1', 'EX', REVOCATION_TTL_SECONDS);
      revocationWriteCounter.inc({ result: 'ok' });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ sid, err: msg }, 'Failed to write session revocation to Valkey');
      revocationWriteCounter.inc({ result: 'error' });
      return false;
    }
  }

  /**
   * Revokes all access tokens for a user issued at or before `now`.
   * SET auth:revoked:user:{userId} {unixSeconds(now)} EX 960
   * Atomic Lua script ensures the cutoff timestamp is never lowered.
   * Executed AFTER DB commit. Never throws.
   */
  async revokeUser(userId: string, now: Date = new Date()): Promise<boolean> {
    if (!this.redis) {
      return false;
    }
    const unixSeconds = Math.floor(now.getTime() / 1000);
    const key = `auth:revoked:user:${userId}`;

    try {
      if (typeof this.redis.eval === 'function') {
        await this.redis.eval(
          LUA_REVOKE_USER,
          1,
          key,
          String(unixSeconds),
          String(REVOCATION_TTL_SECONDS),
        );
      } else {
        // Fallback for minimal mocks without Lua eval support
        const current = await this.redis.get(key);
        if (!current || unixSeconds > Number(current)) {
          await this.redis.set(key, String(unixSeconds), 'EX', REVOCATION_TTL_SECONDS);
        }
      }
      revocationWriteCounter.inc({ result: 'ok' });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ userId, err: msg }, 'Failed to write user revocation to Valkey');
      revocationWriteCounter.inc({ result: 'error' });
      return false;
    }
  }

  /**
   * Checks whether a session (sid) or user has been revoked.
   * Reads both keys in ONE MGET with a 50 ms timeout.
   * Returns:
   *   { revoked: true, checked: true }  - if sid exists OR (user cutoff exists AND iat <= cutoff)
   *   { revoked: false, checked: true } - if neither key indicates revocation
   *   { revoked: false, checked: false } - fail-open on Valkey error/timeout/null client
   */
  async isRevoked(sid: string, userId: string, iat: number): Promise<RevocationCheckResult> {
    if (!this.redis || this.redis.status !== 'ready') {
      return { revoked: false, checked: false };
    }

    const sidKey = `auth:revoked:sid:${sid}`;
    const userKey = `auth:revoked:user:${userId}`;

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Revocation check timed out after 50ms')),
        MGET_TIMEOUT_MS,
      );
    });

    try {
      const mgetPromise = this.redis.mget(sidKey, userKey);
      // Attach no-op catch to prevent unhandled rejection if timeout triggers before redis error
      mgetPromise.catch(() => {});

      const results = await Promise.race([mgetPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      const [sidVal, userVal] = results;

      // 1. Session revoked?
      if (sidVal !== null && sidVal !== undefined) {
        return { revoked: true, checked: true };
      }

      // 2. User cutoff revoked?
      if (userVal !== null && userVal !== undefined) {
        const cutoff = Number(userVal);
        if (!Number.isNaN(cutoff) && iat <= cutoff) {
          return { revoked: true, checked: true };
        }
      }

      return { revoked: false, checked: true };
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const now = Date.now();
      if (now - lastWarnAt >= 10_000) {
        lastWarnAt = now;
        this.logger?.warn(
          { sid, userId, err: msg },
          'Revocation check failed or timed out (fail-open)',
        );
      }
      return { revoked: false, checked: false };
    }
  }
}
