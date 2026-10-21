import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBar } from '../src/components/layout/top-bar';
import { CinemaHero } from '../src/components/cinema/cinema-hero';
import { StudioNav } from '../src/components/studio/studio-nav';
import { Sidebar } from '../src/components/layout/sidebar';

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
