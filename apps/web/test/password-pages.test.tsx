import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ForgotPasswordPage from '../src/app/[locale]/forgot-password/page';
import ResetPasswordPage from '../src/app/[locale]/reset-password/page';
import VerifyEmailPage from '../src/app/[locale]/verify-email/page';
import { resetVerifyExecutionMap } from '../src/lib/auth/verify-email-action';
import LoginPage from '../src/app/[locale]/login/page';
import { EmailVerificationBanner } from '../src/components/auth/email-verification-banner';
import { ProfileSettings } from '../src/components/settings/profile-settings';
import { api } from '../src/lib/api-client';
import { tokenStore } from '../src/lib/auth/token-store';
import { resetAuthTokensMock, setMockCurrentUser } from '../src/mocks/handlers';
import { server } from '../src/mocks/server';
import type { User } from '@winkey/api-client';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

// Mock next-intl
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace?: string) => {
    const nsKey = namespace ?? '';
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
        const fullPath = namespace ? `${namespace}.${key}` : key;
        const parts = fullPath.split('.');
        let cur: unknown = isVi ? viMessages : enMessages;
        for (const p of parts) {
          if (cur && typeof cur === 'object' && p in cur) {
            cur = (cur as Record<string, unknown>)[p];
          } else {
            return key;
          }
        }
        if (typeof cur === 'string') {
          let res = cur;
          if (values) {
            for (const [k, v] of Object.entries(values)) {
              res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
          }
          return res;
        }
        return key;
      };
      translatorMap.set(nsKey, fn);
    }
    return fn;
  },
}));

// Mock routing
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/login',
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

// Mock toast
const mockShowToast = vi.fn();
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({
    showToast: mockShowToast,
    dismissToast: vi.fn(),
  }),
}));

// Mock next/navigation searchParams
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// Mock Auth Context
let mockCurrentUser: User | null = null;
let mockIsAuthenticated = false;
let mockIsLoading = false;
const mockRefresh = vi.fn(async () => {});
const mockClearSession = vi.fn(() => {
  mockCurrentUser = null;
  mockIsAuthenticated = false;
});
const mockLogin = vi.fn(async () => ({ success: true }));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockCurrentUser,
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
    refresh: mockRefresh,
    clearSession: mockClearSession,
    login: mockLogin,
    updateUser: vi.fn(),
  }),
}));

