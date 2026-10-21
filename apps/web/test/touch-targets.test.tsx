import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TopBar } from '../src/components/layout/top-bar';
import { CinemaHero } from '../src/components/cinema/cinema-hero';
import { CinemaCard } from '../src/components/cinema/cinema-card';
import { CinemaSeriesCard } from '../src/components/cinema/cinema-series-card';
import { CinemaShell } from '../src/components/layout/cinema-shell';

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
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, className, ...props }: any) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
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

vi.mock('../src/components/notifications/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

describe('UX1 Issue #397: Touch Targets >= 44x44px (ADR-044)', () => {
  it('TopBar interactive controls meet minimum 44x44px touch targets', () => {
    render(<TopBar onToggleSidebar={vi.fn()} />);

    // Sidebar toggle button
    const sidebarBtn = screen.getByTestId('sidebar-toggle-btn');
    expect(sidebarBtn.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(sidebarBtn.className).toMatch(/min-h-11|min-h-\[44px\]/);

    // Brand logo link
    const logoLink = screen.getByLabelText('Winkey – Trang chủ');
    expect(logoLink.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(logoLink.className).toMatch(/min-w-11|min-w-\[44px\]/);

    // Theme toggle button
    const themeBtn = screen.getByRole('button', { name: /mode/i });
    expect(themeBtn.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(themeBtn.className).toMatch(/min-h-11|min-h-\[44px\]/);
  });

  it('CinemaHero carousel indicator dots have >= 44x44px hitbox', () => {
    const mockVideos: any[] = [
      {
        id: 'vid-1',
        title: 'Video 1',
        duration_seconds: 120,
        published_at: new Date().toISOString(),
        visibility: 'public',
        view_count: 100,
        thumbnail_url: 'https://example.com/thumb1.jpg',
        owner: {
          id: 'u-1',
          display_name: 'Channel One',
          handle: 'channel-one',
          avatar_url: null,
        },
      },
      {
        id: 'vid-2',
        title: 'Video 2',
        duration_seconds: 180,
        published_at: new Date().toISOString(),
        visibility: 'public',
        view_count: 200,
        thumbnail_url: 'https://example.com/thumb2.jpg',
        owner: {
          id: 'u-2',
          display_name: 'Channel Two',
          handle: 'channel-two',
          avatar_url: null,
        },
      },
    ];

    render(<CinemaHero initialVideos={mockVideos} onOpenDetail={vi.fn()} />);

    const dot0 = screen.getByTestId('cinema-hero-dot-0');
    const dot1 = screen.getByTestId('cinema-hero-dot-1');

    expect(dot0.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(dot0.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(dot1.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(dot1.className).toMatch(/min-h-11|min-h-\[44px\]/);
  });

  it('CinemaCard and CinemaSeriesCard quick buttons have >= 44x44px hitboxes', () => {
    vi.useFakeTimers();
    window.innerWidth = 1024;

    const mockVideo: any = {
      id: 'vid-card-1',
      title: 'Card Video 1',
      duration_seconds: 90,
      published_at: new Date().toISOString(),
      visibility: 'PUBLIC',
      view_count: 50,
      thumbnail_url: 'https://example.com/thumb.jpg',
      owner: {
        id: 'u-1',
        display_name: 'Channel One',
        handle: 'channel-one',
        avatar_url: null,
      },
    };

    const mockSeries: any = {
      playlist_id: 'series-card-1',
      title: 'Card Series 1',
      description: '',
      owner: {
        id: 'u-1',
        handle: 'channel-one',
        display_name: 'Channel One',
        avatar_url: null,
      },
      episode_count: 5,
      first_video_id: 'vid-1',
      updated_at: new Date().toISOString(),
    };

    render(
      <>
        <CinemaCard video={mockVideo} surface="other" onOpenDetail={vi.fn()} />
        <CinemaSeriesCard series={mockSeries} onOpenSeries={vi.fn()} />
      </>,
    );

    // Hover cards to trigger 300ms delay for desktop quick buttons overlay
    fireEvent.mouseEnter(screen.getByTestId('cinema-card'));
    fireEvent.mouseEnter(screen.getByTestId('cinema-series-card'));
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // CinemaCard buttons
    const cardWatch = screen.getByTestId('cinema-card-quick-watch');
    const cardWatchLater = screen.getByTestId('cinema-card-quick-watch-later');
    const cardDetails = screen.getByTestId('cinema-card-quick-details');

    expect(cardWatch.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(cardWatch.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(cardWatchLater.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(cardWatchLater.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(cardDetails.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(cardDetails.className).toMatch(/min-h-11|min-h-\[44px\]/);

    // CinemaSeriesCard buttons
    const seriesWatch = screen.getByTestId('cinema-series-quick-watch');
    const seriesWatchLater = screen.getByTestId('cinema-series-quick-watch-later');
    const seriesDetails = screen.getByTestId('cinema-series-quick-details');

    expect(seriesWatch.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(seriesWatch.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(seriesWatchLater.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(seriesWatchLater.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(seriesDetails.className).toMatch(/min-w-11|min-w-\[44px\]/);
    expect(seriesDetails.className).toMatch(/min-h-11|min-h-\[44px\]/);

    vi.useRealTimers();
  });

  it('CinemaShell mobile logo, chips and search meet >= 44x44px touch targets', () => {
    render(
      <CinemaShell>
        <div>Content</div>
      </CinemaShell>,
    );

    // Mobile header
    const mobileHeader = screen.getByTestId('cinema-mobile-topbar');
    const mobileLogo = mobileHeader.querySelector('a');
    expect(mobileLogo?.className).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(mobileLogo?.className).toMatch(/min-w-11|min-w-\[44px\]/);

    // Quick chips nav
    const chipsNav = screen.getByRole('navigation', { name: 'Lọc nhanh' });
    const chipLinks = chipsNav.querySelectorAll('a');
    expect(chipLinks.length).toBeGreaterThan(0);
    chipLinks.forEach((link) => {
      expect(link.className).toMatch(/min-h-11|min-h-\[44px\]/);
      expect(link.className).toMatch(/min-w-11|min-w-\[44px\]/);
    });
  });
});
