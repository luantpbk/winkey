import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { tokenStore } from '@/lib/auth/token-store';
import {
  HAS_SESSION_COOKIE,
  SESSION_PROBED_COOKIE,
  hasSessionIndicator,
  setSessionIndicator,
  clearSessionIndicator,
  hasSessionProbed,
  setSessionProbed,
  clearSessionProbed,
  shouldProbeSession,
} from '@/lib/auth/session-indicator';

function TestAuthConsumer() {
  const { user, isLoading, isAuthenticated, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="loading">{isLoading ? 'loading' : 'idle'}</span>
      <span data-testid="auth">{isAuthenticated ? 'authenticated' : 'anonymous'}</span>
      <span data-testid="user">{user?.email || 'none'}</span>
      <button
        onClick={() => login({ email: 'user@winkey.test', password: 'password123' })}
        data-testid="login-btn"
      >
        Login
      </button>
      <button onClick={() => logout()} data-testid="logout-btn">
        Logout
      </button>
    </div>
  );
}

describe('Issue #334: Session indicator & AuthProvider conditional refresh & one-time probe', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tokenStore.clear();
    clearSessionIndicator();
    clearSessionProbed();
    consoleErrorSpy = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    tokenStore.clear();
    clearSessionIndicator();
    clearSessionProbed();
  });

  describe('session-indicator helpers', () => {
    it('detects absence of session indicator and probed flag by default', () => {
      expect(hasSessionIndicator()).toBe(false);
      expect(hasSessionProbed()).toBe(false);
      expect(shouldProbeSession()).toBe(true);
    });

    it('sets and reads wk_has_session=1 cookie', () => {
      setSessionIndicator();
      expect(hasSessionIndicator()).toBe(true);
      expect(document.cookie).toContain(`${HAS_SESSION_COOKIE}=1`);
      expect(shouldProbeSession()).toBe(false);
    });

    it('sets and reads wk_session_probed=1 cookie', () => {
      setSessionProbed();
      expect(hasSessionProbed()).toBe(true);
      expect(document.cookie).toContain(`${SESSION_PROBED_COOKIE}=1`);
      expect(shouldProbeSession()).toBe(false);
    });

    it('clears session indicator and probed cookies', () => {
      setSessionIndicator();
      setSessionProbed();
      expect(hasSessionIndicator()).toBe(true);
      expect(hasSessionProbed()).toBe(true);

      clearSessionIndicator();
      clearSessionProbed();
      expect(hasSessionIndicator()).toBe(false);
      expect(hasSessionProbed()).toBe(false);
      expect(shouldProbeSession()).toBe(true);
    });
  });

  describe('AuthProvider mount & probe behavior', () => {
    it('pre-existing member prior to migration (no wk_has_session, no wk_session_probed): probes refresh once, succeeds (200), sets wk_has_session=1 and wk_session_probed=1 so user remains logged in', async () => {
      let refreshCalled = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/refresh')) {
            refreshCalled++;
            return new Response(
              JSON.stringify({
                access_token: 'migrated-member-token',
                token_type: 'Bearer',
                expires_in: 900,
                user: {
                  id: '018f0000-0000-7000-8000-000000000001',
                  email: 'migrated@winkey.test',
                  display_name: 'Migrated User',
                  handle: 'migrated_user',
                  roles: ['viewer'],
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          return new Response(null, { status: 404 });
        }),
      );

      expect(shouldProbeSession()).toBe(true);

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(refreshCalled).toBe(1);
      expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('migrated@winkey.test');
      expect(hasSessionIndicator()).toBe(true);
      expect(hasSessionProbed()).toBe(true);
      expect(shouldProbeSession()).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('unprobed guest (no wk_has_session, no wk_session_probed): probes refresh once, gets 401, sets wk_session_probed=1, leaves wk_has_session unset, and logs no error', async () => {
      let refreshCalled = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/refresh')) {
            refreshCalled++;
            return new Response(JSON.stringify({ detail: 'missing or expired refresh token' }), {
              status: 401,
            });
          }
          return new Response(null, { status: 404 });
        }),
      );

      expect(shouldProbeSession()).toBe(true);

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(refreshCalled).toBe(1);
      expect(screen.getByTestId('auth').textContent).toBe('anonymous');
      expect(screen.getByTestId('user').textContent).toBe('none');
      expect(hasSessionIndicator()).toBe(false);
      expect(hasSessionProbed()).toBe(true);
      expect(shouldProbeSession()).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('probed guest (wk_session_probed=1, no wk_has_session): does NOT call POST /v1/auth/refresh and immediately resolves as guest', async () => {
      setSessionProbed();
      expect(hasSessionProbed()).toBe(true);
      expect(hasSessionIndicator()).toBe(false);
      expect(shouldProbeSession()).toBe(false);

      let refreshCalled = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/refresh')) {
            refreshCalled++;
            return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
          }
          return new Response(null, { status: 404 });
        }),
      );

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(screen.getByTestId('auth').textContent).toBe('anonymous');
      expect(screen.getByTestId('user').textContent).toBe('none');
      expect(refreshCalled).toBe(0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('returning user (wk_has_session=1): calls POST /v1/auth/refresh and restores session', async () => {
      setSessionIndicator();
      let refreshCalled = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/refresh')) {
            refreshCalled++;
            return new Response(
              JSON.stringify({
                access_token: 'valid-restored-token',
                token_type: 'Bearer',
                expires_in: 900,
                user: {
                  id: '018f0000-0000-7000-8000-000000000001',
                  email: 'member@winkey.test',
                  display_name: 'Member Test',
                  handle: 'member_test',
                  roles: ['viewer'],
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          return new Response(null, { status: 404 });
        }),
      );

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(refreshCalled).toBe(1);
      expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('member@winkey.test');
      expect(hasSessionIndicator()).toBe(true);
      expect(hasSessionProbed()).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('expired session (401 on refresh): treats user as unauthenticated, clears wk_has_session cookie, sets wk_session_probed, and does NOT log at error level', async () => {
      setSessionIndicator();
      let refreshCalled = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/refresh')) {
            refreshCalled++;
            return new Response(
              JSON.stringify({
                type: 'https://winkey.vn/errors/unauthorized',
                title: 'Unauthorized',
                status: 401,
                detail: 'missing or expired refresh token',
                code: 'UNAUTHORIZED',
              }),
              {
                status: 401,
                headers: { 'Content-Type': 'application/problem+json' },
              },
            );
          }
          return new Response(null, { status: 404 });
        }),
      );

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(refreshCalled).toBe(1);
      expect(screen.getByTestId('auth').textContent).toBe('anonymous');
      expect(screen.getByTestId('user').textContent).toBe('none');
      // Cookie wk_has_session must be cleared after 401
      expect(hasSessionIndicator()).toBe(false);
      expect(hasSessionProbed()).toBe(true);
      // No console.error emitted
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('login and logout flows manage session indicator & probed state', () => {
    it('login sets wk_has_session and wk_session_probed; logout clears wk_has_session', async () => {
      setSessionProbed();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/login')) {
            return new Response(
              JSON.stringify({
                access_token: 'new-login-token',
                token_type: 'Bearer',
                expires_in: 900,
                user: {
                  id: '018f0000-0000-7000-8000-000000000002',
                  email: 'user@winkey.test',
                  display_name: 'Logged In User',
                  handle: 'logged_user',
                  roles: ['viewer'],
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          if (url.includes('/v1/auth/logout')) {
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 404 });
        }),
      );

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(hasSessionIndicator()).toBe(false);

      // Perform login
      await act(async () => {
        screen.getByTestId('login-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      });

      expect(screen.getByTestId('user').textContent).toBe('user@winkey.test');
      expect(hasSessionIndicator()).toBe(true);
      expect(hasSessionProbed()).toBe(true);

      // Perform logout
      await act(async () => {
        screen.getByTestId('logout-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth').textContent).toBe('anonymous');
      });

      expect(screen.getByTestId('user').textContent).toBe('none');
      expect(hasSessionIndicator()).toBe(false);
      expect(hasSessionProbed()).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('member persona flow: login -> page reload (token cleared in-memory, cookie preserved) -> automatically restores session on reload', async () => {
      setSessionProbed();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
          if (url.includes('/v1/auth/login')) {
            return new Response(
              JSON.stringify({
                access_token: 'login-token-123',
                token_type: 'Bearer',
                expires_in: 900,
                user: {
                  id: 'member-123',
                  email: 'member@winkey.test',
                  display_name: 'Member User',
                  handle: 'member_user',
                  roles: ['viewer'],
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.includes('/v1/auth/refresh')) {
            return new Response(
              JSON.stringify({
                access_token: 'refreshed-token-456',
                token_type: 'Bearer',
                expires_in: 900,
                user: {
                  id: 'member-123',
                  email: 'member@winkey.test',
                  display_name: 'Member User',
                  handle: 'member_user',
                  roles: ['viewer'],
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(null, { status: 404 });
        }),
      );

      const { unmount } = render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      // Login as member
      await act(async () => {
        screen.getByTestId('login-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      });
      expect(hasSessionIndicator()).toBe(true);
      expect(tokenStore.get()).toBe('login-token-123');

      // Simulate Page Reload (unmount, clear in-memory tokenStore, keep cookie)
      unmount();
      tokenStore.clear();
      expect(tokenStore.get()).toBeNull();
      expect(hasSessionIndicator()).toBe(true);

      // Render new page after reload
      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('loading').textContent).toBe('idle');
      });

      expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('member@winkey.test');
      expect(tokenStore.get()).toBe('refreshed-token-456');
    });
  });
});
