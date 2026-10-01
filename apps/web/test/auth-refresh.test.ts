import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken } from '@/lib/api-client';
import { tokenStore } from '@/lib/auth/token-store';

// POST /v1/auth/refresh has no request body (auth.v1.yaml). auth-svc (Fastify) answers 400
// FST_ERR_CTP_EMPTY_JSON_BODY when a request declares Content-Type: application/json with an empty body,
// which made every session restore fail in production.
describe('refreshAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it('posts with the cookie and without a JSON Content-Type, then stores the access token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at-1', expires_in: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).resolves.toBe('at-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/auth\/refresh$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(tokenStore.get()).toBe('at-1');
  });
});
