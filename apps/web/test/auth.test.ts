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
          return new Response(
            JSON.stringify({ title: 'Unauthorized', status: 401 }),
            { status: 401, headers: { 'Content-Type': 'application/problem+json' } }
          );
        }
        if (authHeader === 'Bearer fresh-reloaded-token') {
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
    expect(callCount).toBe(2);
    expect(refreshCount).toBe(1);
    expect(tokenStore.get()).toBe('fresh-reloaded-token');
  });

  it('coalesces 5 concurrent 401s into exactly 1 refresh call', async () => {
    let refreshCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const req = input instanceof Request ? input : new Request(input, init);

      if (url.includes('/v1/auth/refresh')) {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 25)); // simulate network latency
        return new Response(
          JSON.stringify({ access_token: 'coalesced-token', token_type: 'Bearer', expires_in: 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/v1/protected/endpoint')) {
        const auth = req.headers.get('Authorization');
        if (auth === 'Bearer coalesced-token') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ title: 'Unauthorized' }), { status: 401 });
      }

      return new Response(null, { status: 404 });
    });

    tokenStore.set('stale-token');

    // 5 concurrent requests hit 401 simultaneously
    const requests = Array.from({ length: 5 }, (_, i) =>
      customFetch(`http://localhost:3000/v1/protected/endpoint?i=${i}`).then((res) => res.json())
    );

    const results = await Promise.all(requests);

    expect(refreshCount).toBe(1);
    expect(results).toHaveLength(5);
    for (const res of results) {
      expect(res.ok).toBe(true);
    }
    expect(tokenStore.get()).toBe('coalesced-token');
  });

  it('serializes refreshes across multiple tabs using navigator.locks in sequence', async () => {
    let activeLocks = 0;
    let maxConcurrentLocks = 0;
    let refreshCount = 0;

    // Mock navigator.locks with a mutex queue
    let lockQueue = Promise.resolve();
    const mockLocks = {
      request: vi.fn((name: string, callback: () => Promise<any>) => {
        const next = lockQueue.then(async () => {
          activeLocks++;
          maxConcurrentLocks = Math.max(maxConcurrentLocks, activeLocks);
          try {
            return await callback();
          } finally {
            activeLocks--;
          }
        });
        lockQueue = next.catch(() => {});
        return next;
      }),
    };

    Object.defineProperty(navigator, 'locks', {
      value: mockLocks,
      configurable: true,
      writable: true,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      if (url.includes('/v1/auth/refresh')) {
        refreshCount++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({ access_token: `token-from-refresh-${refreshCount}`, token_type: 'Bearer', expires_in: 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    // Simulate Tab A and Tab B refreshing at the same moment
    const tabA = refreshAccessToken();
    const tabB = refreshAccessToken();

    const [tokenA, tokenB] = await Promise.all([tabA, tabB]);

    expect(mockLocks.request).toHaveBeenCalled();
    expect(maxConcurrentLocks).toBe(1); // Never > 1 concurrent lock held
    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
  });

  it('preserves request body on 401 retry for POST requests', async () => {
    tokenStore.set('expired-token');
    let capturedBodyOnRetry: any = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const req = input instanceof Request ? input : new Request(input, init);

      if (url.includes('/v1/auth/refresh')) {
        return new Response(
          JSON.stringify({ access_token: 'new-token', token_type: 'Bearer', expires_in: 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/v1/items')) {
        const auth = req.headers.get('Authorization');
        if (auth === 'Bearer expired-token') {
          return new Response(JSON.stringify({ title: 'Unauthorized' }), { status: 401 });
        }
        if (auth === 'Bearer new-token') {
          capturedBodyOnRetry = await req.json();
          return new Response(JSON.stringify({ created: true, data: capturedBodyOnRetry }), { status: 201 });
        }
      }

      return new Response(null, { status: 404 });
    });

    const response = await customFetch('http://localhost:3000/v1/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'Winkey Video', count: 42 }),
    });

    expect(response.status).toBe(201);
    expect(capturedBodyOnRetry).toEqual({ item: 'Winkey Video', count: 42 });
  });
});
