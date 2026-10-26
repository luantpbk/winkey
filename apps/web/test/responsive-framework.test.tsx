import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BottomNav } from '../src/components/layout/bottom-nav';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      home: 'Trang chủ',
      explore: 'Khám phá',
      history: 'Lịch sử xem',
      library: 'Thư viện',
    };
    return map[key] || key;
  },
}));

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  usePathname: () => '/kham-pha',
}));

describe('UX1 Responsive Framework: BottomNav and Breakpoint Tokens (ADR-044)', () => {
  it('renders mobile bottom navigation with touch targets >= 44x44px', () => {
    render(<BottomNav />);

    const nav = screen.getByTestId('mobile-bottom-nav');
    expect(nav).toBeDefined();
    expect(nav.className).toContain('md:hidden');
    expect(nav.className).toContain('fixed');
    expect(nav.className).toContain('bottom-0');

    // All links in bottom nav must have min-h-11 min-w-11 (>= 44x44px)
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);

    for (const link of links) {
      expect(link.className).toContain('min-h-11');
      expect(link.className).toContain('min-w-11');
    }
  });

  it('highlights the active route on mobile bottom navigation', () => {
    render(<BottomNav />);

    const exploreLink = screen.getByRole('link', { name: /Khám phá/i });
    expect(exploreLink).toBeDefined();
    // Active class uses brand color #d9002b
    expect(exploreLink.className).toContain('text-[#d9002b]');
  });
});
