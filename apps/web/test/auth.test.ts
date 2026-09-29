import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tokenStore } from '../src/lib/auth/token-store';
import { customFetch, refreshAccessToken } from '../src/lib/api-client';

describe('Auth Session Management & In-Memory Token Store', () => {
  beforeEach(() => {
    tokenStore.clear();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps access token strictly in memory and does not touch localStorage/sessionStorage', () => {
    tokenStore.set('super-secret-access-token');

    expect(tokenStore.get()).toBe('super-secret-access-token');
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(sessionStorage.getItem('access_token')).toBeNull();

    tokenStore.clear();
    expect(tokenStore.get()).toBeNull();
  });

  it('subscribes to token changes', () => {
    const listener = vi.fn();
    const unsubscribe = tokenStore.subscribe(listener);

    tokenStore.set('token-1');
    expect(listener).toHaveBeenCalledWith('token-1');

    tokenStore.clear();
    expect(listener).toHaveBeenCalledWith(null);

    unsubscribe();
    tokenStore.set('token-2');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('handles 401: automatically performs silent refresh once and replays original request', async () => {
    let callCount = 0;
    let refreshCount = 0;
    tokenStore.set('expired-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const req = input instanceof Request ? input : new Request(input, init);

      if (url.includes('/v1/auth/refresh')) {
        refreshCount++;
        return new Response(
          JSON.stringify({
            access_token: 'fresh-reloaded-token',
            token_type: 'Bearer',
            expires_in: 900,
            user: { id: 'user-1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/v1/protected/data')) {
        callCount++;
        const authHeader = req.headers.get('Authorization');
        if (authHeader === 'Bearer expired-token') {
          // First attempt fails with 401
          return new Response(
            JSON.stringify({ title: 'Unauthorized', status: 401 }),
            { status: 401, headers: { 'Content-Type': 'application/problem+json' } }
          );
        }
        if (authHeader === 'Bearer fresh-reloaded-token') {
          // Replayed attempt succeeds with 200
          return new Response(
            JSON.stringify({ message: 'Success after token refresh!' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      return new Response(null, { status: 404 });
    });

    const response = await customFetch('http://localhost:3000/v1/protected/data');
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toBe('Success after token refresh!');
    expect(callCount).toBe(2); // First failed + replayed
    expect(refreshCount).toBe(1);
    expect(tokenStore.get()).toBe('fresh-reloaded-token');
  });

  it('coalesces multiple simultaneous 401s into a single refresh call', async () => {
    let refreshCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      if (url.includes('/v1/auth/refresh')) {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 20)); // latency
        return new Response(
          JSON.stringify({ access_token: 'coalesced-token', token_type: 'Bearer', expires_in: 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 401 });
    });

    const [t1, t2, t3] = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);

    expect(refreshCount).toBe(1);
    expect(t1).toBe('coalesced-token');
    expect(t2).toBe('coalesced-token');
    expect(t3).toBe('coalesced-token');
    expect(tokenStore.get()).toBe('coalesced-token');
  });
});