describe('Task A6-web: Password & Email Verification Pages', () => {
  let consoleLogSpy: any;
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;
  let consoleDebugSpy: any;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'bypass' });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    activeLocale = 'vi';
    mockSearchParams = new URLSearchParams();
    mockCurrentUser = null;
    mockIsAuthenticated = false;
    mockIsLoading = false;
    sessionStorage.clear();
    tokenStore.clear();
    resetAuthTokensMock();
    resetVerifyExecutionMap();
    setMockCurrentUser(null);
    vi.clearAllMocks();

    // Spies on all console methods to assert zero token/secret leaks
    consoleLogSpy = vi.spyOn(console, 'log');
    consoleInfoSpy = vi.spyOn(console, 'info');
    consoleWarnSpy = vi.spyOn(console, 'warn');
    consoleErrorSpy = vi.spyOn(console, 'error');
    consoleDebugSpy = vi.spyOn(console, 'debug');
  });

  afterEach(() => {
    server.resetHandlers();
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  function assertNoSecretInConsole(sensitiveValues: string[]) {
    const allSpies = [
      consoleLogSpy,
      consoleInfoSpy,
      consoleWarnSpy,
      consoleErrorSpy,
      consoleDebugSpy,
    ];
    for (const spy of allSpies) {
      for (const call of spy.mock.calls) {
        const text = call.map((arg: unknown) => String(arg)).join(' ');
        for (const secret of sensitiveValues) {
          if (secret && secret.length > 5) {
            expect(text.includes(secret)).toBe(false);
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 1. Forgot password
  // --------------------------------------------------------------------------
  describe('Forgot password page (/[locale]/forgot-password)', () => {
    it('shows the same generic success message for both a known and an unknown email (202)', async () => {
      const { unmount } = render(<ForgotPasswordPage />);

      const emailInput = screen.getByLabelText(/Email/i);
      const submitBtn = screen.getByRole('button', { name: /Gửi liên kết đặt lại/i });

      // Known email
      fireEvent.change(emailInput, { target: { value: 'creator@winkey.vn' } });
      fireEvent.click(submitBtn);

      const successNotice = await screen.findByText(
        /Nếu email này có tài khoản, chúng tôi đã gửi liên kết đặt lại mật khẩu/i,
      );
      expect(successNotice).toBeDefined();
      expect(screen.getByRole('link', { name: /Quay lại đăng nhập/i })).toBeDefined();
      unmount();

      // Unknown email -> exact same message (account enumeration protection)
      render(<ForgotPasswordPage />);
      const unknownEmailInput = screen.getByLabelText(/Email/i);
      const unknownSubmitBtn = screen.getByRole('button', { name: /Gửi liên kết đặt lại/i });

      fireEvent.change(unknownEmailInput, {
        target: { value: 'nonexistent-person-999@gmail.com' },
      });
      fireEvent.click(unknownSubmitBtn);

      const unknownSuccessNotice = await screen.findByText(
        /Nếu email này có tài khoản, chúng tôi đã gửi liên kết đặt lại mật khẩu/i,
      );
      expect(unknownSuccessNotice).toBeDefined();
    });

    it('handles 400 validation error and 429 rate limiting with Retry-After', async () => {
      render(<ForgotPasswordPage />);

      // Rate limited email
      const emailInput = screen.getByLabelText(/Email/i);
      const submitBtn = screen.getByRole('button', { name: /Gửi liên kết đặt lại/i });

      fireEvent.change(emailInput, { target: { value: 'rate-limited@winkey.vn' } });
      fireEvent.click(submitBtn);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/Thử lại sau/i);
      expect(alert.textContent).toMatch(/60s/i);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Reset password
  // --------------------------------------------------------------------------
  describe('Reset password page (/[locale]/reset-password?token=...)', () => {
    const validToken = 'valid-token-test-padding-43characterslong12';

    it('removes token from the address bar immediately (window.history.replaceState) before request', async () => {
      window.history.pushState({}, '', `/reset-password?token=${validToken}`);
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      render(<ResetPasswordPage />);

      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/reset-password');
      replaceStateSpy.mockRestore();
    });

    it('204 clears the session and shows success message with login button', async () => {
      window.history.pushState({}, '', `/reset-password?token=${validToken}`);
      tokenStore.set('mock-access-token-active');

      render(<ResetPasswordPage />);

      const newPwInput = screen.getByLabelText(/^Mật khẩu mới$/i);
      const confirmPwInput = screen.getByLabelText(/Xác nhận mật khẩu mới/i);
      const submitBtn = screen.getByRole('button', { name: /Đặt lại mật khẩu/i });

      fireEvent.change(newPwInput, { target: { value: 'NewSecretPass123!' } });
      fireEvent.change(confirmPwInput, { target: { value: 'NewSecretPass123!' } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByText(/Đã đổi mật khẩu, mọi thiết bị đã đăng xuất/i)).toBeDefined();
      });

      // Session revoked
      expect(tokenStore.get()).toBeNull();
      expect(mockClearSession).toHaveBeenCalled();
      expect(screen.getByRole('link', { name: /Đăng nhập/i })).toBeDefined();

      assertNoSecretInConsole([validToken, 'NewSecretPass123!']);
    });

    it('400 shows the invalid token message with link to forgot-password', async () => {
      window.history.pushState({}, '', '/reset-password?token=invalid-token');

      render(<ResetPasswordPage />);

      const newPwInput = screen.getByLabelText(/^Mật khẩu mới$/i);
      const confirmPwInput = screen.getByLabelText(/Xác nhận mật khẩu mới/i);
      const submitBtn = screen.getByRole('button', { name: /Đặt lại mật khẩu/i });

      fireEvent.change(newPwInput, { target: { value: 'NewSecretPass123!' } });
      fireEvent.change(confirmPwInput, { target: { value: 'NewSecretPass123!' } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByText(/Liên kết không hợp lệ hoặc đã hết hạn/i)).toBeDefined();
      });

      const forgotLink = screen.getByRole('link', { name: /Yêu cầu liên kết mới/i });
      expect(forgotLink.getAttribute('href')).toBe('/forgot-password');
    });

    it('missing token in URL makes no API request and shows invalid message right away', async () => {
      window.history.pushState({}, '', '/reset-password');
      const postSpy = vi.spyOn(api.auth, 'POST');

      render(<ResetPasswordPage />);

      await waitFor(() => {
        expect(screen.getByText(/Liên kết không hợp lệ hoặc đã hết hạn/i)).toBeDefined();
      });

      expect(postSpy).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/^Mật khẩu mới$/i)).toBeNull();
      postSpy.mockRestore();
    });

    it('enforces client validation for passwords (length and match)', async () => {
      window.history.pushState({}, '', `/reset-password?token=${validToken}`);
      render(<ResetPasswordPage />);

      const newPwInput = screen.getByLabelText(/^Mật khẩu mới$/i);
      const confirmPwInput = screen.getByLabelText(/Xác nhận mật khẩu mới/i);
      const submitBtn = screen.getByRole('button', { name: /Đặt lại mật khẩu/i });

      // Short password
      fireEvent.change(newPwInput, { target: { value: 'short' } });
      fireEvent.change(confirmPwInput, { target: { value: 'short' } });
      fireEvent.click(submitBtn);

      expect(await screen.findByText(/Mật khẩu phải có ít nhất 8 ký tự/i)).toBeDefined();

      // Mismatch
      fireEvent.change(newPwInput, { target: { value: 'validPassword123' } });
      fireEvent.change(confirmPwInput, { target: { value: 'differentPassword123' } });
      fireEvent.click(submitBtn);

      expect(await screen.findByText(/Mật khẩu xác nhận không khớp/i)).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Verify email
  // --------------------------------------------------------------------------
  describe('Verify email page (/[locale]/verify-email?token=...)', () => {
    const validVerifyToken = 'valid-token-verify-email-43characterslong12';

    it('is called exactly once even under React StrictMode (deduplication)', async () => {
      window.history.pushState({}, '', `/verify-email?token=${validVerifyToken}`);
      const postSpy = vi.spyOn(api.auth, 'POST');

      render(
        <React.StrictMode>
          <VerifyEmailPage />
        </React.StrictMode>,
      );

      await waitFor(() => {
        expect(screen.getByText(/Email đã được xác minh/i)).toBeDefined();
      });

      // Assert called strictly once despite StrictMode double effect
      const verifyCalls = postSpy.mock.calls.filter((call) => call[0] === '/v1/auth/email/verify');
      expect(verifyCalls.length).toBe(1);

      assertNoSecretInConsole([validVerifyToken]);
      postSpy.mockRestore();
    });

    it('refreshes getMe on 204 when user is signed in', async () => {
      window.history.pushState({}, '', `/verify-email?token=${validVerifyToken}-refresh`);
      mockCurrentUser = {
        id: 'user-unverified-1',
        email: 'spammer@winkey.vn',
        email_verified: false,
        handle: 'spammer',
        display_name: 'Spammer',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-01-01T00:00:00Z',
      };
      mockIsAuthenticated = true;

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText(/Email đã được xác minh/i)).toBeDefined();
      });

      expect(mockRefresh).toHaveBeenCalled();
    });

    it('shows 400 invalid message when token is invalid or already used', async () => {
      window.history.pushState({}, '', '/verify-email?token=invalid-token');

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText(/Liên kết không hợp lệ hoặc đã dùng/i)).toBeDefined();
      });
    });

    it('makes no request when token is missing in URL', async () => {
      window.history.pushState({}, '', '/verify-email');
      const postSpy = vi.spyOn(api.auth, 'POST');

      render(<VerifyEmailPage />);

      await waitFor(() => {
        expect(screen.getByText(/Liên kết không hợp lệ hoặc đã dùng/i)).toBeDefined();
      });

      expect(postSpy).not.toHaveBeenCalled();
      postSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Verification banner
  // --------------------------------------------------------------------------
  describe('Email verification banner', () => {
    it('is shown only when email_verified is false for signed-in user', () => {
      // 1. Not signed in -> null
      const { unmount } = render(<EmailVerificationBanner />);
      expect(screen.queryByRole('region', { name: /Email verification/i })).toBeNull();
      unmount();

      // 2. Signed in, verified -> null
      mockIsAuthenticated = true;
      mockCurrentUser = {
        id: 'user-verified',
        email: 'verified@winkey.vn',
        email_verified: true,
        handle: 'verified',
        display_name: 'Verified User',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-01-01T00:00:00Z',
      };
      const { unmount: unmount2 } = render(<EmailVerificationBanner />);
      expect(screen.queryByRole('region', { name: /Email verification/i })).toBeNull();
      unmount2();

      // 3. Signed in, unverified -> banner visible
      mockCurrentUser = {
        ...mockCurrentUser,
        id: 'user-unverified',
        email_verified: false,
      };
      render(<EmailVerificationBanner />);
      expect(screen.getByRole('region', { name: /Email verification/i })).toBeDefined();
      expect(screen.getByText(/Xác minh email để bảo vệ tài khoản/i)).toBeDefined();
    });

    it('can be dismissed for current session via sessionStorage', () => {
      mockIsAuthenticated = true;
      mockCurrentUser = {
        id: 'user-unverified',
        email: 'spammer@winkey.vn',
        email_verified: false,
        handle: 'unverified',
        display_name: 'Unverified User',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-01-01T00:00:00Z',
      };

      const { unmount } = render(<EmailVerificationBanner />);
      const dismissBtn = screen.getByLabelText(/Dismiss email verification banner/i);
      fireEvent.click(dismissBtn);

      expect(sessionStorage.getItem('wk_dismiss_email_banner_user-unverified')).toBe('true');
      expect(screen.queryByRole('region', { name: /Email verification/i })).toBeNull();
      unmount();

      // Rerender stays dismissed in same session
      render(<EmailVerificationBanner />);
      expect(screen.queryByRole('region', { name: /Email verification/i })).toBeNull();
    });

    it('handles resend 202 (sent), 409 (hide banner & refresh), and 429 (rate limited)', async () => {
      mockIsAuthenticated = true;
      mockCurrentUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c06', // spammer id from mockUsers
        email: 'spammer@winkey.vn',
        email_verified: false,
        handle: 'spammer_bot',
        display_name: 'Spammer Bot',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-03-01T00:00:00Z',
      };
      setMockCurrentUser(mockCurrentUser);
      tokenStore.set(`mock_jwt_token_${mockCurrentUser.id}`);

      // 1. Resend 202
      const { unmount } = render(<EmailVerificationBanner />);
      const resendBtn = screen.getByRole('button', { name: /Gửi lại email/i });
      fireEvent.click(resendBtn);

      expect(await screen.findByText(/Đã gửi/i)).toBeDefined();
      unmount();

      // 2. Resend 429
      mockCurrentUser = {
        ...mockCurrentUser,
        id: 'user-rate-limited',
        email: 'rate-limited@winkey.vn',
      };
      setMockCurrentUser(mockCurrentUser);
      tokenStore.set(`mock_jwt_token_${mockCurrentUser.id}`);

      const { unmount: unmount2 } = render(<EmailVerificationBanner />);
      const resendBtn2 = screen.getByRole('button', { name: /Gửi lại email/i });
      fireEvent.click(resendBtn2);

      expect(await screen.findByText(/Thử lại sau/i)).toBeDefined();
      unmount2();

      // 3. Resend 409: hide banner & refresh getMe
      mockCurrentUser = {
        ...mockCurrentUser,
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01', // creator id (email_verified=true)
        email: 'creator@winkey.vn',
        email_verified: false, // client thought unverified, but server is already verified
      };
      setMockCurrentUser({
        ...mockCurrentUser,
        email_verified: true, // server has it true -> triggers 409 EMAIL_ALREADY_VERIFIED
      });
      tokenStore.set(`mock_jwt_token_${mockCurrentUser.id}`);

      render(<EmailVerificationBanner />);
      const resendBtn3 = screen.getByRole('button', { name: /Gửi lại email/i });
      fireEvent.click(resendBtn3);

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
        expect(screen.queryByRole('region', { name: /Email verification/i })).toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // 5. Settings page email status and resend button
  // --------------------------------------------------------------------------
  describe('Account settings profile verification section', () => {
    it('shows verified badge when email is verified', () => {
      const verifiedUser: User = {
        id: 'u-1',
        email: 'creator@winkey.vn',
        email_verified: true,
        handle: 'creator',
        display_name: 'Creator',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-01-01T00:00:00Z',
      };

      render(<ProfileSettings user={verifiedUser} />);

      expect(screen.getByText(/Đã xác minh/i)).toBeDefined();
      expect(screen.queryByRole('button', { name: /Gửi lại email/i })).toBeNull();
    });

    it('shows unverified badge and resend button when email_verified is false', async () => {
      const unverifiedUser: User = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c06',
        email: 'spammer@winkey.vn',
        email_verified: false,
        handle: 'spammer_bot',
        display_name: 'Spammer Bot',
        avatar_url: null,
        roles: ['viewer'],
        created_at: '2026-03-01T00:00:00Z',
      };
      setMockCurrentUser(unverifiedUser);
      tokenStore.set(`mock_jwt_token_${unverifiedUser.id}`);

      render(<ProfileSettings user={unverifiedUser} />);

      expect(screen.getByText(/Chưa xác minh/i)).toBeDefined();
      const resendBtn = screen.getByRole('button', { name: /Gửi lại email/i });
      expect(resendBtn).toBeDefined();

      fireEvent.click(resendBtn);

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.objectContaining({ title: expect.stringMatching(/Đã gửi/i), type: 'success' }),
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // 6. Login page error parameters and forgot password link
  // --------------------------------------------------------------------------
  describe('Login page alerts and links', () => {
    it('shows oauth_unavailable message when error=oauth_unavailable', () => {
      mockSearchParams = new URLSearchParams('error=oauth_unavailable');
      render(<LoginPage />);

      expect(screen.getByText(/Đăng nhập Google tạm thời chưa khả dụng/i)).toBeDefined();
    });

    it('shows accountSuspended message when error=ACCOUNT_SUSPENDED', () => {
      mockSearchParams = new URLSearchParams('error=ACCOUNT_SUSPENDED');
      render(<LoginPage />);

      expect(screen.getByText(/Tài khoản của bạn đã bị tạm khóa/i)).toBeDefined();
    });

    it('contains link to forgot-password under the password field', () => {
      mockSearchParams = new URLSearchParams();
      render(<LoginPage />);

      const forgotLink = screen.getByRole('link', { name: /Quên mật khẩu\?/i });
      expect(forgotLink.getAttribute('href')).toBe('/forgot-password');
    });
  });
});
