import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBar } from '../src/components/layout/top-bar';
import { CinemaHero } from '../src/components/cinema/cinema-hero';
import { StudioNav } from '../src/components/studio/studio-nav';
import { Sidebar } from '../src/components/layout/sidebar';
import { A11Y_COLORS } from '../src/lib/a11y-tokens';
import LocaleNotFound from '../src/app/[locale]/not-found';
import RootNotFound from '../src/app/not-found';

beforeAll(() => {
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock routing Link
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, href, className, ...props }: any) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/studio',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock auth context
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    logout: vi.fn(),
    canAccessAdmin: false,
  }),
}));

// Mock theme provider
vi.mock('../src/components/theme-provider', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

describe('UX1 Issue #398: WCAG 2.1 AA Accessibility Fixes (ADR-044)', () => {
  it('CinemaHero TOP badge uses WCAG AA-compliant contrast background (#D9002B)', () => {
    const mockVideos: any[] = [
      {
        id: 'vid-1',
        title: 'Video 1',
        duration_seconds: 120,
        published_at: new Date().toISOString(),
        visibility: 'public',
        view_count: 100,
        thumbnail_url: 'https://example.com/thumb.jpg',
        owner: {
          id: 'u-1',
          display_name: 'Channel One',
          handle: 'channel-one',
          avatar_url: null,
        },
      },
    ];

    render(<CinemaHero initialVideos={mockVideos} onOpenDetail={vi.fn()} />);

    const badge = screen.getByText(/TOP 1/);
    expect(badge.className).toContain('bg-[#D9002B]');
    expect(badge.className).toContain('text-white');
    // Ensure former low-contrast color is removed
    expect(badge.className).not.toContain('bg-[#FF0033]');
  });

  it('TopBar brand logo link accessible name matches visible text (no label mismatch)', () => {
    render(<TopBar onToggleSidebar={vi.fn()} />);

    // Logo link accessible name comes from visible text "Winkey VN" without mismatched aria-label
    const logoLink = screen.getByRole('link', { name: /Winkey/i });
    expect(logoLink).toBeDefined();
    expect(logoLink.getAttribute('aria-label')).toBeNull();
  });

  it('StudioNav inactive tabs use accessible contrast text', () => {
    render(<StudioNav />);

    const analyticsTab = screen.getByTestId('studio-nav-analytics');
    expect(analyticsTab.className).toContain('dark:text-zinc-400');
    // Must not use low-contrast text-gray-500 on dark background
    expect(analyticsTab.className).not.toContain('text-gray-500');
  });

  it('Sidebar footer secondary text uses accessible contrast (dark:text-zinc-400)', () => {
    render(<Sidebar collapsed={false} mobileOpen={true} onCloseMobile={vi.fn()} />);

    const footer = screen.getByTestId('sidebar-footer');
    const copyright = footer.querySelector('p');
    expect(copyright?.className).toContain('dark:text-zinc-400');
    expect(copyright?.className).not.toContain('dark:text-gray-500');
  });
});

describe('UX1 Issue #428: WCAG 2.1 AA Contrast and 404 Localized Documents', () => {
  it('A11Y_COLORS tokens enforce WCAG 2.1 AA compliant colors', () => {
    expect(A11Y_COLORS.brandSolidBg).toContain('#D9002B');
    expect(A11Y_COLORS.brandText).toContain('text-[#C80026]');
    expect(A11Y_COLORS.brandText).toContain('dark:text-[#FF4D6D]');
    expect(A11Y_COLORS.textMuted).toContain('dark:text-zinc-400');
    expect(A11Y_COLORS.textSecondary).toContain('dark:text-zinc-300');
  });

  it('LocaleNotFound renders localized 404 document with A11Y_COLORS and >=44px touch target', () => {
    render(<LocaleNotFound />);
    const main = screen.getByTestId('locale-not-found');
    expect(main).toBeDefined();
    expect(screen.getByText('Lỗi 404')).toBeDefined();
    expect(screen.getByText('Không tìm thấy trang')).toBeDefined();

    const homeLink = screen.getByRole('link', { name: /Về trang chủ/i });
    expect(homeLink.className).toContain('min-h-11');
    expect(homeLink.className).toContain('min-w-11');
    expect(homeLink.className).toContain('bg-[#D9002B]');
  });

  it('RootNotFound renders root 404 document with lang="vi" and accessible home link', () => {
    const htmlString = renderToStaticMarkup(<RootNotFound />);
    expect(htmlString).toContain('<html lang="vi"');
    expect(htmlString).toContain('class="dark"');
    expect(htmlString).toContain('Lỗi 404');
    expect(htmlString).toContain('Không tìm thấy trang');
    expect(htmlString).toContain('min-h-11');
    expect(htmlString).toContain('bg-[#D9002B]');
  });
});
