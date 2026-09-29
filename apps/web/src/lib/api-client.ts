import { createWinkeyClient } from '@winkey/api-client';
import { tokenStore } from './auth/token-store';

export const getBaseUrl = (): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost:3000';
};

let isRefreshing = false;
let refreshQueue: Array<(token: string | null) => void> = [];

export async function refreshAccessToken(): Promise<string | null> {
  if (isRefreshing) {
    return new Promise((resolve) => {
      refreshQueue.push((token) => resolve(token));
    });
  }

  isRefreshing = true;
  try {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      tokenStore.set(data.access_token);
      for (const cb of refreshQueue) cb(data.access_token);
      refreshQueue = [];
      return data.access_token;
    } else {
      tokenStore.clear();
      for (const cb of refreshQueue) cb(null);
      refreshQueue = [];
      return null;
    }
  } catch {
    tokenStore.clear();
    for (const cb of refreshQueue) cb(null);
    refreshQueue = [];
    return null;
  } finally {
    isRefreshing = false;
  }
}

export const customFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);

  const token = tokenStore.get();
  if (token && !req.headers.has('Authorization')) {
    req.headers.set('Authorization', `Bearer ${token}`);
  }

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
      const retryHeaders = new Headers(req.headers);
      retryHeaders.set('Authorization', `Bearer ${newToken}`);
      return fetch(req.url, {
        method: req.method,
        headers: retryHeaders,
      });
    }
  }

  return response;
};

export const api = createWinkeyClient({
  baseUrl: getBaseUrl(),
  fetch: customFetch,
  getAccessToken: () => tokenStore.get(),
});
