import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from '../src/app/[locale]/login/page';
import TwoFactorLoginPage from '../src/app/[locale]/login/2fa/page';
import SecuritySettingsPage from '../src/app/[locale]/cai-dat/bao-mat/page';
import ReportSessionPage from '../src/app/[locale]/bao-cao-dang-nhap/page';
import { StaffMfaBanner } from '../src/components/auth/staff-mfa-banner';
import { StepUpDialog } from '../src/components/auth/step-up-dialog';
import { AuthProvider } from '../src/lib/auth/auth-context';
import { setPendingMfaChallenge, clearPendingMfaChallenge } from '../src/lib/auth/mfa-state';
import { setMockRequireStepUp, resetMockSecurityState } from '../src/mocks/handlers';
import { server } from '../src/mocks/server';
import viMessages from '../messages/vi.json';

// Mock routing
const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
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

// Mock next-intl
vi.mock('next-intl', () => ({
  useLocale: () => 'vi',
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
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
  },
}));

// Mock searchParams
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

describe('SOC-1a Account Security UI Tests', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'bypass' });
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    clearPendingMfaChallenge();
    resetMockSecurityState();
  });

  describe('1. MFA Sign-in Flow (/login & /login/2fa)', () => {
    it('redirects to /login/2fa when login returns MfaChallenge', async () => {
      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>,
      );

      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: 'mfa@winkey.vn' },
      });
      fireEvent.change(screen.getByLabelText(/mật khẩu/i), {
        target: { value: 'password123' },
      });

      fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/login/2fa'));
      });
    });

    it('completes MFA sign-in with 6-digit TOTP code', async () => {
      setPendingMfaChallenge({
        mfa_required: true,
        mfa_token: 'valid-mfa-token',
        methods: ['totp', 'recovery_code'],
        expires_in: 300,
      });

      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      const codeInput = screen.getByLabelText(/mã xác thực/i);
      fireEvent.change(codeInput, { target: { value: '123456' } });

      const submitBtn = screen.getByRole('button', { name: /xác nhận/i }) as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(false);
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });

    it('handles invalid MFA code inline', async () => {
      setPendingMfaChallenge({
        mfa_required: true,
        mfa_token: 'valid-mfa-token',
        methods: ['totp'],
        expires_in: 300,
      });

      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      const codeInput = screen.getByLabelText(/mã xác thực/i);
      fireEvent.change(codeInput, { target: { value: '999999' } });
      fireEvent.click(screen.getByRole('button', { name: /xác nhận/i }));

      await waitFor(() => {
        expect(screen.getByText(/không đúng hoặc đã hết hạn/i)).toBeDefined();
      });
    });

    it('switches to recovery code input and submits', async () => {
      setPendingMfaChallenge({
        mfa_required: true,
        mfa_token: 'valid-mfa-token',
        methods: ['totp', 'recovery_code'],
        expires_in: 300,
      });

      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      const switchBtn = screen.getByRole('button', { name: /dùng mã khôi phục/i });
      fireEvent.click(switchBtn);

      const recoveryInput = screen.getByLabelText(/mã khôi phục/i);
      fireEvent.change(recoveryInput, { target: { value: '1a2b-3c4d' } });

      fireEvent.click(screen.getByRole('button', { name: /xác nhận/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });

    it('redirects to /login?error=session_expired if no pending challenge and no cookie', async () => {
      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith('/login?error=session_expired');
      });
    });

    it('redirects to /login?error=mfa_token_invalid if token is rejected', async () => {
      setPendingMfaChallenge({
        mfa_required: true,
        mfa_token: 'invalid-token',
        methods: ['totp'],
        expires_in: 300,
      });

      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      fireEvent.change(screen.getByLabelText(/mã xác thực/i), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: /xác nhận/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?error=mfa_token_invalid');
      });
    });

    it('signs in with passkey when navigator.credentials.get succeeds', async () => {
      const mockCred = {
        id: 'test-cred-id',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        toJSON: () => ({
          id: 'test-cred-id',
          rawId: 'AQID',
          type: 'public-key',
          response: {
            clientDataJSON: 'AQI',
            authenticatorData: 'AwQ',
            signature: 'BQY',
          },
        }),
        response: {
          clientDataJSON: new Uint8Array([1, 2]).buffer,
          authenticatorData: new Uint8Array([3, 4]).buffer,
          signature: new Uint8Array([5, 6]).buffer,
        },
      };

      (window as any).PublicKeyCredential = class {};
      Object.defineProperty(navigator, 'credentials', {
        value: {
          get: vi.fn().mockResolvedValue(mockCred),
          create: vi.fn(),
        },
        configurable: true,
      });

      setPendingMfaChallenge({
        mfa_required: true,
        mfa_token: 'valid-mfa-token',
        methods: ['totp', 'passkey'],
        expires_in: 300,
      });

      render(
        <AuthProvider>
          <TwoFactorLoginPage />
        </AuthProvider>,
      );

      const passkeyBtn = await screen.findByRole('button', { name: /dùng passkey/i });
      fireEvent.click(passkeyBtn);

      await waitFor(() => {
        expect(navigator.credentials.get).toHaveBeenCalled();
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('2. Passkey Login on /login', () => {
    it('shows "Đăng nhập bằng passkey" button when WebAuthn is supported', async () => {
      (window as any).PublicKeyCredential = class {};

      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>,
      );

      const btn = await screen.findByRole('button', { name: /đăng nhập bằng passkey/i });
      expect(btn).toBeDefined();
    });

    it('hides passkey button when PublicKeyCredential is not available', () => {
      delete (window as any).PublicKeyCredential;

      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>,
      );

      expect(screen.queryByRole('button', { name: /đăng nhập bằng passkey/i })).toBeNull();
    });
  });

  describe('3. Staff Banner', () => {
    it('renders persistent banner when user.staff_roles_pending_mfa is non-empty', () => {
      const pendingUser = {
        id: 'user-pending-staff',
        email: 'staff@winkey.vn',
        handle: 'staff_user',
        roles: ['viewer'],
        staff_roles_pending_mfa: ['admin'],
      };

      render(
        <AuthProvider initialUser={pendingUser as any}>
          <StaffMfaBanner />
        </AuthProvider>,
      );

      expect(screen.getByText(/bật xác thực hai lớp để dùng quyền quản trị/i)).toBeDefined();
      expect(screen.getByRole('link', { name: /cài đặt bảo mật/i }).getAttribute('href')).toBe(
        '/cai-dat/bao-mat',
      );
    });

    it('does not render banner when user has no pending staff roles', () => {
      const normalUser = {
        id: 'user-normal',
        email: 'user@winkey.vn',
        handle: 'normal_user',
        roles: ['viewer'],
        staff_roles_pending_mfa: [],
      };

      render(
        <AuthProvider initialUser={normalUser as any}>
          <StaffMfaBanner />
        </AuthProvider>,
      );

      expect(screen.queryByText(/bật xác thực hai lớp để dùng quyền quản trị/i)).toBeNull();
    });
  });

  describe('4. Report Session Page (/bao-cao-dang-nhap)', () => {
    it('calls reportSession and displays recommendation to change password and 2FA', async () => {
      mockSearchParams = new URLSearchParams('token=valid-report-token');

      render(<ReportSessionPage />);

      await waitFor(() => {
        expect(screen.getByText(/đã huỷ phiên đăng nhập đáng ngờ/i)).toBeDefined();
      });

      expect(screen.getByText(/đổi mật khẩu tài khoản/i)).toBeDefined();
      expect(screen.getByText(/bật xác thực 2 lớp/i)).toBeDefined();
    });

    it('displays error message when token is invalid', async () => {
      mockSearchParams = new URLSearchParams('token=invalid-token');

      render(<ReportSessionPage />);

      await waitFor(() => {
        expect(screen.getByText(/không thể xử lý báo cáo/i)).toBeDefined();
      });
    });
  });

  describe('5. Step-Up Dialog Component', () => {
    it('opens on requirement and calls step-up with password', async () => {
      const handleSuccess = vi.fn();
      const handleClose = vi.fn();

      render(
        <StepUpDialog
          isOpen={true}
          onClose={handleClose}
          onSuccess={handleSuccess}
          securitySummary={{
            has_password: true,
            totp_enabled: false,
            passkey_count: 0,
            recovery_codes_remaining: 10,
            mfa_enabled: false,
            step_up_until: null,
            staff_roles_pending_mfa: [],
          }}
        />,
      );

      expect(screen.getByText(/xác thực bảo mật nâng cao/i)).toBeDefined();

      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      fireEvent.click(screen.getByRole('button', { name: /xác nhận/i }));

      await waitFor(() => {
        expect(handleSuccess).toHaveBeenCalled();
        expect(handleClose).toHaveBeenCalled();
      });
    });
  });

  describe('6. Breached Password & Captcha Requirements', () => {
    it('shows CAPTCHA error and reveals widget when login returns CAPTCHA_REQUIRED', async () => {
      render(
        <AuthProvider>
          <LoginPage />
        </AuthProvider>,
      );

      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: 'captcha@winkey.vn' },
      });
      fireEvent.change(screen.getByLabelText(/mật khẩu/i), {
        target: { value: 'password123' },
      });

      fireEvent.click(screen.getByRole('button', { name: /đăng nhập/i }));

      await waitFor(() => {
        expect(screen.getByText(/vui lòng hoàn thành xác thực bảo vệ captcha/i)).toBeDefined();
      });
    });
  });

  describe('7. Security Settings Page (/cai-dat/bao-mat)', () => {
    it('renders security settings overview and sections', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/cài đặt bảo mật tài khoản/i)).toBeDefined();
        expect(screen.getByText(/tổng quan bảo mật tài khoản/i)).toBeDefined();
        expect(screen.getByText(/ứng dụng xác thực \(totp\)/i)).toBeDefined();
        expect(screen.getByText(/khóa truy cập \(passkeys\)/i)).toBeDefined();
        expect(screen.getByText(/phiên đăng nhập đang hoạt động/i)).toBeDefined();
      });
    });

    it('starts TOTP setup, displays secret and local QR, confirms code and displays recovery codes modal', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const setupBtn = await screen.findByRole('button', { name: /bật xác thực ứng dụng/i });
      fireEvent.click(setupBtn);

      await waitFor(() => {
        expect(screen.getByText(/jbswy3dpehpk3pxp/i)).toBeDefined();
        expect(screen.getByAltText(/mã qr thiết lập totp/i)).toBeDefined();
      });

      const confirmInput = screen.getByLabelText(/nhập mã 6 chữ số/i);
      fireEvent.change(confirmInput, { target: { value: '123456' } });

      const activateBtn = screen.getByRole('button', { name: /kích hoạt xác thực totp/i });
      fireEvent.click(activateBtn);

      await waitFor(() => {
        expect(screen.getByText(/mã khôi phục mới cho tài khoản/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /sao chép tất cả/i })).toBeDefined();
        expect(screen.getByRole('button', { name: /tải xuống \.txt/i })).toBeDefined();
      });

      // Closing requires confirmation checkbox
      const closeBtn = screen.getByRole('button', {
        name: /tôi đã lưu & đóng/i,
      }) as HTMLButtonElement;
      expect(closeBtn.disabled).toBe(true);

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);
      expect(closeBtn.disabled).toBe(false);
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(screen.queryByText(/mã khôi phục mới cho tài khoản/i)).toBeNull();
      });
    });

    it('renders session list with "Thiết bị này" badge and allows revoking', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/thiết bị này/i)).toBeDefined();
        expect(screen.getAllByText(/chrome trên macos/i).length).toBeGreaterThan(0);
        expect(screen.getByText(/safari trên iphone 15/i)).toBeDefined();
      });

      // Revoke all other devices button
      const revokeOthersBtn = screen.getByRole('button', {
        name: /đăng xuất tất cả thiết bị khác/i,
      });
      expect(revokeOthersBtn).toBeDefined();
    });

    it('opens step-up dialog when TOTP start setup returns 403 STEP_UP_REQUIRED and retries successfully', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      setMockRequireStepUp(true);

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const setupBtn = await screen.findByRole('button', { name: /bật xác thực ứng dụng/i });
      fireEvent.click(setupBtn);

      // Verify Step-up dialog opened
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeDefined();
      });

      // Complete step-up by providing password
      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      const submitStepUp = screen.getByRole('button', { name: /xác nhận/i });
      fireEvent.click(submitStepUp);

      // Verify that after step-up succeeds, handleStartSetup was retried and QR + secret is displayed
      await waitFor(() => {
        expect(screen.getByText(/jbswy3dpehpk3pxp/i)).toBeDefined();
        expect(screen.getByAltText(/mã qr thiết lập totp/i)).toBeDefined();
      });
    });

    it('opens step-up dialog when TOTP confirm returns 403 STEP_UP_REQUIRED and retries successfully', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const setupBtn = await screen.findByRole('button', { name: /bật xác thực ứng dụng/i });
      fireEvent.click(setupBtn);

      await waitFor(() => {
        expect(screen.getByText(/jbswy3dpehpk3pxp/i)).toBeDefined();
        expect(screen.getByAltText(/mã qr thiết lập totp/i)).toBeDefined();
      });

      // Now set mock require step up for confirmation
      setMockRequireStepUp(true);

      const confirmInput = screen.getByLabelText(/nhập mã 6 chữ số/i);
      fireEvent.change(confirmInput, { target: { value: '123456' } });

      const activateBtn = await screen.findByRole('button', { name: /kích hoạt xác thực totp/i });
      fireEvent.click(activateBtn);

      // Verify Step-up dialog opened
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeDefined();
      });

      // Complete step-up
      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      const submitStepUp = screen.getByRole('button', { name: /xác nhận/i });
      fireEvent.click(submitStepUp);

      // Verify confirm retry succeeded and recovery codes modal is shown
      await waitFor(() => {
        expect(screen.getByText(/mã khôi phục mới cho tài khoản/i)).toBeDefined();
      });
    });

    it('opens step-up dialog when passkey registration returns 403 STEP_UP_REQUIRED and retries', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      (window as any).PublicKeyCredential = class {};
      Object.defineProperty(navigator, 'credentials', {
        value: {
          get: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: 'new-pk-id',
            rawId: new Uint8Array([1, 2, 3]).buffer,
            type: 'public-key',
            toJSON: () => ({
              id: 'new-pk-id',
              rawId: 'AQID',
              type: 'public-key',
              response: {
                clientDataJSON: 'AQI',
                attestationObject: 'AwQ',
              },
            }),
            response: {
              clientDataJSON: new Uint8Array([1, 2]).buffer,
              attestationObject: new Uint8Array([3, 4]).buffer,
            },
          }),
        },
        configurable: true,
      });

      setMockRequireStepUp(true);

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const addBtn = await screen.findByRole('button', { name: /thêm passkey/i });
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeDefined();
      });

      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      const submitStepUp = screen.getByRole('button', { name: /xác nhận/i });
      fireEvent.click(submitStepUp);

      await waitFor(() => {
        expect(navigator.credentials.create).toHaveBeenCalled();
      });
    });

    it('opens step-up dialog when regenerate recovery codes returns 403 STEP_UP_REQUIRED and retries', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      vi.spyOn(window, 'confirm').mockReturnValue(true);
      setMockRequireStepUp(true);

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const regenBtn = await screen.findByRole('button', { name: /tạo mã mới/i });
      fireEvent.click(regenBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeDefined();
      });

      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      const submitStepUp = screen.getByRole('button', { name: /xác nhận/i });
      fireEvent.click(submitStepUp);

      await waitFor(() => {
        expect(screen.getByText(/bộ mã khôi phục mới/i)).toBeDefined();
      });
    });

    it('opens step-up dialog when revoking a session returns 403 STEP_UP_REQUIRED and retries', async () => {
      const authUser = {
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        email: 'creator@winkey.vn',
        handle: 'winkey_creator',
        roles: ['viewer', 'creator'],
        staff_roles_pending_mfa: [],
      };

      setMockRequireStepUp(true);

      render(
        <AuthProvider initialUser={authUser as any}>
          <SecuritySettingsPage />
        </AuthProvider>,
      );

      const revokeBtns = await screen.findAllByRole('button', { name: /đăng xuất/i });
      fireEvent.click(revokeBtns[0]);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeDefined();
      });

      const pwdInput = screen.getByLabelText(/nhập mật khẩu hiện tại/i);
      fireEvent.change(pwdInput, { target: { value: 'password123' } });

      const submitStepUp = screen.getByRole('button', { name: /xác nhận/i });
      fireEvent.click(submitStepUp);

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /xác thực bảo mật nâng cao/i })).toBeNull();
      });
    });
  });
});
