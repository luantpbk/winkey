import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({
  value: {
    user: null,
    isAuthenticated: false,
    isLoading: true,
    logout: () => {},
    can: { upload: false, studio: false, moderate: false, requestCreator: false },
  },
}));
vi.mock('../src/lib/auth/auth-context', () => ({ useAuth: () => auth.value }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => `t:${key}` }));
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/',
}));
vi.mock('../src/lib/feedback', () => ({ useFeedbackUrl: () => null }));
vi.mock('../src/components/notifications/notification-bell', () => ({
  NotificationBell: () => null,
}));
vi.mock('../src/components/chat/chat-badge-button', () => ({ ChatBadgeButton: () => null }));

import { TopBar } from '../src/components/layout/top-bar';
import { Sidebar } from '../src/components/layout/sidebar';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

const setSessionCookie = (on: boolean) => {
  document.cookie = on ? 'wk_has_session=1; path=/' : 'wk_has_session=; path=/; max-age=0';
};

describe('TopBar (#553)', () => {
  beforeEach(() => setSessionCookie(false));
  afterEach(() => {
    setSessionCookie(false);
    document.body.innerHTML = '';
  });

  it('hydrates without a mismatch when the browser has a session cookie the server cannot see', async () => {
    // What the server sends: it has no document, so no session indicator.
    const html = renderToString(<TopBar onToggleSidebar={() => {}} />);
    expect(html).toContain('/login');

    setSessionCookie(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = html;
    const recoverable = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <TopBar onToggleSidebar={() => {}} />, {
        onRecoverableError: recoverable,
      });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();

    // After hydration the skeleton replaces the sign-in link, as before.
    expect(container.querySelector('a[href="/login"]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"] .animate-pulse')).not.toBeNull();
  });

  it('Sidebar hydrates without a mismatch too, then shows the member links', async () => {
    const sidebar = <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={() => {}} />;
    const html = renderToString(sidebar);
    expect(html).not.toContain('/tin-nhan');

    setSessionCookie(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = html;
    const recoverable = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, sidebar, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    expect(container.querySelector('a[href="/tin-nhan"]')).not.toBeNull();
  });

  it('shows the sign-in link when there is no session cookie', () => {
    render(<TopBar onToggleSidebar={() => {}} />);
    expect(document.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it('names the header buttons from the messages', () => {
    render(<TopBar onToggleSidebar={() => {}} />);
    expect(screen.getByRole('button', { name: 't:toggleMenu' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 't:search' })).toBeTruthy();
    expect(viMessages.nav.toggleMenu).toBe('Mở hoặc đóng menu điều hướng');
    expect(viMessages.nav.search).toBe('Tìm kiếm');
    expect(enMessages.nav.toggleMenu).toBe('Toggle navigation menu');
    expect(enMessages.nav.search).toBe('Search');
  });
});
