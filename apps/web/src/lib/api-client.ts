import { createWinkeyClient } from '@winkey/api-client';
import { tokenStore } from './auth/token-store';

export const getBaseUrl = (): string => {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return process.env.API_INTERNAL_URL || 'http://localhost:8080';
};

let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        tokenStore.set(data.access_token);
        return data.access_token;
      } else {
        tokenStore.clear();
        return null;
      }
    } catch {
      tokenStore.clear();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function refreshAccessToken(): Promise<string | null> {
  // Cross-tab synchronization via Web Locks API when available
  if (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.locks?.request
  ) {
    return navigator.locks.request('wk-refresh', async () => {
      return doRefresh();
    });
  }

  return doRefresh();
}

export const customFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);

  const token = tokenStore.get();
  if (token && !req.headers.has('Authorization')) {
    req.headers.set('Authorization', `Bearer ${token}`);
  }

  // Clone request before the first fetch so body can be reused if retry is needed after 401
  const reqForRetry = req.clone();
  const response = await fetch(req);

  const url = req.url;
  const isAuthRoute =
    url.includes('/v1/auth/refresh') ||
    url.includes('/v1/auth/login') ||
    url.includes('/v1/auth/register') ||
    url.includes('/v1/auth/logout');

  if (response.status === 401 && !isAuthRoute) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      reqForRetry.headers.set('Authorization', `Bearer ${newToken}`);
      return fetch(reqForRetry);
    }
  }

  return response;
};

export const api = createWinkeyClient({
  baseUrl: getBaseUrl(),
  fetch: customFetch,
  getAccessToken: () => tokenStore.get(),
});
