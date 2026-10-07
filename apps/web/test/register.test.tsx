import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RegisterPage from '../src/app/[locale]/register/page';
import viMessages from '../messages/vi.json';

// --- Router and SearchParams Mock ---
let mockSearchParams = new URLSearchParams();
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock('../src/i18n/routing', () => ({
  Link: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/register',
}));

// --- Locale Mock ---
const translateFn = (key: string, values?: Record<string, unknown>) => {
  const parts = key.split('.');
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

const authTranslator = (key: string, values?: Record<string, unknown>) =>
  translateFn(`auth.${key}`, values);

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    if (namespace === 'auth') return authTranslator;
    return (key: string, values?: Record<string, unknown>) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      return translateFn(fullPath, values);
    };
  },
}));

// --- Auth Mock ---
const mockRegister = vi.fn();

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    register: mockRegister,
    isAuthenticated: false,
    user: null,
  }),
}));

describe('Task BETA1-web: Register Page with Closed Beta Invites & Legal Checkbox (ADR-034)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('prefills invite code from ?invite= and limits to 64 chars', () => {
    mockSearchParams = new URLSearchParams({ invite: 'wk-beta1-alpha999' });
    render(<RegisterPage />);

    const inviteInput = screen.getByLabelText(/Mã mời/i) as HTMLInputElement;
    expect(inviteInput.value).toBe('wk-beta1-alpha999');
    expect(inviteInput.maxLength).toBe(64);
  });

  it('omits invite_code in register payload when field is empty or whitespace', async () => {
    mockRegister.mockResolvedValue({ success: true });
    render(<RegisterPage />);

    fireEvent.change(screen.getByPlaceholderText('Nguyễn Văn A'), {
      target: { value: 'Nguyen Van A' },
    });
    fireEvent.change(screen.getByPlaceholderText('nguyenvana (3-30 ký tự)'), {
      target: { value: 'nguyenvana' },
    });
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'user@winkey.vn' },
    });
    fireEvent.change(screen.getByPlaceholderText('Tối thiểu 8 ký tự'), {
      target: { value: 'secretpass123' },
    });

    // Check agreement
    const checkbox = screen.getByTestId('terms-agreement-checkbox');
    fireEvent.click(checkbox);

    // Submit
    const submitBtn = screen.getByTestId('register-submit-btn');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    const sentPayload = mockRegister.mock.calls[0][0];
    expect(sentPayload).toEqual({
      display_name: 'Nguyen Van A',
      handle: 'nguyenvana',
      email: 'user@winkey.vn',
      password: 'secretpass123',
    });
    expect(sentPayload.invite_code).toBeUndefined();
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('trims and includes invite_code in register payload when non-empty', async () => {
    mockRegister.mockResolvedValue({ success: true });
    render(<RegisterPage />);

    fireEvent.change(screen.getByPlaceholderText('Nguyễn Văn A'), {
      target: { value: 'Nguyen Van A' },
    });
    fireEvent.change(screen.getByPlaceholderText('nguyenvana (3-30 ký tự)'), {
      target: { value: 'nguyenvana' },
    });
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'user@winkey.vn' },
    });
    fireEvent.change(screen.getByPlaceholderText('Tối thiểu 8 ký tự'), {
      target: { value: 'secretpass123' },
    });
    fireEvent.change(screen.getByLabelText(/Mã mời/i), {
      target: { value: '  wk-beta1-vip  ' },
    });

    // Check agreement
    fireEvent.click(screen.getByTestId('terms-agreement-checkbox'));
    fireEvent.click(screen.getByTestId('register-submit-btn'));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    const sentPayload = mockRegister.mock.calls[0][0];
    expect(sentPayload.invite_code).toBe('wk-beta1-vip');
  });

  it('maps 403 INVITE_REQUIRED to Vietnamese message and focuses invite field', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: {
        status: 403,
        code: 'INVITE_REQUIRED',
        title: 'Forbidden',
        type: '/problems/forbidden',
      },
    });

    render(<RegisterPage />);

    fireEvent.change(screen.getByPlaceholderText('Nguyễn Văn A'), {
      target: { value: 'Nguyen Van A' },
    });
    fireEvent.change(screen.getByPlaceholderText('nguyenvana (3-30 ký tự)'), {
      target: { value: 'nguyenvana' },
    });
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'user@winkey.vn' },
    });
    fireEvent.change(screen.getByPlaceholderText('Tối thiểu 8 ký tự'), {
      target: { value: 'secretpass123' },
    });

    fireEvent.click(screen.getByTestId('terms-agreement-checkbox'));
    fireEvent.click(screen.getByTestId('register-submit-btn'));

    await waitFor(() => {
      const err = screen.getByTestId('invite-error-msg');
      expect(err.textContent).toContain(
        'Winkey đang thử nghiệm kín. Bạn cần mã mời để tạo tài khoản.',
      );
    });

    const inviteInput = screen.getByLabelText(/Mã mời/i);
    expect(document.activeElement).toBe(inviteInput);
  });

  it('maps 403 INVITE_INVALID to Vietnamese message and focuses invite field', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: {
        status: 403,
        code: 'INVITE_INVALID',
        title: 'Forbidden',
        type: '/problems/forbidden',
      },
    });

    render(<RegisterPage />);

    fireEvent.change(screen.getByPlaceholderText('Nguyễn Văn A'), {
      target: { value: 'Nguyen Van A' },
    });
    fireEvent.change(screen.getByPlaceholderText('nguyenvana (3-30 ký tự)'), {
      target: { value: 'nguyenvana' },
    });
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'user@winkey.vn' },
    });
    fireEvent.change(screen.getByPlaceholderText('Tối thiểu 8 ký tự'), {
      target: { value: 'secretpass123' },
    });

    fireEvent.click(screen.getByTestId('terms-agreement-checkbox'));
    fireEvent.click(screen.getByTestId('register-submit-btn'));

    await waitFor(() => {
      const err = screen.getByTestId('invite-error-msg');
      expect(err.textContent).toContain('Mã mời không đúng hoặc đã hết hạn.');
    });

    const inviteInput = screen.getByLabelText(/Mã mời/i);
    expect(document.activeElement).toBe(inviteInput);
  });

  it('reads ?error=INVITE_REQUIRED from Google callback redirect, shows message and focuses field', async () => {
    mockSearchParams = new URLSearchParams({ error: 'INVITE_REQUIRED' });
    render(<RegisterPage />);

    await waitFor(() => {
      const err = screen.getByTestId('invite-error-msg');
      expect(err.textContent).toContain(
        'Winkey đang thử nghiệm kín. Bạn cần mã mời để tạo tài khoản.',
      );
    });

    const inviteInput = screen.getByLabelText(/Mã mời/i);
    expect(document.activeElement).toBe(inviteInput);
  });

  it('reads ?error=INVITE_INVALID from Google callback redirect, shows message and focuses field', async () => {
    mockSearchParams = new URLSearchParams({ error: 'INVITE_INVALID' });
    render(<RegisterPage />);

    await waitFor(() => {
      const err = screen.getByTestId('invite-error-msg');
      expect(err.textContent).toContain('Mã mời không đúng hoặc đã hết hạn.');
    });

    const inviteInput = screen.getByLabelText(/Mã mời/i);
    expect(document.activeElement).toBe(inviteInput);
  });

  it('checkbox gates both Submit and Google buttons until checked', () => {
    render(<RegisterPage />);

    const submitBtn = screen.getByTestId('register-submit-btn') as HTMLButtonElement;
    const googleBtn = screen.getByTestId('google-oauth-btn') as HTMLAnchorElement;
    const checkbox = screen.getByTestId('terms-agreement-checkbox') as HTMLInputElement;

    // Initially unchecked
    expect(checkbox.checked).toBe(false);
    expect(submitBtn.disabled).toBe(true);
    expect(googleBtn.getAttribute('aria-disabled')).toBe('true');
    expect(googleBtn.className).toContain('cursor-not-allowed');

    // Check the box
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(submitBtn.disabled).toBe(false);
    expect(googleBtn.getAttribute('aria-disabled')).toBe('false');
    expect(googleBtn.className).not.toContain('cursor-not-allowed');

    // Uncheck again
    fireEvent.click(checkbox);
    expect(submitBtn.disabled).toBe(true);
    expect(googleBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('Google button carries URL-encoded invite_code only when field is non-empty', () => {
    render(<RegisterPage />);

    const checkbox = screen.getByTestId('terms-agreement-checkbox');
    fireEvent.click(checkbox);

    const googleBtn = screen.getByTestId('google-oauth-btn') as HTMLAnchorElement;
    expect(googleBtn.getAttribute('href')).toBe('/v1/auth/oauth/google?return_to=/');

    // Fill invite code with special characters
    const inviteInput = screen.getByLabelText(/Mã mời/i);
    fireEvent.change(inviteInput, { target: { value: 'invite 123+alpha' } });

    expect(googleBtn.getAttribute('href')).toBe(
      '/v1/auth/oauth/google?return_to=/&invite_code=invite%20123%2Balpha',
    );
  });

  it('contains target="_blank" links to /dieu-khoan and /quyen-rieng-tu in agreement label', () => {
    render(<RegisterPage />);

    const termsLink = screen.getByRole('link', { name: /Điều khoản sử dụng/i });
    const privacyLink = screen.getByRole('link', { name: /Chính sách quyền riêng tư/i });

    expect(termsLink.getAttribute('href')).toBe('/dieu-khoan');
    expect(termsLink.getAttribute('target')).toBe('_blank');
    expect(termsLink.getAttribute('rel')).toBe('noopener noreferrer');

    expect(privacyLink.getAttribute('href')).toBe('/quyen-rieng-tu');
    expect(privacyLink.getAttribute('target')).toBe('_blank');
    expect(privacyLink.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
