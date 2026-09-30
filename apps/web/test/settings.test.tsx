import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AccountSettingsPage from '../src/app/[locale]/settings/account/page';
import { ProfileSettings } from '../src/components/settings/profile-settings';
import { PasswordSettings } from '../src/components/settings/password-settings';
import { DangerZone } from '../src/components/settings/danger-zone';
import { DeleteAccountDialog } from '../src/components/settings/delete-account-dialog';
import { api } from '../src/lib/api-client';
import type { User } from '@winkey/api-client';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

type PatchReturn = Awaited<ReturnType<typeof api.auth.PATCH>>;
type PutReturn = Awaited<ReturnType<typeof api.auth.PUT>>;
type DeleteReturn = Awaited<ReturnType<typeof api.auth.DELETE>>;

let activeLocale: 'en' | 'vi' = 'en';
export function setTestLocale(locale: 'en' | 'vi') {
  activeLocale = locale;
}

// Mock next-intl
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsKey = namespace ?? '';
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
        if (key === 'confirmHandleInstruction') {
          return isVi
            ? `Để xác nhận, vui lòng nhập lại handle ${values?.handle}:`
            : `To confirm, please type your handle ${values?.handle}:`;
        }

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
  usePathname: () => '/settings/account',
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

// Mock auth context
let mockUser: User | null = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  email: 'creator@winkey.vn',
  email_verified: true,
  handle: 'winkey_creator',
  display_name: 'Winkey Official Creator',
  avatar_url: 'https://example.com/avatar.jpg',
  roles: ['viewer', 'creator'],
  has_password: true,
  created_at: '2026-01-01T00:00:00Z',
};
let mockIsAuthenticated = true;
let mockIsLoading = false;
const mockUpdateUser = vi.fn();
const mockClearSession = vi.fn();

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
    isCreator: mockUser?.roles?.includes('creator') ?? false,
    isModerator: mockUser?.roles?.includes('moderator') ?? false,
    isAdmin: mockUser?.roles?.includes('admin') ?? false,
    canAccessAdmin:
      (mockUser?.roles?.includes('moderator') || mockUser?.roles?.includes('admin')) ?? false,
    updateUser: mockUpdateUser,
    clearSession: mockClearSession,
  }),
}));

