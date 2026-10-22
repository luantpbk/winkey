import { createWinkeyClient, type User } from '@winkey/api-client';
import { tokenStore } from './auth/token-store';
import {
  setSessionIndicator,
  clearSessionIndicator,
  setSessionProbed,
} from './auth/session-indicator';

export const getBaseUrl = (): string => {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return process.env.API_INTERNAL_URL || 'http://localhost:8080';
};

export interface RefreshResult {
  token: string | null;
  user?: User | null;
}

let refreshPromise: Promise<RefreshResult> | null = null;

async function doRefresh(): Promise<RefreshResult> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
        // No body, so no Content-Type: auth-svc (Fastify) rejects an empty body declared as JSON with 400.
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        tokenStore.set(data.access_token);
        setSessionIndicator();
        setSessionProbed();
        return {
          token: data.access_token,
          user: (data.user as User) || null,
        };
      } else {
        tokenStore.clear();
        if (res.status === 401) {
          clearSessionIndicator();
          setSessionProbed();
        }
        return { token: null, user: null };
      }
    } catch {
      tokenStore.clear();
      return { token: null, user: null };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function refreshSession(): Promise<RefreshResult> {
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

export async function refreshAccessToken(): Promise<string | null> {
  const result = await refreshSession();
  return result.token;
}

export const customFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);

  const url = req.url;
  const isRelatedVideos = /\/v1\/videos\/[^/]+\/related(\?.*)?$/.test(url);

  if (isRelatedVideos) {
    req.headers.delete('Authorization');
  }

  const token = tokenStore.get();
  if (!isRelatedVideos && token && !req.headers.has('Authorization')) {
    req.headers.set('Authorization', `Bearer ${token}`);
  }

  // Clone request before the first fetch so body can be reused if retry is needed after 401
  const reqForRetry = req.clone();
  const response = await fetch(req);

  const isAuthRoute =
    url.includes('/v1/auth/refresh') ||
    url.includes('/v1/auth/login') ||
    url.includes('/v1/auth/register') ||
    url.includes('/v1/auth/logout');

  if (response.status === 401 && !isAuthRoute && !isRelatedVideos) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      reqForRetry.headers.set('Authorization', `Bearer ${newToken}`);
      return fetch(reqForRetry);
    }
  }

  // Handle 403 CREATOR_ROLE_REQUIRED (task ROLE1, ADR-046: stale token)
  if (response.status === 403 && !isAuthRoute) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.code === 'CREATOR_ROLE_REQUIRED') {
        const { token: newToken, user } = await refreshSession();
        if (newToken && user?.roles?.includes('creator')) {
          reqForRetry.headers.set('Authorization', `Bearer ${newToken}`);
          return fetch(reqForRetry);
        }
        if (typeof window !== 'undefined' && !window.location.pathname.includes('/nang-cap')) {
          window.location.href = '/nang-cap';
        }
      }
    } catch {
      // Body not JSON or parsing failed; proceed with original response
    }
  }

  return response;
};

export const api = createWinkeyClient({
  baseUrl: getBaseUrl(),
  fetch: customFetch,
  getAccessToken: () => tokenStore.get(),
});
