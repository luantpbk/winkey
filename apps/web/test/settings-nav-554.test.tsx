import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';
import middleware from '../src/middleware';

const pathname = vi.hoisted(() => ({ current: '/cai-dat/tai-khoan' }));
vi.mock('../src/i18n/routing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePathname: () => pathname.current,
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl', async (importOriginal) => {
  const vi_ = (await import('../messages/vi.json')).default as unknown as {
    settings: { tabs: Record<string, string> };
  };
  return {
    ...(await importOriginal<object>()),
    useTranslations: () => (key: string) => vi_.settings.tabs[key] ?? key,
  };
});

import SettingsLayout from '../src/app/[locale]/cai-dat/layout';
import robots from '../src/app/robots';

const visit = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

describe('settings area (#554)', () => {
  it.each([
    ['/settings/account', 'http://localhost:3000/cai-dat/tai-khoan'],
    ['/settings/account/', 'http://localhost:3000/cai-dat/tai-khoan'],
    ['/settings', 'http://localhost:3000/cai-dat/tai-khoan'],
    ['/cai-dat', 'http://localhost:3000/cai-dat/tai-khoan'],
    ['/en/settings/account', 'http://localhost:3000/en/cai-dat/tai-khoan'],
    ['/settings/account?from=mail', 'http://localhost:3000/cai-dat/tai-khoan?from=mail'],
  ])('%s moves permanently to the Vietnamese URL', (from, to) => {
    const res = visit(from);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(to);
  });

  it('serves the new URLs without a redirect', () => {
    for (const path of ['/cai-dat/tai-khoan', '/cai-dat/bao-mat']) {
      expect(visit(path).headers.get('location')).toBeNull();
    }
  });

  it('shows one tab bar, marking the current page', () => {
    pathname.current = '/cai-dat/bao-mat';
    render(
      <SettingsLayout>
        <p>nội dung</p>
      </SettingsLayout>,
    );
    const nav = screen.getByRole('navigation', { name: 'Cài đặt' });
    expect(nav).toBeTruthy();
    const account = screen.getByRole('link', { name: 'Tài khoản' });
    const security = screen.getByRole('link', { name: 'Bảo mật' });
    expect(account.getAttribute('href')).toBe('/cai-dat/tai-khoan');
    expect(account.getAttribute('aria-current')).toBeNull();
    expect(security.getAttribute('href')).toBe('/cai-dat/bao-mat');
    expect(security.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('nội dung')).toBeTruthy();
  });

  it('keeps search engines out of the settings area', () => {
    const rules = robots().rules;
    const disallow = (Array.isArray(rules) ? rules[0] : rules)?.disallow;
    expect(disallow).toContain('/cai-dat');
    expect(disallow).toContain('/settings');
  });
});
