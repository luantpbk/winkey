import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyTurnstileToken } from '../../src/security/turnstile.js';

describe('Cloudflare Turnstile token validation', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('bypasses check when TURNSTILE_SECRET is empty', async () => {
    const valid = await verifyTurnstileToken({ secret: '', token: '' });
    expect(valid).toBe(true);
  });

  it('returns false when token is empty with secret configured', async () => {
    const valid = await verifyTurnstileToken({ secret: 'sec-123', token: '' });
    expect(valid).toBe(false);
  });

  it('calls siteverify endpoint and returns true on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any);

    const valid = await verifyTurnstileToken({
      secret: 'sec-123',
      token: 'valid-token',
      ip: '1.2.3.4',
    });
    expect(valid).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('returns false when siteverify returns failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    } as any);

    const valid = await verifyTurnstileToken({ secret: 'sec-123', token: 'invalid-token' });
    expect(valid).toBe(false);
  });

  it('fails safely (returns false) on network error or timeout', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Timeout / network failure'));

    const valid = await verifyTurnstileToken({ secret: 'sec-123', token: 'token' });
    expect(valid).toBe(false);
  });
});