describe('Task U5: Account Settings Page & Components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTestLocale('en');
    mockUser = {
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
      email: 'creator@winkey.vn',
      email_verified: true,
      handle: 'winkey_creator',
      display_name: 'Winkey Official Creator',
      avatar_url: 'https://example.com/avatar.jpg',
      roles: ['viewer', 'creator'],
      has_password: true,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockIsAuthenticated = true;
    mockIsLoading = false;
  });

  describe('Page Route Guard', () => {
    it('redirects unauthenticated users to /login?return_to=/settings/account', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      render(<AccountSettingsPage />);

      expect(mockPush).toHaveBeenCalledWith('/login?return_to=/settings/account');
    });

    it('renders spinner while auth is loading', () => {
      mockIsLoading = true;

      const { container } = render(<AccountSettingsPage />);

      expect(container.querySelector('.animate-spin')).toBeDefined();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('renders account settings page when authenticated', () => {
      render(<AccountSettingsPage />);

      expect(screen.getByRole('heading', { level: 1, name: 'Account Settings' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Profile Details' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Change Password' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Danger Zone' })).toBeDefined();
    });
  });

  describe('Profile Settings', () => {
    it('pre-fills display_name, handle, and displays read-only email', () => {
      render(<ProfileSettings user={mockUser!} />);

      const nameInput = screen.getByLabelText('Display Name') as HTMLInputElement;
      const handleInput = screen.getByLabelText('Handle') as HTMLInputElement;
      const emailInput = screen.getByLabelText('Email Address') as HTMLInputElement;

      expect(nameInput.value).toBe('Winkey Official Creator');
      expect(handleInput.value).toBe('winkey_creator');
      expect(emailInput.value).toBe('creator@winkey.vn');
      expect(emailInput.disabled).toBe(true);
    });

    it('no-op does not send any API request', async () => {
      const patchSpy = vi.spyOn(api.auth, 'PATCH');

      render(<ProfileSettings user={mockUser!} />);

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      // Button is disabled when not dirty
      expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

      fireEvent.submit(saveBtn.closest('form')!);

      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('sends only changed fields when display_name is updated', async () => {
      const patchSpy = vi.spyOn(api.auth, 'PATCH').mockResolvedValueOnce({
        data: { ...mockUser!, display_name: 'Brand New Name' },
        response: new Response(null, { status: 200 }),
      } as unknown as PatchReturn);

      render(<ProfileSettings user={mockUser!} />);

      const nameInput = screen.getByLabelText('Display Name');
      fireEvent.change(nameInput, { target: { value: 'Brand New Name' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      expect((saveBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith('/v1/auth/me', {
          body: { display_name: 'Brand New Name' },
        });
      });

      expect(mockUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: 'Brand New Name' }),
      );
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('sends only changed fields when handle is updated', async () => {
      const patchSpy = vi.spyOn(api.auth, 'PATCH').mockResolvedValueOnce({
        data: { ...mockUser!, handle: 'new_creator_handle' },
        response: new Response(null, { status: 200 }),
      } as unknown as PatchReturn);

      render(<ProfileSettings user={mockUser!} />);

      const handleInput = screen.getByLabelText('Handle');
      fireEvent.change(handleInput, { target: { value: 'new_creator_handle' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith('/v1/auth/me', {
          body: { handle: 'new_creator_handle' },
        });
      });

      expect(mockUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({ handle: 'new_creator_handle' }),
      );
    });

    it('blocks submission and shows inline error for empty display name', async () => {
      const patchSpy = vi.spyOn(api.auth, 'PATCH');

      render(<ProfileSettings user={mockUser!} />);

      const nameInput = screen.getByLabelText('Display Name');
      fireEvent.change(nameInput, { target: { value: '   ' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      fireEvent.submit(saveBtn.closest('form')!);

      expect(screen.getByText('Display name is required (1–50 characters).')).toBeDefined();
      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('blocks submission and shows inline error for invalid handle format', async () => {
      const patchSpy = vi.spyOn(api.auth, 'PATCH');

      render(<ProfileSettings user={mockUser!} />);

      const handleInput = screen.getByLabelText('Handle');
      fireEvent.change(handleInput, { target: { value: 'bad@handle!' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      fireEvent.submit(saveBtn.closest('form')!);

      expect(
        screen.getByText(
          'Handle must be 3–30 characters and contain only letters, numbers, dots, and underscores.',
        ),
      ).toBeDefined();
      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('displays 409 HANDLE_TAKEN inline on handle field', async () => {
      vi.spyOn(api.auth, 'PATCH').mockResolvedValueOnce({
        error: {
          type: '/problems/conflict',
          title: 'Handle taken',
          status: 409,
          code: 'HANDLE_TAKEN',
        },
        response: new Response(null, { status: 409 }),
      } as unknown as PatchReturn);

      render(<ProfileSettings user={mockUser!} />);

      const handleInput = screen.getByLabelText('Handle');
      fireEvent.change(handleInput, { target: { value: 'viet_coder' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText('This handle is already taken by another account.')).toBeDefined();
      });
    });

    it('displays 429 rate limit error when user changes profile too frequently', async () => {
      vi.spyOn(api.auth, 'PATCH').mockResolvedValueOnce({
        error: {
          type: '/problems/too-many-requests',
          title: 'Too many requests',
          status: 429,
        },
        response: new Response(null, { status: 429 }),
      } as unknown as PatchReturn);

      render(<ProfileSettings user={mockUser!} />);

      const handleInput = screen.getByLabelText('Handle');
      fireEvent.change(handleInput, { target: { value: 'another_handle' } });

      const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText('Too many changes. Please try again later.')).toBeDefined();
      });
    });
  });

  describe('Password Settings', () => {
    it('renders current password, new password, and confirm password when has_password = true', () => {
      render(<PasswordSettings user={mockUser!} />);

      expect(screen.getByRole('heading', { level: 2, name: 'Change Password' })).toBeDefined();
      expect(screen.getByLabelText('Current Password')).toBeDefined();
      expect(screen.getByLabelText('New Password')).toBeDefined();
      expect(screen.getByLabelText('Confirm New Password')).toBeDefined();
    });

    it('renders Set a Password without current password field when has_password = false', () => {
      const googleUser: User = {
        ...mockUser!,
        has_password: false,
      };

      render(<PasswordSettings user={googleUser} />);

      expect(screen.getByRole('heading', { level: 2, name: 'Set a Password' })).toBeDefined();
      expect(screen.queryByLabelText('Current Password')).toBeNull();
      expect(screen.getByLabelText('New Password')).toBeDefined();
      expect(screen.getByLabelText('Confirm New Password')).toBeDefined();
    });

    it('client validation catches short passwords (< 8 chars)', async () => {
      const putSpy = vi.spyOn(api.auth, 'PUT');

      render(<PasswordSettings user={mockUser!} />);

      fireEvent.change(screen.getByLabelText('Current Password'), {
        target: { value: 'CurrentPass123' },
      });
      fireEvent.change(screen.getByLabelText('New Password'), {
        target: { value: 'short' },
      });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), {
        target: { value: 'short' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

      expect(screen.getByText('Password must be between 8 and 128 characters.')).toBeDefined();
      expect(putSpy).not.toHaveBeenCalled();
    });

    it('client validation catches password mismatch', async () => {
      const putSpy = vi.spyOn(api.auth, 'PUT');

      render(<PasswordSettings user={mockUser!} />);

      fireEvent.change(screen.getByLabelText('Current Password'), {
        target: { value: 'CurrentPass123' },
      });
      fireEvent.change(screen.getByLabelText('New Password'), {
        target: { value: 'NewPassword123' },
      });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), {
        target: { value: 'DifferentPassword123' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

      expect(screen.getByText('New passwords do not match.')).toBeDefined();
      expect(putSpy).not.toHaveBeenCalled();
    });

    it('maps 403 INVALID_CREDENTIALS to current password field', async () => {
      vi.spyOn(api.auth, 'PUT').mockResolvedValueOnce({
        error: {
          type: '/problems/forbidden',
          title: 'Invalid credentials',
          status: 403,
          code: 'INVALID_CREDENTIALS',
        },
        response: new Response(null, { status: 403 }),
      } as unknown as PutReturn);

      render(<PasswordSettings user={mockUser!} />);

      fireEvent.change(screen.getByLabelText('Current Password'), {
        target: { value: 'WrongCurrentPass' },
      });
      fireEvent.change(screen.getByLabelText('New Password'), {
        target: { value: 'NewPassword123' },
      });
      fireEvent.change(screen.getByLabelText('Confirm New Password'), {
        target: { value: 'NewPassword123' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(screen.getByText('Incorrect current password.')).toBeDefined();
      });
    });

    it('successfully changes password, shows toast, and clears input fields', async () => {
      const putSpy = vi.spyOn(api.auth, 'PUT').mockResolvedValueOnce({
        response: new Response(null, { status: 204 }),
      } as unknown as PutReturn);

      render(<PasswordSettings user={mockUser!} />);

      const currentInput = screen.getByLabelText('Current Password') as HTMLInputElement;
      const newInput = screen.getByLabelText('New Password') as HTMLInputElement;
      const confirmInput = screen.getByLabelText('Confirm New Password') as HTMLInputElement;

      fireEvent.change(currentInput, { target: { value: 'ValidCurrent123' } });
      fireEvent.change(newInput, { target: { value: 'BrandNewPassword123' } });
      fireEvent.change(confirmInput, { target: { value: 'BrandNewPassword123' } });

      fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

      await waitFor(() => {
        expect(putSpy).toHaveBeenCalledWith('/v1/auth/me/password', {
          body: {
            current_password: 'ValidCurrent123',
            new_password: 'BrandNewPassword123',
          },
        });
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Password changed. Other devices were signed out.',
          type: 'success',
        }),
      );
      expect(currentInput.value).toBe('');
      expect(newInput.value).toBe('');
      expect(confirmInput.value).toBe('');
    });
  });

  describe('Delete Account (Danger Zone)', () => {
    it('opens dialog when Delete Account button is clicked', () => {
      render(<DangerZone user={mockUser!} />);

      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));

      expect(screen.getByRole('dialog')).toBeDefined();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Delete Account Confirmation' }),
      ).toBeDefined();
    });

    it('keeps confirm button disabled until handle matches and password is provided', () => {
      render(<DeleteAccountDialog user={mockUser!} isOpen={true} onClose={vi.fn()} />);

      const confirmBtn = screen.getByRole('button', {
        name: 'Permanently Delete Account',
      }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);

      const handleInput = screen.getByLabelText(
        'To confirm, please type your handle winkey_creator:',
      );
      const passwordInput = screen.getByLabelText('Enter your password to confirm:');

      // Typing wrong handle
      fireEvent.change(handleInput, { target: { value: 'wrong_handle' } });
      fireEvent.change(passwordInput, { target: { value: 'Password123' } });
      expect(confirmBtn.disabled).toBe(true);

      // Typing matching handle (case-insensitive)
      fireEvent.change(handleInput, { target: { value: 'WINKEY_CREATOR' } });
      expect(confirmBtn.disabled).toBe(false);

      // Clearing password disables it
      fireEvent.change(passwordInput, { target: { value: '' } });
      expect(confirmBtn.disabled).toBe(true);
    });

    it('closes on Escape key press or cancel button', () => {
      const onClose = vi.fn();
      render(<DeleteAccountDialog user={mockUser!} isOpen={true} onClose={onClose} />);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('maps 409 LAST_ADMIN error banner', async () => {
      vi.spyOn(api.auth, 'DELETE').mockResolvedValueOnce({
        error: {
          type: '/problems/conflict',
          title: 'Last admin',
          status: 409,
          code: 'LAST_ADMIN',
        },
        response: new Response(null, { status: 409 }),
      } as unknown as DeleteReturn);

      render(<DeleteAccountDialog user={mockUser!} isOpen={true} onClose={vi.fn()} />);

      fireEvent.change(
        screen.getByLabelText('To confirm, please type your handle winkey_creator:'),
        { target: { value: 'winkey_creator' } },
      );
      fireEvent.change(screen.getByLabelText('Enter your password to confirm:'), {
        target: { value: 'Password123' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }));

      await waitFor(() => {
        expect(
          screen.getByText('You are the last admin; give the admin role to someone else first.'),
        ).toBeDefined();
      });
    });

    it('successfully deletes account, clears session, and redirects to /', async () => {
      const deleteSpy = vi.spyOn(api.auth, 'DELETE').mockResolvedValueOnce({
        response: new Response(null, { status: 204 }),
      } as unknown as DeleteReturn);

      const onClose = vi.fn();
      render(<DeleteAccountDialog user={mockUser!} isOpen={true} onClose={onClose} />);

      fireEvent.change(
        screen.getByLabelText('To confirm, please type your handle winkey_creator:'),
        { target: { value: 'winkey_creator' } },
      );
      fireEvent.change(screen.getByLabelText('Enter your password to confirm:'), {
        target: { value: 'ValidPassword123' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }));

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith('/v1/auth/me', {
          body: {
            confirm_handle: 'winkey_creator',
            password: 'ValidPassword123',
          },
        });
      });

      expect(mockClearSession).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      expect(mockPush).toHaveBeenCalledWith('/');
    });
  });

  describe('Vietnamese Localization', () => {
    it('renders all sections and buttons correctly in Vietnamese', () => {
      setTestLocale('vi');

      render(<AccountSettingsPage />);

      expect(screen.getByRole('heading', { level: 1, name: 'Cài đặt tài khoản' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Thông tin hồ sơ' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Đổi mật khẩu' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 2, name: 'Khu vực nguy hiểm' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Đổi mật khẩu' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Xóa tài khoản' })).toBeDefined();
    });
  });
});
