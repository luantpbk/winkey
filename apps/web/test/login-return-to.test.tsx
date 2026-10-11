import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from '../src/app/[locale]/login/page';
import { getSafeReturnTo } from '../src/lib/auth/return-to';
import viMessages from '../messages/vi.json';

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

// Mock Auth Context
const mockLogin = vi.fn(async () => ({ success: true }));
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: mockLogin,
  }),
}));

describe('Login return_to validation hardening against open redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  describe('1. Unit tests: getSafeReturnTo helper validation', () => {
    it('accepts valid in-app relative destination path with query parameters', () => {
      expect(getSafeReturnTo('/watch/x?playlist=y&src=playlist')).toBe(
        '/watch/x?playlist=y&src=playlist',
      );
      expect(getSafeReturnTo('/settings/account')).toBe('/settings/account');
      expect(getSafeReturnTo('/thu-vien')).toBe('/thu-vien');
      expect(getSafeReturnTo('/')).toBe('/');
    });

    it('falls back to "/" for scheme-relative "//evil.com"', () => {
      expect(getSafeReturnTo('//evil.com')).toBe('/');
      expect(getSafeReturnTo('///evil.com')).toBe('/');
    });

    it('falls back to "/" for backslash open redirect "/\\evil.com"', () => {
      expect(getSafeReturnTo('/\\evil.com')).toBe('/');
      expect(getSafeReturnTo('/\\\\evil.com')).toBe('/');
    });

    it('falls back to "/" for absolute URL with scheme "https://evil.com"', () => {
      expect(getSafeReturnTo('https://evil.com')).toBe('/');
      expect(getSafeReturnTo('http://evil.com')).toBe('/');
      expect(getSafeReturnTo('javascript:alert(1)')).toBe('/');
    });

    it('falls back to "/" for empty string, null, or undefined', () => {
      expect(getSafeReturnTo('')).toBe('/');
      expect(getSafeReturnTo(null)).toBe('/');
      expect(getSafeReturnTo(undefined)).toBe('/');
    });

    it('falls back to "/" for strings with control characters', () => {
      expect(getSafeReturnTo('/watch\x00evil')).toBe('/');
      expect(getSafeReturnTo('/watch\r\nevil')).toBe('/');
      expect(getSafeReturnTo('/watch\t')).toBe('/');
      expect(getSafeReturnTo('/watch\x1F')).toBe('/');
      expect(getSafeReturnTo('/watch\x7F')).toBe('/');
    });
  });

  describe('2. Component integration tests: LoginPage redirection & Google OAuth href', () => {
    it('accepts /watch/x?playlist=y&src=playlist and uses it in login redirect and Google OAuth href', async () => {
      mockSearchParams = new URLSearchParams({
        return_to: '/watch/x?playlist=y&src=playlist',
      });

      render(<LoginPage />);

      // Google OAuth link contains encoded safe return_to
      const googleLink = screen.getByRole('link', { name: /Google/i });
      expect(googleLink.getAttribute('href')).toBe(
        `/v1/auth/oauth/google?return_to=${encodeURIComponent('/watch/x?playlist=y&src=playlist')}`,
      );

      // Perform login
      fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
        target: { value: 'test@winkey.vn' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'password123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/watch/x?playlist=y&src=playlist');
      });
    });

    it('falls back to "/" when return_to is "//evil.com"', async () => {
      mockSearchParams = new URLSearchParams({
        return_to: '//evil.com',
      });

      render(<LoginPage />);

      const googleLink = screen.getByRole('link', { name: /Google/i });
      expect(googleLink.getAttribute('href')).toBe('/v1/auth/oauth/google?return_to=%2F');

      fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
        target: { value: 'test@winkey.vn' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'password123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });

    it('falls back to "/" when return_to is "/\\evil.com"', async () => {
      mockSearchParams = new URLSearchParams({
        return_to: '/\\evil.com',
      });

      render(<LoginPage />);

      const googleLink = screen.getByRole('link', { name: /Google/i });
      expect(googleLink.getAttribute('href')).toBe('/v1/auth/oauth/google?return_to=%2F');

      fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
        target: { value: 'test@winkey.vn' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'password123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });

    it('falls back to "/" when return_to is "https://evil.com"', async () => {
      mockSearchParams = new URLSearchParams({
        return_to: 'https://evil.com',
      });

      render(<LoginPage />);

      const googleLink = screen.getByRole('link', { name: /Google/i });
      expect(googleLink.getAttribute('href')).toBe('/v1/auth/oauth/google?return_to=%2F');

      fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
        target: { value: 'test@winkey.vn' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'password123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });

    it('falls back to "/" when return_to is empty string ""', async () => {
      mockSearchParams = new URLSearchParams({
        return_to: '',
      });

      render(<LoginPage />);

      const googleLink = screen.getByRole('link', { name: /Google/i });
      expect(googleLink.getAttribute('href')).toBe('/v1/auth/oauth/google?return_to=%2F');

      fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
        target: { value: 'test@winkey.vn' },
      });
      fireEvent.change(screen.getByPlaceholderText('••••••••'), {
        target: { value: 'password123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });
  });
});
