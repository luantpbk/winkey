import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import VerifyEmailPage from '../src/app/[locale]/verify-email/page';
import { AuthProvider } from '../src/lib/auth/auth-context';
import { resetVerifyExecutionMap } from '../src/lib/auth/verify-email-action';
import { tokenStore } from '../src/lib/auth/token-store';
import { server } from '../src/mocks/server';
import { http, HttpResponse } from 'msw';
import { mockUsers } from '../src/mocks/fixtures';
import viMessages from '../messages/vi.json';

// Mock next-intl
vi.mock('next-intl', () => ({
  useLocale: () => 'vi',
  useTranslations: (namespace?: string) => {
    return (key: string) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = viMessages;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return key;
        }
      }
      return typeof cur === 'string' ? cur : key;
    };
  },
}));

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/verify-email',
  Link: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

describe('Task A6-web: /verify-email infinite refresh loop prevention with real AuthProvider', () => {
  beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
  afterEach(() => {
    server.resetHandlers();
    tokenStore.clear();
    resetVerifyExecutionMap();
  });
  afterAll(() => server.close());

  it('calls /v1/auth/refresh at most once after verify and /v1/auth/email/verify exactly once over 1s', async () => {
    let verifyCallCount = 0;
    let refreshCallsAfterVerify = 0;

    const loggedInUser = {
      ...mockUsers.creator,
      email_verified: false,
    };

    server.use(
      http.post('*/v1/auth/refresh', async () => {
        if (verifyCallCount > 0) {
          refreshCallsAfterVerify++;
        }
        return HttpResponse.json({
          access_token: `mock-access-${loggedInUser.id}`,
          token_type: 'Bearer',
          expires_in: 900,
          user: { ...loggedInUser, email_verified: true },
        });
      }),
      http.get('*/v1/auth/me', async () => {
        return HttpResponse.json({
          ...loggedInUser,
          email_verified: verifyCallCount > 0,
        });
      }),
      http.post('*/v1/auth/email/verify', async () => {
        verifyCallCount++;
        return new HttpResponse(null, {
          status: 204,
          headers: { 'Content-Length': '0' },
        });
      }),
    );

    // User is signed in with access token
    tokenStore.set('mock-initial-access-token');
    window.history.pushState({}, '', '/verify-email?token=valid-token-infinite-loop-check');

    render(
      <AuthProvider>
        <VerifyEmailPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Email đã được xác minh/i)).toBeDefined();
    });

    // Wait 1 second to observe whether an infinite loop triggers continuous refresh calls
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(verifyCallCount).toBe(1);
    expect(refreshCallsAfterVerify).toBeLessThanOrEqual(1);
  }, 10000);
});
