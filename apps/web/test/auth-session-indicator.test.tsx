import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { tokenStore } from '@/lib/auth/token-store';
import {
  HAS_SESSION_COOKIE,
  hasSessionIndicator,
  setSessionIndicator,
  clearSessionIndicator,
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

describe('Issue #334: Session indicator & AuthProvider conditional refresh', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tokenStore.clear();
    clearSessionIndicator();
    consoleErrorSpy = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    tokenStore.clear();
    clearSessionIndicator();
  });

  describe('session-indicator helpers', () => {
    it('detects absence of session indicator by default', () => {
      expect(hasSessionIndicator()).toBe(false);
    });

    it('sets and reads wk_has_session=1 cookie', () => {
      setSessionIndicator();
      expect(hasSessionIndicator()).toBe(true);
      expect(document.cookie).toContain(`${HAS_SESSION_COOKIE}=1`);
    });

    it('clears session indicator cookie', () => {
      setSessionIndicator();
      expect(hasSessionIndicator()).toBe(true);
      clearSessionIndicator();
      expect(hasSessionIndicator()).toBe(false);
    });
  });

  describe('AuthProvider mount behavior', () => {
    it('anonymous viewer: does NOT call POST /v1/auth/refresh when no session indicator exists', async () => {
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

    it('returning user: calls POST /v1/auth/refresh and restores session when wk_has_session=1 is present', async () => {
      setSessionIndicator();
      let refreshCalled = 0;
      let meCalled = 0;

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
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          if (url.includes('/v1/auth/me')) {
            meCalled++;
            return new Response(
              JSON.stringify({
                id: '018f0000-0000-7000-8000-000000000001',
                email: 'member@winkey.test',
                display_name: 'Member Test',
                handle: 'member_test',
                roles: ['viewer'],
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
      expect(meCalled).toBe(1);
      expect(screen.getByTestId('auth').textContent).toBe('authenticated');
      expect(screen.getByTestId('user').textContent).toBe('member@winkey.test');
      expect(hasSessionIndicator()).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('expired session (401 on refresh): treats user as unauthenticated, clears wk_has_session cookie, and does NOT log at error level', async () => {
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
      // Cookie must be cleared after 401
      expect(hasSessionIndicator()).toBe(false);
      // No console.error emitted
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('login and logout flows manage session indicator', () => {
    it('login sets wk_has_session cookie and logout clears it', async () => {
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

      // Perform logout
      await act(async () => {
        screen.getByTestId('logout-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth').textContent).toBe('anonymous');
      });

      expect(screen.getByTestId('user').textContent).toBe('none');
      expect(hasSessionIndicator()).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('member persona flow: login -> page reload (token cleared in-memory, cookie preserved) -> automatically restores session on reload', async () => {
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
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.includes('/v1/auth/me')) {
            return new Response(
              JSON.stringify({
                id: 'member-123',
                email: 'member@winkey.test',
                display_name: 'Member User',
                handle: 'member_user',
                roles: ['viewer'],
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
