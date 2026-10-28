import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../src/components/layout/sidebar';
import { BottomNav } from '../src/components/layout/bottom-nav';
import { CinemaShell } from '../src/components/layout/cinema-shell';
import viMessages from '../messages/vi.json';

let currentPathname = '/';

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  routing: {
    locales: ['vi', 'en'],
    defaultLocale: 'vi',
    localePrefix: 'as-needed',
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => currentPathname,
  Link: ({ children, href, className, ...props }: any) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// Mock translations using actual vi messages
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: any = viMessages;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = cur[p];
        } else {
          return key;
        }
      }
      return typeof cur === 'string' ? cur : key;
    };
  },
}));

// Mock Auth
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    can: { upload: false, studio: false, moderate: false, admin: false },
  }),
}));

// Mock Toast & feedback
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock('../src/lib/feedback', () => ({
  useFeedbackUrl: () => null,
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithClient(ui: React.ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('SOC-2a Feed Navigation Links', () => {
  beforeEach(() => {
    currentPathname = '/';
    vi.clearAllMocks();
  });

  describe('Sidebar Navigation', () => {
    it('renders "Bảng tin" link directly after "Trang chủ" with href="/bang-tin"', () => {
      renderWithClient(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      const links = screen.getAllByRole('link');
      const homeIndex = links.findIndex((l) => l.getAttribute('href') === '/');
      const feedIndex = links.findIndex((l) => l.getAttribute('href') === '/bang-tin');

      expect(homeIndex).toBeGreaterThanOrEqual(0);
      expect(feedIndex).toBe(homeIndex + 1);

      const feedLink = links[feedIndex];
      expect(feedLink.textContent).toContain('Bảng tin');
    });

    it('marks "Bảng tin" as active on /bang-tin, /bai-viet/:id, and /hashtag/:tag', () => {
      // Test /bang-tin
      currentPathname = '/bang-tin';
      const { unmount: unmount1 } = renderWithClient(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />,
      );
      let feedLink = screen
        .getAllByRole('link')
        .find((l) => l.getAttribute('href') === '/bang-tin')!;
      expect(feedLink.className).toContain('text-red-500');
      unmount1();

      // Test /bai-viet/123
      currentPathname = '/bai-viet/123';
      const { unmount: unmount2 } = renderWithClient(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />,
      );
      feedLink = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/bang-tin')!;
      expect(feedLink.className).toContain('text-red-500');
      unmount2();

      // Test /hashtag/cong-nghe
      currentPathname = '/hashtag/cong-nghe';
      const { unmount: unmount3 } = renderWithClient(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />,
      );
      feedLink = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/bang-tin')!;
      expect(feedLink.className).toContain('text-red-500');
      unmount3();

      // Test home page: feed should not be active
      currentPathname = '/';
      renderWithClient(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);
      feedLink = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/bang-tin')!;
      expect(feedLink.className).not.toContain('text-red-500');
    });
  });

  describe('BottomNav (Mobile)', () => {
    it('renders 5 items including "Bảng tin" with href="/bang-tin"', () => {
      renderWithClient(<BottomNav />);
      const nav = screen.getByTestId('mobile-bottom-nav');
      const links = nav.querySelectorAll('a');

      expect(links.length).toBe(5);
      const hrefs = Array.from(links).map((l) => l.getAttribute('href'));
      expect(hrefs).toEqual(['/', '/bang-tin', '/kham-pha', '/lich-su', '/thu-vien']);

      const feedLink = Array.from(links).find((l) => l.getAttribute('href') === '/bang-tin')!;
      expect(feedLink.textContent).toContain('Bảng tin');
    });

    it('marks "Bảng tin" active on /bang-tin, /bai-viet/xyz, and /hashtag/abc', () => {
      currentPathname = '/bang-tin';
      const { unmount: unmount1 } = renderWithClient(<BottomNav />);
      let feedLink = screen.getByTestId('mobile-bottom-nav').querySelector('a[href="/bang-tin"]')!;
      expect(feedLink.className).toContain('text-[#d9002b]');
      unmount1();

      currentPathname = '/bai-viet/post-uuid';
      const { unmount: unmount2 } = renderWithClient(<BottomNav />);
      feedLink = screen.getByTestId('mobile-bottom-nav').querySelector('a[href="/bang-tin"]')!;
      expect(feedLink.className).toContain('text-[#d9002b]');
      unmount2();

      currentPathname = '/hashtag/winkey';
      const { unmount: unmount3 } = renderWithClient(<BottomNav />);
      feedLink = screen.getByTestId('mobile-bottom-nav').querySelector('a[href="/bang-tin"]')!;
      expect(feedLink.className).toContain('text-[#d9002b]');
      unmount3();

      currentPathname = '/kham-pha';
      renderWithClient(<BottomNav />);
      feedLink = screen.getByTestId('mobile-bottom-nav').querySelector('a[href="/bang-tin"]')!;
      expect(feedLink.className).not.toContain('text-[#d9002b]');
    });
  });

  describe('CinemaShell Navigation', () => {
    it('renders "Bảng tin" link in header, mobile chips, and mobile bottom tab', () => {
      renderWithClient(
        <CinemaShell>
          <div>Cinema content</div>
        </CinemaShell>,
      );

      const feedLinks = screen
        .getAllByRole('link')
        .filter((l) => l.getAttribute('href') === '/bang-tin');

      // Desktop header link, Mobile filter chips link, Mobile bottom bar link
      expect(feedLinks.length).toBe(3);
      feedLinks.forEach((link) => {
        expect(link.textContent).toContain('Bảng tin');
      });
    });

    it('marks "Bảng tin" links as active on feed and post routes', () => {
      currentPathname = '/bang-tin';
      renderWithClient(
        <CinemaShell>
          <div>Cinema content</div>
        </CinemaShell>,
      );

      const feedLinks = screen
        .getAllByRole('link')
        .filter((l) => l.getAttribute('href') === '/bang-tin');

      expect(feedLinks.length).toBe(3);
      feedLinks.forEach((link) => {
        expect(link.getAttribute('aria-current')).toBe('page');
      });
    });
  });
});
