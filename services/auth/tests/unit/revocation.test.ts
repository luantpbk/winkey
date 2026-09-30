import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RevocationService,
  REVOCATION_TTL_SECONDS,
  MGET_TIMEOUT_MS,
  type LoggerLike,
  resetLastWarnAtForTest,
} from '../../src/revocation/revocation.js';
import type { Redis } from 'ioredis';

describe('RevocationService unit tests', () => {
  let mockStore: Map<string, string>;
  let mockRedis: Redis;
  let mockLogger: LoggerLike;
  let loggedWarns: Array<{ obj: Record<string, unknown>; msg?: string }>;

  beforeEach(() => {
    mockStore = new Map<string, string>();
    loggedWarns = [];
    resetLastWarnAtForTest();

    mockLogger = {
      warn: (obj, msg) => {
        loggedWarns.push({ obj, msg });
      },
    };

    mockRedis = {
      status: 'ready',
      get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
      set: vi.fn(async (key: string, val: string, _ex?: string, _ttl?: number) => {
        mockStore.set(key, val);
        return 'OK';
      }),
      mget: vi.fn(async (...keys: string[]) => {
        return keys.map((k) => mockStore.get(k) ?? null);
      }),
      eval: vi.fn(
        async (_script: string, _numKeys: number, key: string, newVal: string, _ttl: string) => {
          const current = mockStore.get(key);
          if (!current || Number(newVal) > Number(current)) {
            mockStore.set(key, newVal);
            return 1;
          }
          return 0;
        },
      ),
    } as unknown as Redis;
  });

  describe('isRevoked matrix', () => {
    it('returns { revoked: false, checked: true } when neither key exists', async () => {
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: false, checked: true });
    });

    it('returns { revoked: true, checked: true } when sid key exists', async () => {
      mockStore.set('auth:revoked:sid:fam-123', '1');
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: true, checked: true });
    });

    it('returns { revoked: true, checked: true } when user cutoff exists and iat < cutoff', async () => {
      mockStore.set('auth:revoked:user:user-456', '1700000000');
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1699999999);
      expect(res).toEqual({ revoked: true, checked: true });
    });

    it('returns { revoked: true, checked: true } when user cutoff exists and iat == cutoff', async () => {
      mockStore.set('auth:revoked:user:user-456', '1700000000');
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: true, checked: true });
    });

    it('returns { revoked: false, checked: true } when user cutoff exists but iat > cutoff', async () => {
      mockStore.set('auth:revoked:user:user-456', '1700000000');
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000001);
      expect(res).toEqual({ revoked: false, checked: true });
    });

    it('returns { revoked: true, checked: true } when both keys exist', async () => {
      mockStore.set('auth:revoked:sid:fam-123', '1');
      mockStore.set('auth:revoked:user:user-456', '1700000000');
      const service = new RevocationService(mockRedis, mockLogger);
      // Even if iat > user cutoff, sid key being present revokes it
      const res = await service.isRevoked('fam-123', 'user-456', 1700000001);
      expect(res).toEqual({ revoked: true, checked: true });
    });
  });

  describe('fail-open behaviour', () => {
    it('returns { revoked: false, checked: false } when redis is null', async () => {
      const service = new RevocationService(null, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: false, checked: false });
      expect(loggedWarns.length).toBe(0);
    });

    it('returns { revoked: false, checked: false } without calling mget or logging when redis status is not ready', async () => {
      (mockRedis as unknown as { status: string }).status = 'connecting';
      const service = new RevocationService(mockRedis, mockLogger);
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: false, checked: false });
      expect(mockRedis.mget).not.toHaveBeenCalled();
      expect(loggedWarns.length).toBe(0);
    });

    it('returns { revoked: false, checked: false } when Valkey throws an error', async () => {
      mockRedis.mget = vi.fn().mockRejectedValue(new Error('Valkey connection refused'));
      const service = new RevocationService(mockRedis, mockLogger);

      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res).toEqual({ revoked: false, checked: false });
      expect(loggedWarns.length).toBe(1);
      expect(loggedWarns[0].obj.sid).toBe('fam-123');
      expect(loggedWarns[0].obj.userId).toBe('user-456');
      expect(loggedWarns[0].obj.err).toContain('Valkey connection refused');
    });

    it('throttles warning logs to at most once per 10 seconds during continuous errors', async () => {
      mockRedis.mget = vi.fn().mockRejectedValue(new Error('Valkey down'));
      const service = new RevocationService(mockRedis, mockLogger);

      // First error logs a warning
      const res1 = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res1).toEqual({ revoked: false, checked: false });
      expect(loggedWarns.length).toBe(1);

      // Second error immediately after does NOT log
      const res2 = await service.isRevoked('fam-123', 'user-456', 1700000000);
      expect(res2).toEqual({ revoked: false, checked: false });
      expect(loggedWarns.length).toBe(1);

      // Advance time past 10 seconds -> third error logs again
      const originalDateNow = Date.now;
      try {
        Date.now = () => originalDateNow() + 10_001;
        const res3 = await service.isRevoked('fam-123', 'user-456', 1700000000);
        expect(res3).toEqual({ revoked: false, checked: false });
        expect(loggedWarns.length).toBe(2);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('returns { revoked: false, checked: false } when Valkey hangs past 50 ms timeout', async () => {
      // Fake client that never resolves
      mockRedis.mget = vi.fn(async () => new Promise<never>(() => {}));
      const service = new RevocationService(mockRedis, mockLogger);

      const start = Date.now();
      const res = await service.isRevoked('fam-123', 'user-456', 1700000000);
      const elapsed = Date.now() - start;

      expect(res).toEqual({ revoked: false, checked: false });
      expect(elapsed).toBeGreaterThanOrEqual(MGET_TIMEOUT_MS - 10);
      expect(elapsed).toBeLessThan(300);
      expect(loggedWarns.length).toBe(1);
      expect(loggedWarns[0].obj.err).toContain('timed out after 50ms');
    });
  });

  describe('revokeSession', () => {
    it('writes key with EX 960 and returns true', async () => {
      const service = new RevocationService(mockRedis, mockLogger);
      const ok = await service.revokeSession('fam-123');
      expect(ok).toBe(true);
      expect(mockStore.get('auth:revoked:sid:fam-123')).toBe('1');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth:revoked:sid:fam-123',
        '1',
        'EX',
        REVOCATION_TTL_SECONDS,
      );
    });

    it('handles Valkey write failure gracefully without throwing', async () => {
      mockRedis.set = vi.fn().mockRejectedValue(new Error('Valkey read-only replica'));
      const service = new RevocationService(mockRedis, mockLogger);

      const ok = await service.revokeSession('fam-123');
      expect(ok).toBe(false);
      expect(loggedWarns.length).toBe(1);
      expect(loggedWarns[0].obj.sid).toBe('fam-123');
      expect(loggedWarns[0].obj.err).toContain('Valkey read-only replica');
    });
  });

  describe('revokeUser', () => {
    it('sets cutoff timestamp and never lowers an existing higher cutoff', async () => {
      const service = new RevocationService(mockRedis, mockLogger);

      // 1. Initial cutoff: 1700000500
      await service.revokeUser('user-1', new Date(1700000500 * 1000));
      expect(mockStore.get('auth:revoked:user:user-1')).toBe('1700000500');

      // 2. Attempt to write an earlier cutoff: 1700000100 -> should NOT lower it
      await service.revokeUser('user-1', new Date(1700000100 * 1000));
      expect(mockStore.get('auth:revoked:user:user-1')).toBe('1700000500');

      // 3. Attempt to write an even later cutoff: 1700000900 -> should update
      await service.revokeUser('user-1', new Date(1700000900 * 1000));
      expect(mockStore.get('auth:revoked:user:user-1')).toBe('1700000900');
    });

    it('fallback without eval also never lowers cutoff', async () => {
      // Remove eval to test fallback branch
      delete (mockRedis as unknown as { eval?: unknown }).eval;
      const service = new RevocationService(mockRedis, mockLogger);

      await service.revokeUser('user-2', new Date(1700000500 * 1000));
      expect(mockStore.get('auth:revoked:user:user-2')).toBe('1700000500');

      await service.revokeUser('user-2', new Date(1700000100 * 1000));
      expect(mockStore.get('auth:revoked:user:user-2')).toBe('1700000500');

      await service.revokeUser('user-2', new Date(1700000900 * 1000));
      expect(mockStore.get('auth:revoked:user:user-2')).toBe('1700000900');
    });

    it('handles Valkey write failure gracefully without throwing', async () => {
      mockRedis.eval = vi.fn().mockRejectedValue(new Error('Valkey timeout'));
      const service = new RevocationService(mockRedis, mockLogger);

      const ok = await service.revokeUser('user-1');
      expect(ok).toBe(false);
      expect(loggedWarns.length).toBe(1);
      expect(loggedWarns[0].obj.userId).toBe('user-1');
    });
  });
});
