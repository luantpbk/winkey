import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../src/app/api/feedback-url/route';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CinemaShell } from '../src/components/layout/cinema-shell';
import { Sidebar } from '../src/components/layout/sidebar';
import viMessages from '../messages/vi.json';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

// --- next-intl and routing mocks ---
vi.mock('next-intl', () => ({
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
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    canAccessAdmin: false,
    logout: vi.fn(),
  }),
}));

describe('Runtime FEEDBACK_URL (Same Build Artifact Verification)', () => {
  const originalEnv = process.env.FEEDBACK_URL;

  beforeEach(() => {
    delete process.env.FEEDBACK_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FEEDBACK_URL = originalEnv;
    } else {
      delete process.env.FEEDBACK_URL;
    }
    vi.restoreAllMocks();
  });

  describe('1. Server Route Handler (/api/feedback-url)', () => {
    it('returns null when FEEDBACK_URL is unset or empty', async () => {
      delete process.env.FEEDBACK_URL;
      const res1 = await GET();
      const data1 = await res1.json();
      expect(data1).toEqual({ feedbackUrl: null });

      process.env.FEEDBACK_URL = '   ';
      const res2 = await GET();
      const data2 = await res2.json();
      expect(data2).toEqual({ feedbackUrl: null });
    });

    it('returns sanitized https: URL', async () => {
      process.env.FEEDBACK_URL = 'https://survey.winkey.vn/beta-v1';
      const res = await GET();
      const data = await res.json();
      expect(data).toEqual({ feedbackUrl: 'https://survey.winkey.vn/beta-v1' });
    });

    it('returns sanitized mailto: URL', async () => {
      process.env.FEEDBACK_URL = 'mailto:beta@winkey.vn?subject=Feedback';
      const res = await GET();
      const data = await res.json();
      expect(data).toEqual({ feedbackUrl: 'mailto:beta@winkey.vn?subject=Feedback' });
    });

    it('returns null for unsafe protocols (http, javascript, fragment, relative)', async () => {
      const unsafe = [
        'http://insecure.winkey.vn/feedback',
        'javascript:alert("pwned")',
        '#feedback',
        '/feedback',
        'ftp://files.winkey.vn',
      ];
      for (const url of unsafe) {
        process.env.FEEDBACK_URL = url;
        const res = await GET();
        const data = await res.json();
        expect(data).toEqual({ feedbackUrl: null });
      }
    });

    it('updates dynamically on runtime env change on the EXACT same handler without rebuilding', async () => {
      process.env.FEEDBACK_URL = 'https://initial.example.com/survey';
      const resA = await GET();
      const dataA = await resA.json();
      expect(dataA.feedbackUrl).toBe('https://initial.example.com/survey');

      // Change env dynamically (simulating container restart with new FEEDBACK_URL env)
      process.env.FEEDBACK_URL = 'mailto:changed@example.com';
      const resB = await GET();
      const dataB = await resB.json();
      expect(dataB.feedbackUrl).toBe('mailto:changed@example.com');

      // Change to empty -> immediately null
      delete process.env.FEEDBACK_URL;
      const resC = await GET();
      const dataC = await resC.json();
      expect(dataC.feedbackUrl).toBeNull();
    });
  });

  describe('2. Component Integration with Dynamic Runtime Fetch', () => {
    it('CinemaShell dynamically fetches and reflects runtime FEEDBACK_URL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ feedbackUrl: 'https://runtime-survey.example.com' }),
      } as Response);

      render(
        <CinemaShell>
          <div>Cinema Body</div>
        </CinemaShell>,
        { wrapper: createWrapper() },
      );

      // Initially null or waiting, then populates when fetch resolves
      await waitFor(() => {
        const link = screen.getByRole('link', { name: /Góp ý beta/i });
        expect(link).not.toBeNull();
        expect(link.getAttribute('href')).toBe('https://runtime-survey.example.com');
      });
    });

    it('Sidebar dynamically fetches and reflects runtime FEEDBACK_URL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ feedbackUrl: 'mailto:runtime-help@winkey.vn' }),
      } as Response);

      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      await waitFor(() => {
        const sidebarFooter = screen.getByTestId('sidebar-footer');
        const link = sidebarFooter.querySelector('a[href="mailto:runtime-help@winkey.vn"]');
        expect(link).not.toBeNull();
      });
    });

    it('CinemaShell stays clean when runtime FEEDBACK_URL is null', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ feedbackUrl: null }),
      } as Response);

      render(
        <CinemaShell>
          <div>Cinema Body</div>
        </CinemaShell>,
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(screen.queryByRole('link', { name: /Góp ý beta/i })).toBeNull();
      });
    });
  });
});
