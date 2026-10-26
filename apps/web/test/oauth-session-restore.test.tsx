import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { tokenStore } from '@/lib/auth/token-store';
import {
  OAUTH_RETURN_PARAM,
  clearSessionIndicator,
  clearSessionProbed,
  consumeOAuthReturnMarker,
  hasSessionIndicator,
  setSessionProbed,
  withOAuthReturnMarker,
} from '@/lib/auth/session-indicator';

function Consumer() {
  const { isLoading, isAuthenticated } = useAuth();
  return (
    <div>
      <span data-testid="loading">{isLoading ? 'loading' : 'idle'}</span>
      <span data-testid="auth">{isAuthenticated ? 'authenticated' : 'anonymous'}</span>
    </div>
  );
}

function stubRefresh(status: number) {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      if (url.includes('/v1/auth/refresh')) {
        calls++;
        if (status !== 200) return new Response(null, { status });
        return new Response(
          JSON.stringify({
            access_token: 'google-token',
            token_type: 'Bearer',
            expires_in: 900,
            user: {
              id: '018f0000-0000-7000-8000-0000000000aa',
              email: 'google@winkey.test',
              display_name: 'Google User',
              handle: 'google_user',
              roles: ['viewer'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 404 });
    }),
  );
  return () => calls;
}

describe('Google sign-in return restores the session', () => {
  beforeEach(() => {
    tokenStore.clear();
    clearSessionIndicator();
    clearSessionProbed();
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('withOAuthReturnMarker keeps the path, query and hash', () => {
    expect(withOAuthReturnMarker('/')).toBe('/?wk_oauth=1');
    expect(withOAuthReturnMarker('/watch/x?playlist=y')).toBe('/watch/x?playlist=y&wk_oauth=1');
    expect(withOAuthReturnMarker('/a?b=1#c')).toBe('/a?b=1&wk_oauth=1#c');
  });

  it('a device that already probed refreshes after Google returns, and the marker leaves the URL', async () => {
    setSessionProbed(); // visited before, so no one-time probe and no wk_has_session
    window.history.replaceState(null, '', `/watch/x?playlist=y&${OAUTH_RETURN_PARAM}=1`);
    const refreshCalls = stubRefresh(200);

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('idle'));
    expect(refreshCalls()).toBe(1);
    expect(screen.getByTestId('auth').textContent).toBe('authenticated');
    expect(hasSessionIndicator()).toBe(true);
    expect(window.location.pathname + window.location.search).toBe('/watch/x?playlist=y');
  });

  it('without the marker that device stays anonymous and does not call refresh', async () => {
    setSessionProbed();
    const refreshCalls = stubRefresh(200);

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('idle'));
    expect(refreshCalls()).toBe(0);
    expect(screen.getByTestId('auth').textContent).toBe('anonymous');
  });

  it('a failed refresh after the marker leaves the user anonymous and clears the indicator', async () => {
    setSessionProbed();
    window.history.replaceState(null, '', `/?${OAUTH_RETURN_PARAM}=1`);
    stubRefresh(401);

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('idle'));
    expect(screen.getByTestId('auth').textContent).toBe('anonymous');
    expect(hasSessionIndicator()).toBe(false);
    expect(consumeOAuthReturnMarker()).toBe(false);
  });
});
