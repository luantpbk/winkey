import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPasswordBreached } from '../../src/security/hibp.js';
import { createHash } from 'node:crypto';

describe('HaveIBeenPwned k-anonymity breach check', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns false immediately when enabled is false', async () => {
    const breached = await isPasswordBreached('password123', null, false);
    expect(breached).toBe(false);
  });

  it('queries HIBP range API with 5 hex prefix and detects breached suffix', async () => {
    const testPassword = 'MySecretBreachedPassword!';
    const sha1 = createHash('sha1').update(testPassword, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `${suffix}:42\n00000000000000000000000000000000000:1\n`,
    } as any);

    const breached = await isPasswordBreached(testPassword, null, true);
    expect(breached).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Add-Padding': 'true',
        }),
      }),
    );
  });

  it('returns false when hash suffix is not in response', async () => {
    const testPassword = 'AStrongUniqueUnbreachedPassword#2026';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:10\n`,
    } as any);

    const breached = await isPasswordBreached(testPassword, null, true);
    expect(breached).toBe(false);
  });

  it('fails open (returns false) on fetch timeout or network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('HIBP timeout'));

    const breached = await isPasswordBreached('anypassword', null, true);
    expect(breached).toBe(false);
  });

  it('uses cached prefix in Redis if present without calling fetch', async () => {
    const testPassword = 'CachedPassword123!';
    const sha1 = createHash('sha1').update(testPassword, 'utf8').digest('hex').toUpperCase();
    const suffix = sha1.slice(5);

    const mockRedis = {
      get: vi.fn().mockResolvedValue(`${suffix}:123\n`),
      set: vi.fn(),
    } as any;

    globalThis.fetch = vi.fn();

    const breached = await isPasswordBreached(testPassword, mockRedis, true);
    expect(breached).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
